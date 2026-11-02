import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { serializeActionSpec } from '@happier-dev/protocol/actions/actionCatalog';
import { projectVoiceToolResultsForFollowUp } from './buildVoiceToolResultsFollowUp';
import { redactVoiceToolResultForProvider } from './redactVoiceToolResult';

const privacy = { shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false };

describe('Voice Action discovery privacy projection', () => {
  it.each(['direct', 'generic'] as const)('retains catalog field names and labels without disclosing paths (%s)', transport => {
    const spec = serializeActionSpec(getActionSpec('settings.list'));
    const result = { actionSpecs: [{ ...spec, description: 'Example /home/alice/private/settings.json' }] };
    const [projected] = projectVoiceToolResultsForFollowUp([transport === 'direct'
      ? { t: 'searchActionSpecs', args: { query: 'voice settings' }, result: { ok: true, ...result } }
      : { t: 'action_execute', args: { actionId: 'action.spec.search', input: { query: 'voice settings' } }, result: { ok: true, result } },
    ], privacy);
    const serialized = JSON.stringify(projected?.result);
    expect(serialized).toContain('"path":"pageId"');
    expect(serialized).toContain('"title":"List settings"');
    expect(serialized).toContain('voiceConversations');
    expect(serialized).not.toContain('/home/alice');
  });

  it('preserves setting labels while keeping Session summary aliases private', () => {
    expect(redactVoiceToolResultForProvider('settings_list', { ok: true,
      items: [{ anchor: 'voiceConversations.verbosity', title: 'Replies' }] }, privacy))
      .toMatchObject({ items: [{ title: 'Replies' }] });
    expect(redactVoiceToolResultForProvider('listSessions', { sessions: [{ id: 's1', title: 'Private Session',
      path: '/home/alice/private' }] }, privacy)).toEqual({ sessions: [{ id: 's1', path: '<path_redacted>' }] });
  });
});
