import { describe, expect, it } from 'vitest';
import { SessionSkillSelectionV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

import {
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_MODE_OVERRIDE_KEY,
} from '@happier-dev/agents';

import { buildNewSessionConfigurationDraft, buildNewSessionTempDataFromSessionConfiguration } from './sessionConfigurationSeed';
import { buildNewSessionAuthoringDraftFromPersistedDraft, buildNewSessionTempDataFromAuthoringDraft } from './sessionAuthoringDraftAdapters';

describe('sessionConfigurationSeed', () => {
    it.each(['custom:99753341-1e37-47e2-b284-9dc8b9bd1ad7', null, undefined])(
        'preserves the nullable approval-profile reference through the same-setup and configured-fork draft round trip (%s)',
        (approvalProfileId) => {
            const seed = buildNewSessionTempDataFromSessionConfiguration({
                session: {
                    id: 'source-session',
                    encryptionMode: 'plain',
                    metadata: {
                        path: '/workspace/source',
                        host: 'dev-host',
                        flavor: 'codex',
                        ...(approvalProfileId === undefined ? {} : { approvalProfileId }),
                    },
                },
                machineId: 'machine-source',
            });
            const persisted = buildNewSessionConfigurationDraft(seed);
            const reopened = buildNewSessionTempDataFromAuthoringDraft({
                draft: buildNewSessionAuthoringDraftFromPersistedDraft(persisted),
                machineId: 'machine-source',
            });
            for (const value of [seed, persisted, reopened]) {
                if (approvalProfileId === undefined) {
                    expect(value.approvalProfileId).toBeUndefined();
                } else {
                    expect(value).toHaveProperty('approvalProfileId', approvalProfileId);
                }
            }
        },
    );
    it('builds a promptless new-session seed from an existing session configuration', () => {
        const tempData = buildNewSessionTempDataFromSessionConfiguration({
            session: {
                id: 'session-1',
                encryptionMode: 'plain',
                metadata: {
                    path: '/workspace/source',
                    homeDir: '/workspace',
                    host: 'dev-host',
                    machineId: 'machine-source',
                    flavor: 'codex',
                    backendTarget: { kind: 'backend', backendId: 'codex' },
                    profileId: 'profile-1',
                    transcriptStorage: 'direct',
                    runtimeDescriptorV1: {
                        v: 1,
                        agentId: 'codex',
                        agent: { backendMode: 'appServer' },
                    },
                    mcpSelectionV1: {
                        v: 1,
                        managedServersEnabled: false,
                        forceIncludeServerIds: ['portable'],
                        forceExcludeServerIds: ['disabled'],
                    },
                    [SESSION_MODE_OVERRIDE_KEY]: {
                        v: 1,
                        updatedAt: 100,
                        modeId: 'plan',
                    },
                    [LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY]: {
                        v: 1,
                        updatedAt: 101,
                        overrides: {
                            effort: { updatedAt: 101, value: 'high' },
                        },
                    },
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            github: { source: 'connected' },
                        },
                    },
                    terminal: {
                        mode: 'tmux',
                        tmux: { target: 'feature-pane' },
                    },
                },
                permissionMode: 'acceptEdits',
                permissionModeUpdatedAt: 200,
                modelMode: 'gpt-5',
                modelModeUpdatedAt: 201,
            },
            machineId: 'machine-target',
            directoryOverride: '/workspace/target',
        });

        expect(tempData).toEqual(expect.objectContaining({
            prompt: '',
            machineId: 'machine-target',
            directory: '/workspace/target',
            agentType: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelSelection: {
                v: 1,
                updatedAt: 201,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5',
                },
            },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 101,
                overrides: {
                    effort: { updatedAt: 101, value: 'high' },
                },
            },
            capabilitySelection: {
                mcp: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['portable'],
                    forceExcludeServerIds: ['disabled'],
                },
                skills: SessionSkillSelectionV1Schema.parse({}),
            },
            backendNewSessionOptionStateByTargetKey: {
                'agent:happier.agent.codex/codex': {
                    connectedServices: {
                        v: 1,
                        bindingsByServiceId: {
                            github: { source: 'connected' },
                        },
                    },
                },
            },
            replacePersistedDraftSelections: true,
        }));
        expect(tempData.resumeSessionId).toBeUndefined();
        expect(tempData.checkoutCreationDraft).toBeNull();
    });
});
