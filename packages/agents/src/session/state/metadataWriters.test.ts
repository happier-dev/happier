import { describe, expect, it } from 'vitest';

import * as metadataWriters from './metadataWriters.js';

describe('metadataWriters', () => {
  it('applies and clears only the private Session voice preference through the registered binding', () => {
    const preference = { providerContributionId: 'happier.voice.xai/realtime', settingFieldPath: 'voice', value: { kind: 'custom', id: 'my-voice' } };
    const metadata = { work: { memoryEnabled: false, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep' } }, provider: 'unchanged' };
    const next = metadataWriters.applySessionStateUpdatesToMetadata(metadata, [{ fieldId: 'intent.voicePreference', value: preference }]);
    expect(next).toMatchObject({ ...metadata, work: { ...metadata.work, voicePreference: preference } });
    expect(metadataWriters.applySessionStateUpdatesToMetadata(next, [{ fieldId: 'intent.voicePreference', value: null }])).toEqual(metadata);
  });
  it('applies final backend launch session-state updates through canonical metadata bindings', () => {
    const applySessionStateUpdatesToMetadata = (
      metadataWriters as Readonly<Record<string, unknown>>
    ).applySessionStateUpdatesToMetadata;

    expect(typeof applySessionStateUpdatesToMetadata).toBe('function');
    if (typeof applySessionStateUpdatesToMetadata !== 'function') return;

    const metadata = applySessionStateUpdatesToMetadata(
      { existing: true },
      [
        {
          fieldId: 'identity.runtimeDescriptor',
          value: {
            v: 1,
            agentId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'vendor-parent-1',
            },
          },
        },
        {
          fieldId: 'identity.providerSessionId',
          value: 'vendor-child-1',
        },
        {
          fieldId: 'intent.permissionMode',
          value: {
            v: 1,
            permissionMode: 'plan',
            updatedAt: 123,
          },
        },
      ],
    );

    expect(metadata).toMatchObject({
      existing: true,
      codexSessionId: 'vendor-child-1',
      permissionMode: 'plan',
      permissionModeUpdatedAt: 123,
    });
  });
});
