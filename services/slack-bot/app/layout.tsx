import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Slack QA Bot",
  description: "Slack Events endpoint per sincronizzare QA su GitHub",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
