import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

/**
 * The real wordmark, not the string "Happier Docs".
 *
 * A docs site that spells its own name in the body font is the clearest signal
 * that it was generated rather than designed — and it is the first thing in the
 * reading order. guides.happier.dev already did this; docs was still on the
 * scaffold default.
 *
 * Both PNGs ship and CSS picks one, so the swap costs no JavaScript and cannot
 * flash the wrong mark during hydration. `Docs` sits beside the mark rather than
 * inside it: the wordmark is the product, this is one surface of it.
 */
const navTitle = (
  <a href="/" aria-label="Happier Docs" className="flex items-center gap-2">
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
  </a>
);

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: navTitle,
    },
  };
}
