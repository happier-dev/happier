import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const group = { kind: 'input' as const, path: 'journalGroup' };
const membership = { id: 'journal-access', kind: 'group' as const, name: group, members: [{ kind: 'targetFact' as const, fact: 'daemon.username' as const }], existingOnly: true as const };

/** The native prerequisite verifies the reviewed group; a familiar name proves nothing. */
export const JOURNAL_READER_RECIPE: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Read system logs',
  description: 'Let Happier read this Machine’s system logs. Agents get no direct access. Restart Happier to turn it on.',
  inputSchema: { type: 'object', properties: {
    journalGroup: { type: 'string', pattern: '^[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$(?![\\s\\S])' },
  }, required: ['journalGroup'], additionalProperties: false },
  steps: [{ ...membership, requiredFacts: [{ kind: 'journalReadGroup', group }], review: {
    title: 'Read system logs', description: 'The Happier daemon reads every system log. Restart the daemon to use the changed membership.',
  } }],
  // Revocation still works if journald or its former access route disappears.
  // Source composition preserves membership present at the first apply.
  removeSteps: [{ ...membership, state: 'absent', review: {
    title: 'Stop reading system logs', description: 'Remove the daemon membership added by this setup. Existing membership is preserved. Restart the daemon to drop the removed access.',
  } }],
};
