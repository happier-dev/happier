import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * NOTE: this is the CONTENT of the nav title, not a link.
 *
 * fumadocs wraps whatever `nav.title` returns in its own `<Link href={nav.url}>`.
 * Wrapping it again in an `<a>` nests an anchor inside a Next `<Link>`, which
 * Next 13+ rejects outright — "Invalid <Link> with <a> child". The production
 * build does not catch it because the check runs at render time, so it only
 * surfaces when someone opens the dev server.
 *
 * Both PNGs ship and CSS picks one, so the swap costs no JavaScript and cannot
 * flash the wrong mark during hydration. The hidden one is `display: none`, so
 * only the visible mark's alt text reaches the accessibility tree — which is
 * what names the wrapping link.
 */
const navTitle = (
  <span className="flex items-center gap-2">
    <img
      src="/brand/logotype-dark.png"
      alt="Happier"
      width={120}
      height={28}
      className="h-6 w-auto dark:hidden"
    />
    <img
      src="/brand/logotype-light.png"
      alt="Happier"
      width={120}
      height={28}
      className="hidden h-6 w-auto dark:block"
    />
    <span className="text-fd-muted-foreground text-sm font-medium">Docs</span>
  </span>
);

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: navTitle,
    },
  };
}
