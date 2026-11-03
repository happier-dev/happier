/**
 * Projects author availability from the SDK's canonical capability matrix.
 * Regenerate with `pnpm --dir apps/docs run generate:reference`.
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
    implemented: entries.filter((e) => ['available', 'preview'].includes(e.availabilityDisposition)),
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

  const familyRows = families.implemented
    .slice()
    .sort((a, b) => a.manifestFamily.localeCompare(b.manifestFamily))
    .map((e) => [code(e.manifestFamily), code(e.availabilityDisposition), code(e.definePluginAuthorKey), code(e.authorEntrypoint), e.realm ?? '—']);

  const serviceRows = services.implemented
    .slice()
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId))
    .map((e) => [
      `\`context.services.${e.property}\``,
      code(e.availabilityDisposition),
      code(e.publicType),
      (e.authorEntrypoints ?? []).map(code).join(', ') || '—',
      e.lifecycle ?? '—',
    ]);

  const hostAccessRows = hostAccess.implemented
    .slice()
    .sort((a, b) => String(a.capability ?? a.hostAccessCapability).localeCompare(String(b.capability ?? b.hostAccessCapability)))
    .map((e) => [code(e.capability ?? e.hostAccessCapability), code(e.availabilityDisposition), e.authorizationClass ?? e.realm ?? '—']);

  const subpathRows = subpaths.implemented
    .slice()
    .sort((a, b) => a.specifier.localeCompare(b.specifier))
    .map((e) => [code(e.specifier), code(e.availabilityDisposition), e.realm ?? '—']);

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

**Available** families have a current authoring and implementation path.
**Preview** families retain an implemented author API while awaiting a current
production consumer. Both are usable in the package's Developer Preview;
\`preview\` is a label, not a registration restriction for external plugins.
**Deferred** means the lifecycle is incomplete in the applicable realm and is
not supported for ordinary author use; consult its unblock condition.

This reference describes 0.3 development source. It does not establish released
availability or verify a loaded runtime.

At the time this page was generated: **${families.implemented.length} of ${m.manifestFamilies.length} contribution families**,
**${services.implemented.length} of ${m.services.length} services**, **${hostAccess.implemented.length} of ${m.hostAccess.length} host-access capabilities**
and **${subpaths.implemented.length} of ${m.subpaths.length} SDK entrypoints** are implemented.

## Contribution families available in Developer Preview

\`definePlugin(...)\` key and the entrypoint that exports its types.

${table(['Family', 'Availability', 'Author key', 'Entrypoint', 'Realm'], familyRows)}

## Contribution families that are deferred

${deferredTable(families.deferred, 'manifestFamily')}

## Services available in Developer Preview

Reached through \`context.services\` inside a plugin invocation.

${table(['Service', 'Availability', 'Type', 'Entrypoint', 'Lifecycle'], serviceRows)}

## Services that are deferred

${deferredTable(services.deferred, 'serviceId')}

## Host-access capabilities available in Developer Preview

What each authorization class actually enforces is on
[Host access](/plugins/security/permissions) — the classes differ more than the
names suggest.

${hostAccessRows.length ? table(['Capability', 'Availability', 'Class'], hostAccessRows) : '_None available._'}

${hostAccess.deferred.length ? `### Deferred\n\n${deferredTable(hostAccess.deferred, 'capability')}` : ''}

## SDK entrypoints available in Developer Preview

${table(['Entrypoint', 'Availability', 'Realm'], subpathRows)}

${subpaths.deferred.length ? `### Deferred\n\n${deferredTable(subpaths.deferred, 'specifier')}` : ''}

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
