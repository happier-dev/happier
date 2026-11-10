import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const content = { kind: 'template' as const, value: '[Journal]\nStorage=persistent\nSystemMaxUse={maximumUse}\n',
  variables: { maximumUse: { kind: 'input' as const, path: 'maximumUse' } } };
const file = { id: 'journal-policy', kind: 'file' as const, path: '/etc/systemd/journald.conf.d/60-happier.conf',
  owner: 'root', group: 'root', mode: 0o644, requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }],
  onChange: { serviceStepId: 'journal-service', action: 'restart' as const } };
const service = { id: 'journal-service', kind: 'serviceUnit' as const, unit: 'systemd-journald.service', running: true,
  requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }] };

/** Capacity comes from the reviewed selection, never a bundled default. */
export const boundedJournal: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Bounded journal',
  description: 'Keep persistent system logs within the capacity you choose.',
  inputSchema: { type: 'object', properties: {
    maximumUse: { type: 'string', pattern: '^[1-9][0-9]*[KMGTPE]?$(?![\\s\\S])' },
  }, required: ['maximumUse'], additionalProperties: false },
  steps: [{ id: 'journal-directory', kind: 'directory', path: '/etc/systemd/journald.conf.d', owner: 'root', group: 'root', mode: 0o755,
    preserveExistingOwnership: true, requiredFacts: file.requiredFacts }, { ...file, content }, service],
  removeSteps: [{ ...file, state: 'absent', expectedContentDigest: { kind: 'renderedContent', content } }, service],
};
