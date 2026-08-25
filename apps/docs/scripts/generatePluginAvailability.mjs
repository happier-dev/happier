/**
 * Renders the Plugin SDK availability reference from `capability-matrix.json`.
 *
 * The corridor already treats that file as the authority — `plugins/quickstart.mdx`
 * calls it "the sole product-availability authority" — but the hand-written table in
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

function evidenceValue(value) {
  return code(value ?? 'not-recorded');
}

/**
 * Product availability and the evidence currently recorded for it are separate
 * facts. Keep that distinction in the projection instead of letting a source
 * declaration imply a loaded runtime or published release.
 */
function evidenceTable(entries, idKey) {
  return table(
    ['Name', 'Source API', 'Source consumer', 'Loaded-platform proof', 'Release availability'],
    entries
      .slice()
      .sort((a, b) => String(a[idKey]).localeCompare(String(b[idKey])))
      .map((e) => [
        code(e[idKey]),
        evidenceValue(e.sourceApiAvailability),
        code(e.sourceConsumer),
        evidenceValue(e.loadedPlatformProof),
        evidenceValue(e.releaseAvailability),
      ]),
  );
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
title: Developer Preview availability
description: Every contribution family, service, host-access capability and SDK entrypoint, with its current Developer Preview availability — generated from capability-matrix.json.
---

The Plugin SDK has one package-level **Developer Preview** posture. That posture
does not create a separate stability tier for each symbol. Some declarations the
manifest schema accepts are not yet wired end to end. \`capability-matrix.json\` in
\`packages/plugin-sdk\` is the authority on which is which, and this page is a
projection of it — so it cannot disagree with the artifact the rest of the
corridor cites.

**Available in Developer Preview** means the current Preview lifecycle has a
maintained proving consumer through that path. **Deferred** means it is not
supported or advertised for ordinary author use; do not rely on it; consult its
unblock condition.

Product availability is distinct from source API availability, source consumer,
loaded-platform proof, and release availability. The evidence fields record
only what the matrix has established: a source declaration or consumer does not
by itself prove that the current platform loaded it or that it was published.
Likewise, \`not-recorded\` does not infer the opposite state.

At the time this page was generated: **${families.available.length} of ${m.manifestFamilies.length} contribution families**,
**${services.available.length} of ${m.services.length} services**, **${hostAccess.available.length} of ${m.hostAccess.length} host-access capabilities**
and **${subpaths.available.length} of ${m.subpaths.length} SDK entrypoints** are available.

## Evidence recorded by the capability matrix

### Contribution family evidence

${evidenceTable(m.manifestFamilies, 'manifestFamily')}

### Service evidence

${evidenceTable(m.services, 'serviceId')}

### Host-access evidence

${evidenceTable(m.hostAccess, 'capability')}

### SDK entrypoint evidence

${evidenceTable(m.subpaths, 'specifier')}

## Contribution families available in Developer Preview

\`definePlugin(...)\` key and the entrypoint that exports its types.

${table(['Family', 'Author key', 'Entrypoint', 'Realm'], familyRows)}

## Contribution families that are deferred

${deferredTable(families.deferred, 'manifestFamily')}

## Services available in Developer Preview

Reached through \`context.services\` inside a plugin invocation.

${table(['Service', 'Type', 'Entrypoint', 'Lifecycle'], serviceRows)}

## Services that are deferred

${deferredTable(services.deferred, 'serviceId')}

## Host-access capabilities available in Developer Preview

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
