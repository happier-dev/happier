import { describe, expect, it } from 'vitest';

import { CODEX_UI_DESCRIPTOR } from './descriptor.js';

describe('CODEX_UI_DESCRIPTOR context window fallback', () => {
  it('pins the current Codex catalog windows while leaving live snapshots authoritative', () => {
    expect(CODEX_UI_DESCRIPTOR.behavior.contextWindow).toEqual({
      defaultTokens: 372_000,
      modelRules: [
        { idSuffix: 'gpt-5.6-sol', tokens: 372_000 },
        { idSuffix: 'gpt-5.6-terra', tokens: 372_000 },
        { idSuffix: 'gpt-5.6-luna', tokens: 372_000 },
        { idSuffix: 'gpt-5.5', tokens: 272_000 },
        { idSuffix: 'gpt-5.4', tokens: 272_000 },
        { idSuffix: 'gpt-5.4-mini', tokens: 272_000 },
      ],
    });
  });

  it('selects current external and released direct-session identities without stale aliases', () => {
    const candidateGroups = [
      CODEX_UI_DESCRIPTOR.behavior.workState.editableGoals.modeCandidates,
      CODEX_UI_DESCRIPTOR.behavior.payload.sessionExtras.metadataCandidates,
    ];

    for (const candidates of candidateGroups) {
      expect(candidates).toContainEqual({
        path: ['directSessionV1', 'codexBackendMode'],
        required: { path: ['directSessionV1', 'providerId'], equals: 'codex' },
      });
      expect(candidates).toContainEqual({
        path: ['externalSessionV1', 'codexBackendMode'],
        required: { path: ['externalSessionV1', 'agentId'], equals: 'codex' },
      });
      expect(candidates).not.toContainEqual(expect.objectContaining({
        required: { path: ['externalSessionV1', 'providerId'], equals: 'codex' },
      }));
    }
  });
});
