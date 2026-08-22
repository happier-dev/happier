/**
 * Renders the feature-flag reference from the protocol catalog and the client
 * registry.
 *
 * The hand-written page documented 3 of 71 flags. That is not a gap anyone
 * could have closed by hand and kept closed: the flags that decide whether
 * session folders, agent goals, action approvals, the pending queue, the
 * unified terminal or account pools exist at all were all missing, and a
 * self-hoster had no way to discover them.
 *
 * Sources:
 *   - `@happier-dev/protocol`'s `FEATURE_CATALOG` — the 71 canonical ids, their
 *     descriptions, whether the server or the client owns them, and their
 *     dependencies. Imported from the built package.
 *   - `apps/ui/.../uiFeatureRegistry.ts` — which of those the app exposes as a
 *     user-facing toggle, and whether it is experimental and on by default.
 *     Parsed from source because the client is not importable from a plain Node
 *     script; `collectUiToggles` asserts it found all 71 ids, so a shape change
 *     fails here rather than silently publishing a short list.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');

const CATALOG_DIST = join(REPO, 'packages', 'protocol', 'dist', 'features', 'catalog.js');
const UI_REGISTRY = join(REPO, 'apps', 'ui', 'sources', 'sync', 'domains', 'features', 'registry', 'uiFeatureRegistry.ts');
const TRANSLATIONS = join(REPO, 'apps', 'ui', 'sources', 'text', 'translations', 'en.ts');
const ENV_SCHEMA = join(REPO, 'apps', 'server', 'sources', 'app', 'features', 'catalog', 'featureEnvSchema.ts');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'extras', 'feature-flags.mdx');

/**
 * Leaf-key lookup into the translations file, with collision detection: if two
 * different nested keys share a leaf name and disagree on the value, the key is
 * dropped rather than guessed at.
 */
export function collectTranslationLeaves(source) {
  const values = new Map();
  const collisions = new Set();
  const LINE = /^\s*'?([A-Za-z0-9_]+)'?\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*,?\s*$/;
  for (const line of source.split('\n')) {
    const match = line.match(LINE);
    if (!match) continue;
    const key = match[1];
    const value = (match[2] ?? match[3]).replace(/\\'/g, "'").replace(/\\"/g, '"');
    if (values.has(key) && values.get(key) !== value) collisions.add(key);
    values.set(key, value);
  }
  for (const key of collisions) values.delete(key);
  return values;
}

/** Per-feature toggle metadata, or `null` where the app exposes no toggle. */
export function collectUiToggles(source, featureIds) {
  const toggles = {};
  const seen = new Set();
  // Entries sit at four-space indent; read each block up to the next one.
  const ENTRY = /^ {4}'?([A-Za-z0-9._]+)'?\s*:\s*\{/gm;
  const matches = [...source.matchAll(ENTRY)];
  for (let i = 0; i < matches.length; i += 1) {
    const id = matches[i][1];
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
    const block = source.slice(start, end);
    seen.add(id);
    if (/settingsToggle\s*:\s*undefined/.test(block)) {
      toggles[id] = null;
      continue;
    }
    const bool = (name) => new RegExp(`${name}\\s*:\\s*(true|false)`).exec(block)?.[1] === 'true';
    const titleKey = /titleKey\s*:\s*'([^']+)'/.exec(block)?.[1] ?? null;
    if (!/settingsToggle\s*:\s*\{/.test(block)) {
      toggles[id] = null;
      continue;
    }
    toggles[id] = {
      showInSettings: bool('showInSettings'),
      isExperimental: bool('isExperimental'),
      defaultEnabled: bool('defaultEnabled'),
      titleKey,
    };
  }
  const missing = featureIds.filter((id) => !seen.has(id));
  if (missing.length) {
    throw new Error(`uiFeatureRegistry.ts did not yield entries for: ${missing.join(', ')}`);
  }
  return toggles;
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}


/**
 * The env keys are an explicit frozen map, not a derivation — `FEATURE_ENV_KEYS`
 * in the server's `featureEnvSchema.ts` enumerates all of them, including the
 * per-feature tuning knobs that have no catalog flag at all.
 *
 * So the key name is *derived* here and then checked against that map, and only
 * emitted when the map really contains it. Deriving alone would invent variables
 * for features the server never reads; enumerating alone would not tell you
 * which catalog flag a key belongs to. Doing both means a printed key is one a
 * self-hoster can actually set.
 */
export function collectFeatureEnvKeys(source) {
  return new Set(Array.from(source.matchAll(/'(HAPPIER_FEATURE_[A-Z0-9_]+)'/g), (m) => m[1]));
}

