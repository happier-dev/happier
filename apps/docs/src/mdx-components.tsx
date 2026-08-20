import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Blocks, Boxes, Laptop, Network, Rocket, Ship, Table } from 'lucide-react';

/**
 * The icon set the content is allowed to use, in MDX scope.
 *
 * `<Card icon={<Rocket />}>` needs the component to exist where the MDX is
 * compiled, not where the page is rendered — an icon that is not listed here
 * fails the build rather than rendering blank, which is the behaviour we want.
 * Keep this list short: an index whose every entry has a different icon is a
 * sticker sheet, not a hierarchy.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Blocks,
    Boxes,
    Laptop,
    Network,
    Rocket,
    Ship,
    Table,
    ...components,
  };
}
