import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import Link from 'fumadocs-core/link';
import Image from 'next/image';
import type { ComponentProps } from 'react';
import { BookOpenIcon, DownloadIcon } from 'lucide-react';

import {
  DISCORD_INVITE_URL,
  DOWNLOAD_URL,
  GITHUB_REPO_URL,
  GUIDES_URL,
  WEBSITE_URL,
} from '@/lib/site-links';

function NavTitle(props: ComponentProps<'a'>) {
  const { className, ...rest } = props;
  return (
    <Link
      {...rest}
      aria-label="Happier Docs"
      className={['flex items-center', className].filter(Boolean).join(' ')}
    >
      <Image
        src="/brand/logotype-dark.png"
        alt="Happier"
        width={120}
        height={20}
        className="h-7 w-auto dark:hidden"
        priority
      />
      <Image
        src="/brand/logotype-light.png"
        alt="Happier"
        width={120}
        height={20}
        className="hidden h-7 w-auto dark:block"
        priority
      />
    </Link>
  );
}

/** lucide dropped brand marks, so the Discord glyph is inline. */
function DiscordIcon(props: ComponentProps<'svg'>) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" {...props}>
      <title>Discord</title>
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

/**
 * Where a reader can go next.
 *
 * All 225 pages previously contained zero links to anything outside the docs —
 * no download, no Discord, no guides, no product site. `baseOptions()` returned
 * `{ nav: { title } }` and nothing else, so the navbar had a logo and a search
 * box and that was the whole of it. Someone who read the self-hosting page and
 * decided they wanted the app had no way out except the URL bar.
 *
 * `githubUrl` is a first-class option rather than a `links` entry so fumadocs
 * renders it as the standard icon button and keeps it in the mobile menu.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: NavTitle,
    },
    githubUrl: GITHUB_REPO_URL,
    links: [
      {
        text: 'Guides',
        url: GUIDES_URL,
        icon: <BookOpenIcon />,
        external: true,
        description: 'Task-shaped walkthroughs, on guides.happier.dev',
      },
      {
        text: 'Download',
        url: DOWNLOAD_URL,
        icon: <DownloadIcon />,
        external: true,
        description: 'iOS, Android, macOS, Windows and Linux builds',
      },
      {
        type: 'icon',
        label: 'Happier on Discord',
        text: 'Discord',
        url: DISCORD_INVITE_URL,
        icon: <DiscordIcon />,
        external: true,
      },
    ],
  };
}

const FOOTER_LINKS: ReadonlyArray<{ text: string; url: string }> = [
  { text: 'happier.dev', url: WEBSITE_URL },
  { text: 'Guides', url: GUIDES_URL },
  { text: 'Download', url: DOWNLOAD_URL },
  { text: 'Discord', url: DISCORD_INVITE_URL },
  { text: 'GitHub', url: GITHUB_REPO_URL },
];

/**
 * Sidebar footer. The navbar links vanish behind a hamburger on a phone and sit
 * above the fold on desktop — neither is where someone is when they finish
 * reading. This one sits at the bottom of the sidebar, which is where the eye
 * ends up.
 */
export function DocsSidebarFooter() {
  return (
    <nav aria-label="Happier elsewhere" className="flex flex-wrap gap-x-3 gap-y-1 py-1">
      {FOOTER_LINKS.map((link) => (
        <Link
          key={link.url}
          href={link.url}
          external
          className="text-xs text-fd-muted-foreground transition-colors hover:text-fd-accent-foreground"
        >
          {link.text}
        </Link>
      ))}
    </nav>
  );
}