/** `sessions.agentSwitching` -> `HAPPIER_FEATURE_SESSIONS_AGENT_SWITCHING__ENABLED`. */
export function deriveEnabledEnvKey(id) {
  const path = id
    .split('.')
    .map((segment) => segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toUpperCase())
    .join('_');
  return `HAPPIER_FEATURE_${path}__ENABLED`;
}

export async function renderFeatureFlagReferenceMarkdown({
  catalogModulePath = CATALOG_DIST,
  uiRegistryPath = UI_REGISTRY,
  translationsPath = TRANSLATIONS,
  envSchemaPath = ENV_SCHEMA,
} = {}) {
  const { FEATURE_CATALOG } = await import(`file://${catalogModulePath}`);
  const ids = Object.keys(FEATURE_CATALOG).sort();
  const toggles = collectUiToggles(readFileSync(uiRegistryPath, 'utf8'), ids);
  const strings = collectTranslationLeaves(readFileSync(translationsPath, 'utf8'));
  const envKeys = collectFeatureEnvKeys(readFileSync(envSchemaPath, 'utf8'));
  const envKeyFor = (id) => {
    const derived = deriveEnabledEnvKey(id);
    return envKeys.has(derived) ? `\`${derived}\`` : '—';
  };

  const label = (id) => {
    const key = toggles[id]?.titleKey;
    if (!key) return null;
    return strings.get(key.split('.').pop()) ?? null;
  };

  const userToggles = ids.filter((id) => toggles[id]?.showInSettings);
  const serverOnly = ids.filter((id) => !toggles[id]?.showInSettings);

  const userRows = userToggles.map((id) => [
    label(id) ? `**${label(id)}**` : `\`${id}\``,
    `\`${id}\``,
    toggles[id].isExperimental ? 'Experimental' : 'Standard',
    toggles[id].defaultEnabled ? 'On' : 'Off',
  ]);

  const serverRows = serverOnly.map((id) => {
    const def = FEATURE_CATALOG[id];
    const deps = def.dependencies?.length ? def.dependencies.map((d) => `\`${d}\``).join(', ') : '—';
    return [`\`${id}\``, def.description ?? '', def.representation, deps, envKeyFor(id)];
  });

  const experimentalCount = userToggles.filter((id) => toggles[id].isExperimental).length;

  return `---
title: Feature flags
description: Every capability Happier can gate, who controls it, and what it defaults to — generated from the feature catalog.
---

Not everything Happier can do is switched on for everybody. A capability can be
gated in three places, and a feature is only usable when all three agree:

1. **The server** advertises which features it supports. Self-hosters control
   this with \`HAPPIER_FEATURE_*\` environment variables; on Happier Cloud it is
   set for you.
2. **The build** can deny features regardless of the server, through
   \`HAPPIER_BUILD_FEATURES_ALLOW\` and \`HAPPIER_BUILD_FEATURES_DENY\`.
3. **You** turn some of them on in **Settings → Features**.

Every feature in the catalog is **fail-closed**: if the client cannot get a
clear answer about whether a feature is available, it treats it as unavailable.
That is why a feature can seem to vanish when a server is unreachable, and why
a misconfigured self-hosted server hides features rather than half-enabling them.

There are ${ids.length} features in the catalog. ${userToggles.length} of them have a switch you can
reach; the other ${serverOnly.length} are decided before you get there.

## Features you can turn on yourself

These appear in **Settings → Features**. ${experimentalCount} of the ${userToggles.length} are marked experimental.

${table(['Feature', 'Id', 'Kind', 'Default'], userRows)}

Experimental toggles are hidden until you turn on the experiments switch at the
top of that screen. If a page tells you to enable something here and you cannot
find the row, that switch is almost always why.

A toggle only offers what the server already allows. Turning something on
locally cannot enable a feature the server has not advertised.

## Features the server decides

These have no user-facing switch. A self-hoster sets them through the
environment; on Happier Cloud they are managed for you. \`server\` means the
server owns the decision outright; \`client\` means the client owns the
behaviour but still needs the server to advertise the capability.

${table(['Id', 'What it gates', 'Owned by', 'Depends on', 'Environment variable'], serverRows)}

Where a feature depends on another, both must be enabled — enabling the
dependant alone does nothing.

## Related

- [Feature environment variables](/self-hosting/feature-env) — every \`HAPPIER_FEATURE_*\` variable,
  including the tuning knobs that gate no feature and appear in no table above.
- [Environment variables](/self-hosting/env) — the rest of the server's configuration.
- [Agent capabilities](/agents/capabilities) — what varies by agent rather than by flag.
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderFeatureFlagReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
