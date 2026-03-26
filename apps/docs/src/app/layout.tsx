import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import localFont from 'next/font/local';

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
