import { describe, expect, it } from 'vitest';

import * as metadataWriters from './metadataWriters.js';
import { createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

describe('metadataWriters', () => {
  it('keeps the selected Team model source intact at Session birth', () => {
    const modelSelection = { v: 2 as const, updatedAt: 17, ref: { source: 'team_resource' as const,
      teamId: 'team-model-owner', resourceId: 'model-resource', expectedResourceRevision: 3,
      deliveryMode: 'direct' as const, agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'source-model' } };
    const metadata = metadataWriters.buildCommittedLaunchMetadata({ options: { modelSelection } });
    expect(metadata.modelSelectionIntentV2).toEqual(modelSelection);
    expect(metadata).not.toHaveProperty('modelSelectionIntentV1');
    const owner = createSessionOwnerMetadataV1({ metadata });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('Invalid Team model birth metadata');
    expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata }),
      ownerMetadata: owner.ownerMetadata }).modelSelectionIntentV2).toEqual(modelSelection);
  });
  it('retains creation approval provenance in private metadata and clears it on deliberate acceptance', () => {
    const metadata = metadataWriters.applyInitialSessionCreationFactsToMetadata({}, {
      approvalProfileId: 'team-profile', approvalProfileTeamOrGroupDerived: true,
    });
    const owner = createSessionOwnerMetadataV1({ metadata });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('Invalid owner metadata');
    expect(owner.ownerMetadata.runtime).toMatchObject({ approvalProfileId: 'team-profile',
      approvalProfileTeamOrGroupDerived: true });
    const captured = projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: projectSessionSharedMetadataV1({ metadata }), ownerMetadata: owner.ownerMetadata,
    });
    expect(captured.approvalProfileTeamOrGroupDerived).toBe(true);
    const accepted = metadataWriters.applySessionStateUpdatesToMetadata(captured, [{
      fieldId: 'intent.approvalProfileId', value: 'team-profile',
    }]);
    expect(accepted).toMatchObject({ approvalProfileId: 'team-profile', approvalProfileTeamOrGroupDerived: false });
    expect(metadataWriters.applySessionStateUpdatesToMetadata(accepted, [{
      fieldId: 'intent.approvalProfileId', value: 'team-profile',
    }])).toBe(accepted);
  });
  it('retains an admitted native sandbox choice through birth metadata and its strict owner envelope', () => {
    const metadata = metadataWriters.applyInitialSessionCreationFactsToMetadata({}, { nativeSandbox: 'off' });
    const owner = createSessionOwnerMetadataV1({ metadata });
    expect(owner.ok).toBe(true);
    if (!owner.ok) throw new Error('Invalid owner metadata');
    expect(owner.ownerMetadata.runtime?.nativeSandbox).toBe('off');
    expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: projectSessionSharedMetadataV1({ metadata }),
      ownerMetadata: JSON.parse(JSON.stringify(owner.ownerMetadata)) }).nativeSandbox).toBe('off');
    expect(metadataWriters.applyInitialSessionCreationFactsToMetadata(metadata, {})).not.toHaveProperty('nativeSandbox');
  });
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
