import { describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { serializeActionSpec } from '@happier-dev/protocol/actions/actionCatalog';
import { projectVoiceToolResultsForFollowUp } from './buildVoiceToolResultsFollowUp';
import { redactVoiceToolResultForProvider } from './redactVoiceToolResult';

const privacy = { shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false };

describe('Voice Action discovery privacy projection', () => {
  it.each(['direct', 'generic'] as const)('preserves setting declaration identifiers and choices while redacting private paths (%s)', transport => {
    const item = { anchor: 'voiceConversations.provider.happier.voice.elevenlabs/realtime-elevenlabs.voice',
      pageId: 'voiceConversations', title: 'Voice', description: 'Choose stage/commit/push/pull behavior.',
      readable: true, writable: true, sensitive: false, allowedValues: ['provider/model/voice'] };
    const result = { items: [item], total: 2, nextCursor: 1, diagnostic: '/home/alice/private/settings.json' };
    const [projected] = projectVoiceToolResultsForFollowUp([transport === 'direct'
      ? { t: 'settings_list', args: {}, result: { ok: true, ...result } }
      : { t: 'action_execute', args: { actionId: 'settings.list', input: {} }, result: { ok: true, result } },
    ], privacy);
    const output = projected?.result as { result?: unknown };
    expect(transport === 'direct' ? output : output.result).toMatchObject({ items: [item], total: 2, nextCursor: 1,
      diagnostic: '<path_redacted>' });
    for (const path of ['/home/alice/private/settings.json', '/var/lib/private/settings.json',
      '/etc/private/settings.json', '~/private/file.ts', './private/file.ts']) {
      expect(redactVoiceToolResultForProvider('settings_list', { items: [{ ...item,
        description: `Example ${path}`, allowedValues: [path, 'provider/model/voice'] }] }, privacy))
        .toMatchObject({ items: [{ anchor: item.anchor, description: 'Example <path_redacted>',
          allowedValues: ['<path_redacted>', 'provider/model/voice'] }] });
    }
    expect(redactVoiceToolResultForProvider('listSessions', { sessions: [{ path: 'src/private/file.ts' }] }, privacy))
      .toEqual({ sessions: [{ path: '<path_redacted>' }] });
  });
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
