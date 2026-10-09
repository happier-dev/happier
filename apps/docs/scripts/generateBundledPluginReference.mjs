/**
 * Renders what Happier ships in the box, from the plugins' own projected
 * manifests.
 *
 * This page exists because "source control is a plugin now" is the single
 * hardest thing to believe about this line of the codebase, and the only
 * convincing answer is the list. Dozens of plugins ship bundled: every coding
 * agent, every model provider, every voice engine, both version-control
 * backends and all four hosting forges.
 *
 * The CLI's admitted source registry contains both bundled membership and the
 * normalized cold manifests. Use it directly so ordinary source publication
 * and documentation share one authority without requiring packed artifacts.
 * Metadata and locator ids are cross-checked before rendering.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const REGISTRY = join(
  REPO, 'apps', 'cli', 'src', 'plugins', 'projection', 'registry', 'sources', 'generatedBundledPluginManifests.ts',
);
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'plugins', 'bundled.mdx');

/**
 * Categories are matched in order, so `happier.scm.forge.` has to be tested
 * before `happier.scm.` would be. Longest-prefix-first is the invariant; the
 * guard below catches an id that matches nothing rather than letting it drop
 * silently out of the page.
 */
const CATEGORIES = [
  {
    prefix: 'happier.agent.',
    title: 'Coding agents',
    blurb: 'One plugin per agent. This is why adding an agent no longer means changing Happier itself.',
  },
  {
    prefix: 'happier.review.',
    title: 'Review agents',
    blurb: 'Review CLIs rather than general coding agents — no model choice, no resume.',
  },
  {
    prefix: 'happier.provider.',
    title: 'Model providers',
    blurb: 'Model sources that compatible agents can draw from, configured under **Settings → Providers**.',
  },
  {
    prefix: 'happier.voice.',
    title: 'Voice engines',
    blurb: 'Speech-to-text and text-to-speech backends behind the voice modes.',
  },
  {
    prefix: 'happier.scm.backend.',
    title: 'Version-control backends',
    blurb: 'The systems Happier can read and write a working copy through.',
  },
  {
    prefix: 'happier.scm.forge.',
    title: 'Hosting providers',
    blurb: 'Pull requests, issues and repository events, per forge.',
  },
  {
    prefix: 'happier.channel.',
    title: 'Conversation channels',
    blurb: 'Places a session can talk to people outside Happier.',
  },
  {
    prefix: 'happier.machine.',
    title: 'Managed machines',
    blurb: 'Machine provisioning plugins in the 0.3 development source.',
  },
];

/** Everything that is not part of a family. Named explicitly so a new one fails the build. */
const STANDALONE = {
  title: 'Everything else',
  blurb: 'Single-purpose plugins that do not belong to a family.',
  ids: ['happier.channels', 'happier.triage', 'happier.inspector', 'happier.posthog', 'happier.sentry'],
};

export async function readBundledPluginRegistry() {
  return await import(pathToFileURL(REGISTRY).href);
}

export function categorize(plugins) {
  const sections = CATEGORIES.map((category) => ({
    ...category,
    plugins: plugins.filter((p) => p.id.startsWith(category.prefix)),
  }));
  const claimed = new Set(sections.flatMap((s) => s.plugins.map((p) => p.id)));
  const standalone = plugins.filter((p) => STANDALONE.ids.includes(p.id));
  for (const p of standalone) claimed.add(p.id);

  const unplaced = plugins.filter((p) => !claimed.has(p.id)).map((p) => p.id);
  if (unplaced.length > 0) {
    throw new Error(
      `bundled plugins in no category: ${unplaced.join(', ')} — add a prefix to CATEGORIES or an id to STANDALONE`,
    );
  }
  const missing = STANDALONE.ids.filter((id) => !plugins.some((p) => p.id === id));
  if (missing.length > 0) {
    throw new Error(`STANDALONE names plugins that are no longer bundled: ${missing.join(', ')}`);
  }
  return [...sections, { ...STANDALONE, plugins: standalone }].filter((s) => s.plugins.length > 0);
}

/** Only the families a plugin actually contributes to — the projected object carries all of them. */
export function contributedFamilies(contributes) {
  return Object.entries(contributes ?? {})
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value && Object.keys(value).length > 0))
    .map(([family]) => family)
    .sort();
}

function readPlugins(locators) {
  return locators.map((entry) => {
    const manifest = entry.manifest;
    return {
      id: manifest.id,
      name: manifest.displayName ?? manifest.id,
      description: (manifest.description ?? '').trim(),
      families: contributedFamilies(manifest.contributes),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

export function renderBundledPluginMarkdown({ plugins, bundledIds }) {
  if (plugins.length === 0) throw new Error('no projected plugin manifests found');

  const onDisk = new Set(plugins.map((p) => p.id));
  const notBundled = [...onDisk].filter((id) => !bundledIds.has(id));
  const notBuilt = [...bundledIds].filter((id) => !onDisk.has(id));
  if (notBundled.length > 0) {
    throw new Error(`plugins have a manifest but are not in the bundled registry: ${notBundled.join(', ')}`);
  }
  if (notBuilt.length > 0) {
    throw new Error(`bundled registry names plugins with no projected manifest: ${notBuilt.join(', ')}`);
  }

  const sections = categorize(plugins);
  const body = sections
    .map((section) => {
      const rows = section.plugins.map((p) => [`**${p.name}**`, `\`${p.id}\``, p.description || '—']);
      return `### ${section.title}\n\n${section.blurb}\n\n${table(['Plugin', 'Id', 'What it does'], rows)}`;
    })
    .join('\n\n');

  const familyCounts = new Map();
  for (const p of plugins) for (const f of p.families) familyCounts.set(f, (familyCounts.get(f) ?? 0) + 1);
  const familyRows = [...familyCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([family, count]) => [`\`${family}\``, String(count)]);

  return `---
title: What ships in the box
description: Every plugin Happier bundles — agents, model providers, voice engines, source control and channels — generated from their projected manifests.
---

Happier bundles ${plugins.length} plugins. That number is the clearest statement
of how this version is built: coding agents, model providers, voice engines,
version-control backends and hosting forges all use the plugin platform.

A bundled plugin declares contributions in the same cold manifest, projects
into catalogs without executing code, and enters the same daemon slot and
contribution owners as another admitted plugin. Its package custody is
different: first-party bundled code loads from the exact CLI version root or a
pinned runner snapshot, never from a managed third-party installation
generation. Reading one is the most useful thing you can do before writing your
own.

## The plugins

${body}

## What they contribute

The contribution families in use across the bundled set, and how many plugins
declare each. A family with one consumer is a family that has been proven once —
useful to know before you build on it.

${table(['Family', 'Plugins'], familyRows)}

## Related

- [Plugin concepts](/plugins/concepts) — the ownership boundaries these follow.
- [Contributions](/plugins/manifest/contributions) — what each family above means.
- [What you can build today](/plugins/manifest/availability) — availability, rather than usage.
- [Coding agents](/agents) — the user-facing side of the agent plugins.
`;
}

export async function renderBundledPluginReferenceMarkdown() {
  const { BUNDLED_FIRST_PARTY_PLUGIN_METADATA: metadata, BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: locators } = await readBundledPluginRegistry();
  return renderBundledPluginMarkdown({
    plugins: readPlugins(locators),
    bundledIds: new Set(metadata.map((entry) => entry.pluginId)),
  });
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderBundledPluginReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
