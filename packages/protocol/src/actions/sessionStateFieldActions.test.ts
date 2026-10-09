import { describe, expect, it } from 'vitest';
import { resolveSessionStateFieldActionWrite, type SessionStateFieldActionId } from './sessionStateFieldActions.js';

describe('registered Session context Actions', () => {
  it('maps a reviewed voice preference to its registered owner without changing provider settings', () => {
    const preference = { providerContributionId: 'happier.voice.xai/realtime', settingFieldPath: 'voice', value: { kind: 'custom', id: 'my-voice' } };
    const target = { sessionId: 'session', serverId: 'home', expectedMetadataRevision: 4 };
    expect(resolveSessionStateFieldActionWrite('session.voice.preference.set' as SessionStateFieldActionId, { ...target, preference }))
      .toEqual({ fieldId: 'intent.voicePreference', value: preference, expectedMetadataRevision: 4 });
    expect(resolveSessionStateFieldActionWrite('session.voice.preference.set' as SessionStateFieldActionId, { ...target, preference: null }))
      .toEqual({ fieldId: 'intent.voicePreference', value: null, expectedMetadataRevision: 4 });
  });
  it('maps reviewed Session edits to one field owner and a reserved instruction entry', () => {
    const target = { sessionId: 'session', serverId: 'home', expectedMetadataRevision: 4 };
    expect(resolveSessionStateFieldActionWrite('session.memory.set' as SessionStateFieldActionId, { ...target, enabled: false }))
      .toEqual({ fieldId: 'intent.memoryEnabled', value: false, expectedMetadataRevision: 4 });
    const intent = { kind: 'inherited_enable', entryId: 'account.context', enabled: false };
    expect(resolveSessionStateFieldActionWrite('session.context.update' as SessionStateFieldActionId, { ...target, intent }))
      .toEqual({ fieldId: 'intent.context', value: intent, expectedMetadataRevision: 4 });
    expect(resolveSessionStateFieldActionWrite('session.instructions.set' as SessionStateFieldActionId,
      { ...target, ref: { kind: 'doc', artifactId: 'instructions' } }))
      .toMatchObject({ fieldId: 'intent.context', expectedMetadataRevision: 4,
        value: { kind: 'set', entry: { id: 'session.instructions', enabled: true, required: true, placement: 'system_append' } } });
    expect(resolveSessionStateFieldActionWrite('session.instructions.set' as SessionStateFieldActionId, { ...target, ref: null }))
      .toEqual({ fieldId: 'intent.context', expectedMetadataRevision: 4, value: { kind: 'detach', entryId: 'session.instructions' } });
  });
});
