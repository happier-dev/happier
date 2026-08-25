/**
 * Renders the complete public surface of the Plugin SDK from `api-surface.json`.
 *
 * `sdk-entrypoints.mdx` answers "which import path does this capability live
 * behind", and a test already holds it to every entry in the package's
 * `exports`. What nothing covered was the other half of the question: whether a
 * given symbol exists at all, and which current entrypoint exports it. That
 * is 2,000-plus symbols, and the honest answer is a generated index rather than
 * a hand-kept selection — a hand-kept one silently becomes a list of the symbols
 * somebody happened to use in 2026.
 *
 * Two fields carry most of the meaning and both are worth reading before the
 * tables:
 *
 *   `visibility` separates what a plugin author may import (`author`) from what
 *   only the host may (`host`). Importing a host entrypoint from a plugin is not
 *   a compile error — it is a support boundary, which is exactly why it needs
 *   documenting.
 *
 *   `realm` says where the code can run. A `daemon` symbol in client code fails
 *   at runtime, not at build time, so the realm column prevents a class of bug
 *   that typechecking will not catch.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const SURFACE = join(REPO, 'packages', 'plugin-sdk', 'api-surface.json');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'plugins', 'api', 'surface.mdx');

/** The shape this generator understands. A bump means the projection changed. */
export const SUPPORTED_SCHEMA_VERSION = 1;

const REALM_NOTE = {
  any: 'Anywhere.',
  daemon: 'Daemon only.',
  client: 'Client only.',
  browser: 'Browser only.',
  build: 'Build time only.',
};

export function summarize(surface) {
  if (surface.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `api-surface.json is schemaVersion ${surface.schemaVersion}, and this generator understands `
      + `${SUPPORTED_SCHEMA_VERSION}. Re-read the projection before publishing a page from it.`,
    );
  }
  const entrypoints = surface.entrypoints ?? [];
  const symbols = surface.symbols ?? [];
  if (entrypoints.length === 0) throw new Error('api-surface.json parsed to zero entrypoints');
  if (symbols.length === 0) throw new Error('api-surface.json parsed to zero symbols');

  const known = new Set(entrypoints.map((e) => e.specifier));
  const orphans = [...new Set(symbols.map((s) => s.specifier))].filter((s) => !known.has(s));
  if (orphans.length > 0) {
    throw new Error(`symbols exported from unlisted entrypoints: ${orphans.join(', ')}`);
  }

  const byEntrypoint = new Map(entrypoints.map((e) => [e.specifier, { ...e, values: [], types: [] }]));
  for (const symbol of symbols) {
    const bucket = byEntrypoint.get(symbol.specifier);
    (symbol.kind === 'value' ? bucket.values : bucket.types).push(symbol);
  }
  for (const bucket of byEntrypoint.values()) {
    bucket.values.sort((a, b) => a.exportName.localeCompare(b.exportName));
    bucket.types.sort((a, b) => a.exportName.localeCompare(b.exportName));
  }
  return {
    entrypoints: [...byEntrypoint.values()].sort((a, b) => a.specifier.localeCompare(b.specifier)),
    totalSymbols: symbols.length,
    totalValues: symbols.filter((s) => s.kind === 'value').length,
    totalTypes: symbols.filter((s) => s.kind === 'type').length,
  };
}

/** `.` is the package root; everything else is `@happier-dev/plugin-sdk/<path>`. */
export function importPath(specifier) {
  return specifier === '.' ? '@happier-dev/plugin-sdk' : `@happier-dev/plugin-sdk${specifier.slice(1)}`;
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** Thousands separators, because "2122 symbols" reads as a typo at a glance. */
const count = (n) => n.toLocaleString('en-US');

function names(symbols) {
  return symbols.map((s) => `\`${s.exportName}\``).join(', ');
}

export function renderSdkSurfaceMarkdown(surface) {
  const { entrypoints, totalSymbols, totalValues, totalTypes } = summarize(surface);
  const authorCount = entrypoints.filter((e) => e.visibility === 'author').length;
  const hostCount = entrypoints.length - authorCount;

  const index = table(
    ['Import from', 'Visibility', 'Realm', 'Values', 'Types'],
    entrypoints.map((e) => [
      `\`${importPath(e.specifier)}\``,
      e.visibility,
      e.realm,
      String(e.values.length),
      String(e.types.length),
    ]),
  );

  const detail = entrypoints
    .map((e) => {
      const parts = [];
      if (e.values.length > 0) parts.push(`**Values** — ${names(e.values)}`);
      if (e.types.length > 0) parts.push(`**Types** — ${names(e.types)}`);
      const realm = REALM_NOTE[e.realm] ?? e.realm;
      const meta = `${e.visibility === 'host' ? 'Host-only. ' : ''}${realm} Source: \`${e.sourceModule}\`.`;
      return `<Accordion title="${importPath(e.specifier)} — ${e.values.length + e.types.length} exports">\n\n${meta}\n\n${parts.join('\n\n')}\n\n</Accordion>`;
    })
    .join('\n\n');

  return `---
title: Public API surface
description: Every symbol the Plugin SDK exports and the entrypoint it comes from — generated from the SDK's own api-surface projection.
---

The SDK exports **${count(totalSymbols)} symbols** across **${entrypoints.length} entrypoints**:
${count(totalValues)} values and ${count(totalTypes)} types. This page is the index — it answers
"does this exist, and where do I import it from", which is the question a type
definition file cannot answer until you already know the answer.

For *which entrypoint a capability belongs to*, read
[SDK entrypoints](/plugins/api/sdk-entrypoints) first. This page is the exhaustive
counterpart to it.

## How to read it

**Visibility** separates the ${authorCount} entrypoints a plugin author may import
from the ${hostCount} the host reserves for itself.

<Callout type="warn">
  Importing a \`host\` entrypoint from a plugin is not a compile error. It is a
  support boundary, and code that crosses it can break on any release without
  that being a regression.
</Callout>

**Realm** says where the code can run — \`any\`, \`daemon\`, \`client\`, \`browser\`
or \`build\`. A \`daemon\` symbol used in client code fails at runtime rather than
at build time, so this is the column that prevents a bug typechecking will not
catch.

## Entrypoints

${index}

## Every export, by entrypoint

<Accordions>

${detail}

</Accordions>

## Related

- [SDK entrypoints](/plugins/api/sdk-entrypoints) — choosing the right one by task.
- [What you can build today](/plugins/manifest/availability) — availability, which is a different question from existence.
- [Activation](/plugins/api/activation) — binding the values above to declared ids.
`;
}

export async function renderSdkSurfaceReferenceMarkdown({ surfacePath = SURFACE } = {}) {
  return renderSdkSurfaceMarkdown(JSON.parse(readFileSync(surfacePath, 'utf8')));
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderSdkSurfaceReferenceMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
