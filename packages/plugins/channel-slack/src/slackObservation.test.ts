import { ConversationNormalizedIngressV1Schema } from '@happier-dev/channels-protocol/v1';
import { describe, expect, it } from 'vitest';

import { mapSlackEventToIngress } from './slackObservation.js';

const identity = { teamId: 'T1', appId: 'A1', botUserId: 'U1', botId: 'B1', label: 'Happier' };
const channel = { id: 'C1', isIm: false, isMpim: false, isPrivate: false, isArchived: false };
function payload(event: Record<string, unknown> = {}) {
  return { type: 'event_callback', team_id: 'T1', api_app_id: 'A1', event_id: 'Ev1',
    event: { type: 'message', channel: 'C1', user: 'U2', text: '<@U1> hello', ts: '1700000000.123456', ...event } };
}

describe('Slack authenticated message normalization', () => {
  it('preserves workspace-qualified occurrence, principal and thread identities through the core schema', () => {
    const result = mapSlackEventToIngress({ payload: payload({ thread_ts: '1699999999.000001' }), identity, channel });
    expect(result).toMatchObject({ kind: 'fullText', observation: {
      occurrenceId: 'slack:T1:channel:C1:message:1700000000.123456', occurredAt: 1700000000123, transport: { kind: 'socket' },
      endpoint: { id: 'slack:T1:channel:C1:thread:1699999999.000001', parentId: 'slack:T1:channel:C1', kind: 'thread', audience: 'shared' },
      actor: { principalId: 'slack:T1:user:U2', kind: 'human', isIntegrationSelf: false },
      message: { id: '1700000000.123456', text: 'hello', addressingEvidence: 'directIntegrationMention' },
    } });
    expect(ConversationNormalizedIngressV1Schema.safeParse(result).success).toBe(true);
  });

  it.each(['/stop', '/allow request-1', '/answer request-1 [{"questionIndex":0,"values":["two  spaces"]}]'])('removes the leading own-bot address before shared command parsing: %s', command => {
    const result = mapSlackEventToIngress({ payload: payload({ type: 'app_mention', text: `<@U1> ${command}` }), identity, channel });
    expect(result).toMatchObject({ kind: 'fullText', observation: { message: {
      text: command, addressingEvidence: 'directIntegrationMention',
    } } });
  });

  it.each(['<@U2> /stop', 'ask <@U1> /stop', '<@U1>suffix /stop', '/stop', '<@U1>'])('preserves content outside a separate leading own-bot address: %s', text => {
    expect(mapSlackEventToIngress({ payload: payload({ text }), identity, channel }))
      .toMatchObject({ kind: 'fullText', observation: { message: { text } } });
  });

  it('derives direct and multi-person audiences from conversations.info rather than the event channel_type', () => {
    const direct = mapSlackEventToIngress({ payload: payload({ channel_type: 'channel' }), identity, channel: { ...channel, isIm: true } });
    expect(direct).toMatchObject({ observation: { endpoint: { kind: 'direct', audience: 'direct' } } });
    const shared = mapSlackEventToIngress({ payload: payload({ channel_type: 'im' }), identity, channel: { ...channel, isMpim: true } });
    expect(shared).toMatchObject({ observation: { endpoint: { kind: 'shared', audience: 'shared' } } });
  });

  it.each([{ team_id: 'T2' }, { api_app_id: 'A2' }])('refuses foreign workspace or app evidence %j', mismatch => {
    expect(mapSlackEventToIngress({ payload: { ...payload(), ...mismatch }, identity, channel })).toBeNull();
  });

  it('classifies bot and integration-self evidence without impersonating a human principal', () => {
    expect(mapSlackEventToIngress({ payload: payload({ subtype: 'bot_message', bot_id: 'B9', user: undefined }), identity, channel }))
      .toMatchObject({ observation: { actor: { principalId: null, kind: 'bot', isIntegrationSelf: false } } });
    expect(mapSlackEventToIngress({ payload: payload({ bot_id: 'B1', user: 'U1' }), identity, channel }))
      .toMatchObject({ observation: { actor: { kind: 'integration', isIntegrationSelf: true } } });
  });

  it('strips edits to bodyless immutable revision evidence and ignores deletes', () => {
    const changed = payload({ subtype: 'message_changed', message: { user: 'U2', ts: '1700000000.123456', text: 'untrusted edited body', edited: { ts: '1700000001.123456' } } });
    const result = mapSlackEventToIngress({ payload: changed, identity, channel });
    expect(result).toMatchObject({ kind: 'routableNonAdmission', reason: 'unsupportedEdit', shell: { message: { revision: '1700000001.123456' } } });
    expect(JSON.stringify(result)).not.toContain('untrusted edited body');
    expect(ConversationNormalizedIngressV1Schema.safeParse(result).success).toBe(true);
    expect(mapSlackEventToIngress({ payload: payload({ subtype: 'message_deleted', deleted_ts: '1700000000.123456' }), identity, channel })).toBeNull();
  });

  it('keeps posts with the same timestamp in other channels separate from the original post and its edits', () => {
    const original = mapSlackEventToIngress({ payload: payload(), identity, channel });
    const otherChannel = mapSlackEventToIngress({ payload: { ...payload({ channel: 'C2' }), event_id: 'EvOther' }, identity, channel: { ...channel, id: 'C2' } });
    const edit = mapSlackEventToIngress({ payload: { ...payload({ subtype: 'message_changed', message: {
      user: 'U2', ts: '1700000000.123456', text: 'edited', edited: { ts: '1700000001.123456' },
    } }), event_id: 'EvEdit' }, identity, channel });
    expect(original?.kind).toBe('fullText');
    expect(otherChannel?.kind).toBe('fullText');
    expect(edit?.kind).toBe('routableNonAdmission');
    if (original?.kind !== 'fullText' || otherChannel?.kind !== 'fullText' || edit?.kind !== 'routableNonAdmission') {
      throw new Error('Expected normalized Slack post and edit evidence');
    }
    expect(otherChannel.observation.occurrenceId).not.toBe(original.observation.occurrenceId);
    expect(edit.shell.occurrenceId).not.toBe(original.observation.occurrenceId);
  });

  it.each(['caption', ''])('admits native files with caption %j and keeps the thread', text => {
    const result = mapSlackEventToIngress({ payload: payload({ text, subtype: 'file_share', thread_ts: '1699999999.000001',
      files: [{ id: 'F1', name: 'screen.png', mimetype: 'image/png', size: 123, url_private: 'https://files.slack.com/secret' }] }), identity, channel });
    expect(result).toMatchObject({ kind: 'fullText', observation: {
      endpoint: { kind: 'thread', id: 'slack:T1:channel:C1:thread:1699999999.000001' },
      message: { text, attachments: [{ name: 'screen.png', mediaType: 'image/png', byteLength: 123 }] },
    } });
    expect(JSON.stringify(result)).not.toContain('https://files.slack.com');
  });

  it('keeps unsupported file content bodyless and never trusts mismatched channel metadata', () => {
    expect(mapSlackEventToIngress({ payload: payload({ files: [{ id: 'F1' }] }), identity, channel }))
      .toMatchObject({ kind: 'routableNonAdmission', reason: 'unsupportedContent' });
    expect(mapSlackEventToIngress({ payload: payload(), identity, channel: { ...channel, id: 'C2' } })).toBeNull();
  });

  it('does not treat legacy attachment fallback text as an original human command', () => {
    const result = mapSlackEventToIngress({ payload: payload({ text: '/stop', attachments: [{ fallback: '/stop', text: '/stop' }] }), identity, channel });
    expect(result).toMatchObject({ kind: 'routableNonAdmission', reason: 'unsupportedContent' });
    expect(JSON.stringify(result)).not.toContain('/stop');
  });
});
