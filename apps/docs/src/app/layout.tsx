import { RootProvider } from 'fumadocs-ui/provider/next';
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

const inter = localFont({
  src: [
    {
      path: '../../../ui/sources/assets/fonts/Inter-Regular.ttf',
      style: 'normal',
      weight: '400',
    },
    {
      path: '../../../ui/sources/assets/fonts/Inter-Italic.ttf',
      style: 'italic',
      weight: '400',
    },
    {
      path: '../../../ui/sources/assets/fonts/Inter-SemiBold.ttf',
      style: 'normal',
      weight: '600',
    },
  ],
  display: 'swap',
});

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
