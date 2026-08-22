import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';
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
 *
 * The layout components below are registered for the same reason: a warning
 * written as a bold sentence inside a bullet list is indistinguishable from the
 * facts around it, and per-OS instructions stacked as consecutive code blocks
 * make the reader scan for their own platform. `Callout` arrives with
 * `defaultMdxComponents`; the rest have to be named here to be usable in MDX.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    File,
    Files,
    Folder,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
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
