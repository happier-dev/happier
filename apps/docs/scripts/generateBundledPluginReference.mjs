/**
 * Renders what Happier ships in the box, from the plugins' own projected
 * manifests.
 *
 * This page exists because "source control is a plugin now" is the single
 * hardest thing to believe about this line of the codebase, and the only
 * convincing answer is the list. Forty-three plugins ship bundled: every coding
 * agent, every model provider, every voice engine, both version-control
 * backends and all four hosting forges.
 *
 * The source is `.happier-plugin/plugin.json` — the *projected* manifest that
 * pack writes, which is also what the daemon reads to build catalogs without
 * executing plugin code. Reading the same artifact means this page cannot
 * describe a plugin differently from the way the host discovers it.
 *
 * The id set is cross-checked against the bundled registry the CLI compiles in.
 * A plugin whose manifest is on disk but which nothing bundles is not shipped,
 * and a bundled id with no manifest is a broken build; either way the reader
 * would be told something false, so both throw here instead.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const PLUGINS_DIR = join(REPO, 'packages', 'plugins');
const REGISTRY = join(
  REPO, 'apps', 'cli', 'src', 'plugins', 'projection', 'registry', 'sources', 'generatedBundledPluginManifests.ts',
);
export const BUNDLED_PLUGIN_REGISTRY_PATH = REGISTRY;
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
];

/** Everything that is not part of a family. Named explicitly so a new one fails the build. */
const STANDALONE = {
  title: 'Everything else',
  blurb: 'Single-purpose plugins that do not belong to a family.',
  ids: ['happier.channels', 'happier.triage', 'happier.inspector', 'happier.posthog', 'happier.sentry'],
};

export function readBundledPluginIds(source) {
  const ids = [...source.matchAll(/"pluginId":\s*"([^"]+)"/g)].map((m) => m[1]);
  if (ids.length === 0) throw new Error('bundled plugin registry parsed to zero ids');
  return new Set(ids);
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

function readPlugins() {
  const plugins = [];
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('_')) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(PLUGINS_DIR, entry.name, '.happier-plugin', 'plugin.json'), 'utf8'));
    } catch {
      continue; // not built in this checkout
    }
    plugins.push({
      id: manifest.id,
      name: manifest.displayName ?? manifest.id,
      description: (manifest.description ?? '').trim(),
      families: contributedFamilies(manifest.contributes),
      dir: entry.name,
    });
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name));
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
of how this version is built: the coding agents, the model providers, the voice
engines, both version-control backends and all four hosting forges are plugins,
loaded through the same manifest, trust and activation path your own plugin
would use.

They are not a privileged tier. A bundled plugin declares its contributions in a
manifest, gets projected into catalogs without its code being executed, and
activates the same way. Reading one is the most useful thing you can do before
writing your own.

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
  return renderBundledPluginMarkdown({
    plugins: readPlugins(),
    bundledIds: readBundledPluginIds(readFileSync(REGISTRY, 'utf8')),
  });
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderBundledPluginReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
