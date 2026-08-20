import { RootProvider } from 'fumadocs-ui/provider/next';

import { Analytics, AnalyticsNotice } from '../analytics/client';
import './global.css';
import localFont from 'next/font/local';
import type { Metadata } from 'next';
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from '@/lib/site';

/**
 * The root layout had no `metadata` export at all — so no `metadataBase`, so
 * Next resolved the relative `og:image` path returned by `getPageImage()`
 * against `http://localhost:3000` and baked that into all 225 prerendered
 * pages. Setting it here fixes every page at once.
 *
 * The title template puts the site name on every tab and every search result
 * without each page having to remember; `default` covers routes that set no
 * title of their own.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    template: `%s — ${SITE_NAME}`,
    default: SITE_NAME,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    locale: 'en_US',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

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
