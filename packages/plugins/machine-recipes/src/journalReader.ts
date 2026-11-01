import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const group = { kind: 'input' as const, path: 'journalGroup' };
const membership = { id: 'journal-access', kind: 'group' as const, name: group, members: ['happier'], existingOnly: true as const };

/** The native prerequisite verifies the reviewed group; a familiar name proves nothing. */
export const JOURNAL_READER_RECIPE = {
  revision: '1', title: 'Read system logs',
  description: 'The Happier daemon reads every system log. The agent receives no journal group membership. A supervised daemon restart is required when membership changes.',
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
} satisfies Omit<MachineRecipeV1, 'id'>;
