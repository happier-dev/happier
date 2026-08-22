/**
 * Renders the Plugin SDK availability reference from `capability-matrix.json`.
 *
 * The corridor already treats that file as the authority — `plugins/quickstart.mdx`
 * calls it "the sole availability authority" — but the hand-written table in
 * `manifest/contributions.mdx` had drifted badly from it:
 *
 *   - 22 of 44 contribution families were absent from the page, 17 of them
 *     `available`, so authors had no way to discover working capabilities;
 *   - six families disagreed outright, in both directions. `mcp.servers` and
 *     `voiceModelPacks` are deferred in the matrix and read as usable on the
 *     page — the worst direction, because an author builds against them and
 *     finds out at registration time. `scmBackends`, `settings`, `ui.views` and
 *     `voiceProviders` are available and were marked deferred, which quietly
 *     tells people not to use working features.
 *
 * A curated subset of a machine-readable contract will always drift. This
 * projects all four matrix sections instead, so the page cannot disagree with
 * the artifact it cites.
 *
 * Regenerate with `yarn --cwd apps/docs generate:reference`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const MATRIX = join(REPO, 'packages', 'plugin-sdk', 'capability-matrix.json');
export const OUTPUT_PATH = join(HERE, '..', 'content', 'docs', 'plugins', 'manifest', 'availability.mdx');

const code = (v) => (v ? `\`${v}\`` : '—');

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function split(entries) {
  return {
    available: entries.filter((e) => e.availabilityDisposition === 'available'),
    deferred: entries.filter((e) => e.availabilityDisposition === 'deferred'),
  };
}

/** Deferred entries carry the condition that would unblock them; surface it. */
function deferredTable(entries, idKey) {
  if (!entries.length) return '_Nothing deferred in this section._';
  return table(
    ['Name', 'What would unblock it'],
    entries
      .slice()
      .sort((a, b) => String(a[idKey]).localeCompare(String(b[idKey])))
      .map((e) => [code(e[idKey]), e.unblockCondition || 'Not stated in the matrix.']),
  );
}

export async function renderPluginAvailabilityMarkdown({ matrixPath = MATRIX } = {}) {
  const m = JSON.parse(readFileSync(matrixPath, 'utf8'));
  const families = split(m.manifestFamilies);
  const services = split(m.services);
  const hostAccess = split(m.hostAccess);
  const subpaths = split(m.subpaths);

  const familyRows = families.available
    .slice()
    .sort((a, b) => a.manifestFamily.localeCompare(b.manifestFamily))
    .map((e) => [code(e.manifestFamily), code(e.definePluginAuthorKey), code(e.authorEntrypoint), e.realm ?? '—']);

  const serviceRows = services.available
    .slice()
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId))
    .map((e) => [
      `\`context.services.${e.property}\``,
      code(e.publicType),
      (e.authorEntrypoints ?? []).map(code).join(', ') || '—',
      e.lifecycle ?? '—',
    ]);

  const hostAccessRows = hostAccess.available
    .slice()
    .sort((a, b) => String(a.capability ?? a.hostAccessCapability).localeCompare(String(b.capability ?? b.hostAccessCapability)))
    .map((e) => [code(e.capability ?? e.hostAccessCapability), e.authorizationClass ?? e.realm ?? '—']);

  return `---
title: What you can build today
description: Every contribution family, service, host-access capability and SDK entrypoint, with its current availability — generated from capability-matrix.json.
---

The Plugin SDK ships ahead of its own surface: some of what the manifest schema
accepts is not yet wired end to end. \`capability-matrix.json\` in
\`packages/plugin-sdk\` is the authority on which is which, and this page is a
projection of it — so it cannot disagree with the artifact the rest of the
corridor cites.

**Available** means there is a proving consumer: a real plugin registering
through that path today. **Deferred** means the schema accepts the declaration
but the host does not complete the lifecycle — conformance only. Build against a
deferred family and it will validate, then do nothing.

At the time this page was generated: **${families.available.length} of ${m.manifestFamilies.length} contribution families**,
**${services.available.length} of ${m.services.length} services**, **${hostAccess.available.length} of ${m.hostAccess.length} host-access capabilities**
and **${subpaths.available.length} of ${m.subpaths.length} SDK entrypoints** are available.

## Contribution families you can use

\`definePlugin(...)\` key and the entrypoint that exports its types.

${table(['Family', 'Author key', 'Entrypoint', 'Realm'], familyRows)}

## Contribution families that are deferred

${deferredTable(families.deferred, 'manifestFamily')}

## Services you can use

Reached through \`context.services\` inside a plugin invocation.

${table(['Service', 'Type', 'Entrypoint', 'Lifecycle'], serviceRows)}

## Services that are deferred

${deferredTable(services.deferred, 'serviceId')}

## Host-access capabilities

What each authorization class actually enforces is on
[Host access](/plugins/security/permissions) — the classes differ more than the
names suggest.

${hostAccessRows.length ? table(['Capability', 'Class'], hostAccessRows) : '_None available._'}

${hostAccess.deferred.length ? `### Deferred\n\n${deferredTable(hostAccess.deferred, 'capability')}` : ''}

## Related

- [Contributions](/plugins/manifest/contributions) — what each family does.
- [Capabilities and permissions](/plugins/manifest/capabilities-and-permissions)
- [SDK entrypoints](/plugins/api/sdk-entrypoints)
`;
}

const isEntrypoint = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isEntrypoint) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUTPUT_PATH, await renderPluginAvailabilityMarkdown(), 'utf8');
  console.log(`wrote ${OUTPUT_PATH}`);
}
