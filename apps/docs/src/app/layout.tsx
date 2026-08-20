import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import localFont from 'next/font/local';

import { Analytics, AnalyticsNotice } from '../analytics/client';
import { SITE_NAME, SITE_URL } from '../lib/site';

/**
 * The marketing site's three families, from the site's own variable woff2 files.
 *
 * This replaced three separate Inter TTFs (Regular/Italic/SemiBold, ~1.2 MB
 * together) that carried no display or mono face. One variable file per family
 * covers the whole weight axis, and the three together are ~122 KB — so the
 * docs gained Inter Tight for headings and JetBrains Mono for code while
 * shedding about a megabyte.
 *
 * Exposed as CSS variables and consumed in global.css, so the type stack is
 * declared in one place next to the colour tokens it belongs with.
 */
const inter = localFont({
  src: '../../../website/public/fonts/inter-latin-var.woff2',
  weight: '400 700',
  display: 'swap',
  variable: '--font-inter',
});

const interTight = localFont({
  src: '../../../website/public/fonts/inter-tight-latin-var.woff2',
  weight: '400 800',
  display: 'swap',
  variable: '--font-inter-tight',
});

const jetbrainsMono = localFont({
  src: '../../../website/public/fonts/jetbrains-mono-latin-var.woff2',
  weight: '400 500',
  display: 'swap',
  variable: '--font-jetbrains-mono',
});

/**
 * Resolves every page's root-relative `openGraph.images` against the real
 * origin. Without it Next falls back to `http://localhost:3000` and prerenders
 * that into all 132 pages.
 */
export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: SITE_NAME, template: `%s | ${SITE_NAME}` },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${inter.variable} ${interTight.variable} ${jetbrainsMono.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider theme={{ defaultTheme: 'dark', enableSystem: false }}>
          {children}
        </RootProvider>
        {/* Boots cookieless analytics and records one pageview per route. Both
            render nothing until the client has read the visitor's choice, so
            neither can cause a hydration mismatch. */}
        <Analytics />
        <AnalyticsNotice />
      </body>
    </html>
  );
}
