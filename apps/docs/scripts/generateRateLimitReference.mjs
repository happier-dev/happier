/**
 * Renders the API rate-limit reference from the server's rate-limit catalog.
 *
 * These variables are never written down anywhere in the server: the catalog
 * lists endpoint ids and defaults, and the env keys are *derived* from those ids
 * at runtime (`HAPPIER_${UPPER_SNAKE_ID}_RATE_LIMIT_MAX`). So no amount of
 * grepping the source for `HAPPIER_AUTH_PAIRING_START_RATE_LIMIT_MAX` finds it —
 * which is exactly why ten of the thirty-three were undocumented, including the
 * pairing and device-auth limits an operator hits during a rollout.
 *
 * The derivation is reimplemented here rather than imported because the catalog
 * is server-internal and not exported from a built package. `toUpperSnakeCase`
 * mirrors `apps/server/sources/app/api/utils/apiRateLimitCatalog.ts`, and the
 * test pins the two together on real cases.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CATALOG = join(REPO, 'apps', 'server', 'sources', 'app', 'api', 'utils', 'apiRateLimitCatalog.ts');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'deployment', 'rate-limits.mdx');

/** Mirrors `toUpperSnakeCase` in the server's rate-limit catalog. */
export function toUpperSnakeCase(input) {
  return input
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

export function parseRateLimitCatalog(source) {
  const start = source.indexOf('API_HOT_ENDPOINT_RATE_LIMIT_DEFAULTS = {');
  const end = source.indexOf('} as const satisfies', start);
  if (start < 0 || end < 0) throw new Error('Could not locate API_HOT_ENDPOINT_RATE_LIMIT_DEFAULTS');
  const block = source.slice(start, end);
  const ENTRY = /^\s*"?([A-Za-z0-9.]+)"?\s*:\s*\{\s*defaultMax:\s*(\d+),\s*defaultWindow:\s*"([^"]+)",\s*keyMode:\s*"([^"]+)"/gm;
  const entries = [...block.matchAll(ENTRY)].map((m) => ({
    id: m[1],
    defaultMax: Number(m[2]),
    defaultWindow: m[3],
    keyMode: m[4],
    maxEnvKey: `HAPPIER_${toUpperSnakeCase(m[1])}_RATE_LIMIT_MAX`,
    windowEnvKey: `HAPPIER_${toUpperSnakeCase(m[1])}_RATE_LIMIT_WINDOW`,
  }));
  if (entries.length === 0) throw new Error('Rate-limit catalog parsed to zero entries');
  return entries;
}

export async function renderRateLimitReferenceMarkdown({ catalogPath = CATALOG } = {}) {
  const entries = parseRateLimitCatalog(readFileSync(catalogPath, 'utf8'));
  const byUser = entries.filter((e) => e.keyMode === 'user').length;

  const rows = entries
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => [
      `\`${e.id}\``,
      `${e.defaultMax} / ${e.defaultWindow}`,
      e.keyMode === 'ip' ? 'IP address' : 'Account',
      `\`${e.maxEnvKey}\`<br />\`${e.windowEnvKey}\``,
    ]);

  return `---
title: API rate limits
description: Every rate-limited endpoint, its default, what it counts against, and the two environment variables that change it.
---

Happier rate-limits its busiest endpoints. The defaults suit a normal
deployment; you would usually only raise one after watching a specific endpoint
throttle under real load, or lower one on a server exposed to the public
internet.

Each endpoint has two environment variables — a maximum and a window. Set both
or neither; setting only the maximum leaves the window at its default, which is
rarely what you want.

The window accepts the same duration strings the defaults use (\`1 minute\`,
\`30 seconds\`, \`1 hour\`).

**What it counts against** matters more than the number. \`Account\` limits are
per signed-in account, so one busy user cannot exhaust another's budget.
\`IP address\` limits apply before Happier knows who is calling — they protect
unauthenticated routes, and behind a reverse proxy they are only as accurate as
the forwarded client address your proxy sets. ${byUser} of the ${entries.length} limits are
per-account.

Two clusters are worth knowing about before a rollout, because they throttle
exactly when many people onboard at once: \`auth.pairing.*\` covers connecting a
new device, and \`connectedServices.deviceAuth.*\` covers linking an agent
account from a headless machine.

${['| Endpoint | Default | Counted per | Environment variables |', '| --- | --- | --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n')}

## Related

- [Environment variables](/deployment/env) — everything else the server reads.
- [Server quickstart](/server/quickstart)
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderRateLimitReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
