import { describe, expect, it } from 'vitest';
import { SessionSkillSelectionV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { readActionAudiencePolicy, setActionAudiencePolicy } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import { resolveProfiledActionsSettingsV1 } from '@happier-dev/protocol/actions/approvalProfiles';
import { resolveManagedSessionDefaults, type ManagedSessionDefaultsContext } from '@happier-dev/protocol/teams/managedDefaults';

import {
    LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
    SESSION_MODE_OVERRIDE_KEY,
} from '@happier-dev/agents';

import { buildNewSessionConfigurationDraft, buildNewSessionTempDataFromSessionConfiguration } from './sessionConfigurationSeed';
import { buildNewSessionAuthoringDraftFromPersistedDraft, buildNewSessionTempDataFromAuthoringDraft } from './sessionAuthoringDraftAdapters';

describe('sessionConfigurationSeed', () => {
    it.each(['unspecified', 'stored-automatic', 'local-automatic'] as const)(
        'preserves model intent when opening a copied configuration (%s)', source => {
            const seed = buildNewSessionTempDataFromSessionConfiguration({
                session: {
                    id: 'source-session',
                    encryptionMode: 'plain',
                    metadata: {
                        path: '/workspace/source', host: 'dev-host', flavor: 'codex',
                        ...(source === 'stored-automatic'
                            ? { modelSelectionIntentV1: { v: 1, selection: null, updatedAt: 50 } } : {}),
                    },
                    ...(source === 'local-automatic' ? { modelMode: 'default', modelModeUpdatedAt: 50 } : {}),
                },
                machineId: 'machine-source',
            });
            const reopened = buildNewSessionAuthoringDraftFromPersistedDraft(buildNewSessionConfigurationDraft(seed));
            expect(reopened.modelSelection).toBe(source === 'unspecified' ? undefined : null);
        },
    );

    it.each((['team', 'group', 'project'] as const).flatMap(layer =>
        [true, false].map(inherited => ({ layer, inherited }))))(
        'keeps copied $layer approval policy tighten-only (source inherited: $inherited)', ({ layer, inherited }) => {
        const actionId = 'session.stop';
        const account = setActionAudiencePolicy(normalizeActionsSettingsV1({ v: 1 }), actionId, 'agent', 'ask_first');
        const profile = { id: 'shared-profile', name: 'Team default',
            approvalWaivedSurfaces: { [actionId]: ['agent' as const] } };
        const seed = buildNewSessionTempDataFromSessionConfiguration({
            session: { id: 'shared-source', encryptionMode: 'plain', metadata: {
                path: '/workspace/source', host: 'dev-host', flavor: 'codex',
                approvalProfileId: profile.id, approvalProfileTeamOrGroupDerived: inherited,
            } },
            machineId: 'machine-source',
            approvalProfile: { access: 'view' },
        });
        const persisted = buildNewSessionConfigurationDraft(seed);
        const reopened = buildNewSessionTempDataFromAuthoringDraft({
            draft: buildNewSessionAuthoringDraftFromPersistedDraft(persisted), machineId: 'machine-source',
        });
        const context: ManagedSessionDefaultsContext = layer === 'project'
            ? { projectDefaults: { approvalProfileId: profile.id } }
            : { teamDefaults: { team: layer === 'team' ? { approvalProfileId: profile.id } : {},
                groups: layer === 'group' ? { reviewers: { approvalProfileId: profile.id } } : {} }, groupIds: ['reviewers'] };
        for (const copied of [seed, persisted, reopened]) {
            const defaults = resolveManagedSessionDefaults({
                agentTargetKey: 'agent:happier.agent.codex/codex',
                ...context,
                explicitChoices: copied.approvalProfileId === undefined ? {} : { approvalProfileId: copied.approvalProfileId },
            });
            const resolved = resolveProfiledActionsSettingsV1(account, defaults.approvalProfileId.value, {
                boundProfile: { profile, resolution: { status: 'available', requestedId: profile.id } },
                approvalProfileTeamOrGroupDerived: defaults.approvalProfileId.teamOrGroupDerived,
            });
            expect(readActionAudiencePolicy(resolved.settings, actionId, 'agent').mode)
                .toBe('ask_first');
        }
        // A fresh same-id pick or explicit detach goes through the ordinary authoring owner.
        for (const approvalProfileId of [profile.id, null]) {
            const explicit = buildNewSessionConfigurationDraft({ ...seed, approvalProfileId });
            const defaults = resolveManagedSessionDefaults({ ...context,
                agentTargetKey: 'agent:happier.agent.codex/codex', explicitChoices: { approvalProfileId: explicit.approvalProfileId } });
            const resolved = resolveProfiledActionsSettingsV1(account, defaults.approvalProfileId.value, {
                boundProfile: approvalProfileId === null ? null
                    : { profile, resolution: { status: 'available', requestedId: profile.id } },
                approvalProfileTeamOrGroupDerived: defaults.approvalProfileId.teamOrGroupDerived,
            });
            expect(defaults.approvalProfileId.teamOrGroupDerived).toBe(false);
            expect(readActionAudiencePolicy(resolved.settings, actionId, 'agent').mode)
                .toBe(approvalProfileId === null ? 'ask_first' : 'allowed');
        }
    });

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
                approvalProfile: { access: 'owner' },
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
