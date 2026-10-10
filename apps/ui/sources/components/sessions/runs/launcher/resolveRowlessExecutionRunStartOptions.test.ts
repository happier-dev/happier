import { describe, expect, it } from 'vitest';

import { resolveRowlessExecutionRunStartOptions } from './resolveRowlessExecutionRunStartOptions';
import type { ExecutionRunLauncherBackendChoice } from './resolveExecutionRunLauncherBackendChoices';

const choice = {
    backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    targetKey: 'agent:happier.agent.codex/codex',
    backendId: 'codex',
    agentId: 'codex',
    title: 'Codex',
    disabled: false,
} satisfies ExecutionRunLauncherBackendChoice;

describe('resolveRowlessExecutionRunStartOptions', () => {
    it.each(['native', null])('preserves explicit native connected-service choice %s instead of inheriting', (connectedServices) => {
        expect(resolveRowlessExecutionRunStartOptions({
            choice, input: { permissionMode: 'read_only', connectedServices },
        })).toMatchObject({ ok: true, options: { connectedServices: null } });
    });

    it('preserves an explicit native model reset on first Send', () => {
        expect(resolveRowlessExecutionRunStartOptions({
            choice, input: { permissionMode: 'read_only', modelSelection: null },
        })).toMatchObject({ ok: true, options: { modelSelection: null } });
    });

    it.each(['connection-work', null])('preserves the exact model tuple for connection %s on first Send', (providerConnectionId) => {
        const modelSelection = { agentTargetKey: choice.targetKey, providerConnectionId, modelId: 'shared-model' };
        expect(resolveRowlessExecutionRunStartOptions({
            choice, input: { permissionMode: 'read_only', modelSelection },
        })).toMatchObject({ ok: true, options: { modelSelection } });
        expect(resolveRowlessExecutionRunStartOptions({
            choice, input: { permissionMode: 'read_only', modelId: ' shared-model ', modelSelection },
        })).toMatchObject({ ok: true, options: { modelId: 'shared-model', modelSelection } });
    });

    it('matches a retained target spelling to the current Agent without rewriting the model ref', () => {
        const modelSelection = { agentTargetKey: 'agent:codex', providerConnectionId: 'connection-work', modelId: 'shared-model' };
        expect(resolveRowlessExecutionRunStartOptions({
            choice, input: { permissionMode: 'read_only', modelSelection },
        })).toMatchObject({ ok: true, options: { modelSelection } });
    });

    it.each([
        { agentTargetKey: 'agent:claude', providerConnectionId: 'connection-work', modelId: 'shared-model' },
        { agentTargetKey: choice.targetKey, providerConnectionId: 'connection-work', modelId: 'other-model' },
        { agentTargetKey: choice.targetKey, modelId: 'shared-model' },
    ])('refuses an invalid or conflicting exact model selection %j before first Send', (modelSelection) => {
        expect(resolveRowlessExecutionRunStartOptions({
            choice, input: { permissionMode: 'read_only', modelId: 'shared-model', modelSelection },
        })).toEqual({ ok: false });
    });

    it('refuses competing Account and Team model selections before first Send', () => {
        expect(resolveRowlessExecutionRunStartOptions({
            choice,
            input: {
                permissionMode: 'read_only', modelId: 'shared-model',
                modelSelection: { agentTargetKey: choice.targetKey, providerConnectionId: 'connection-work', modelId: 'shared-model' },
                teamCredentialModel: {
                    kind: 'team_credential_provider_model', resourceId: 'resource-team', teamId: 'team-1',
                    expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: choice.targetKey, modelId: 'shared-model',
                },
            },
        })).toEqual({ ok: false });
    });

    it.each([true, false])('preserves the report chip value %s on first Send', (notifyParentOnCompletion) => {
        expect(resolveRowlessExecutionRunStartOptions({
            choice, input: { permissionMode: 'read_only', notifyParentOnCompletion },
        })).toMatchObject({ ok: true, options: { notifyParentOnCompletion } });
    });

    it('refuses a malformed report chip instead of silently dropping it', () => {
        expect(resolveRowlessExecutionRunStartOptions({
            choice, input: { permissionMode: 'read_only', notifyParentOnCompletion: 'false' },
        })).toEqual({ ok: false });
    });

    it('projects the selected target and canonical launcher options onto the direct first-Send start', () => {
        const result = resolveRowlessExecutionRunStartOptions({
            choice,
            input: {
                permissionMode: 'workspace_write',
                profileId: 'profile_work',
                profileSourceCustody: { kind: 'managed', immutableGenerationId: 'generation_2', installSource: 'archive' },
                modelId: 'gpt-5.6',
                configOptions: { reasoning_effort: 'high' },
                connectedServices: 'anthropic:team',
                connectedServicesByBackendTargetKey: { [choice.targetKey]: 'openai-codex:native' },
                secretReferenceOverlay: {
                    v: 1,
                    bindings: {
                        OPENAI_API_KEY: {
                            ref: 'happier:shared-secret:v1:secret-1',
                            revision: 7,
                        },
                    },
                },
                teamCredentialModel: {
                    kind: 'team_credential_provider_model',
                    resourceId: 'resource-team',
                    teamId: 'team-1',
                    expectedResourceRevision: 7,
                    deliveryMode: 'brokered',
                    agentTargetKey: choice.targetKey,
                    modelId: 'gpt-5.6',
                },
                teamCredentialSessionBindingConsent: {
                    v: 1,
                    sessionId: 'session-1',
                    teamId: 'team-1',
                    resourceId: 'resource-team',
                    expectedResourceRevision: 7,
                },
            },
        });

        expect(result).toEqual({
            ok: true,
            options: expect.objectContaining({
                backendTarget: choice.backendTarget,
                permissionMode: 'workspace_write',
                profileId: 'profile_work',
                profileSourceCustody: { kind: 'managed', immutableGenerationId: 'generation_2', installSource: 'archive' },
                modelId: 'gpt-5.6',
                sessionConfigOptionOverrides: expect.objectContaining({
                    v: 1,
                    overrides: expect.objectContaining({
                        reasoning_effort: expect.objectContaining({ value: 'high' }),
                    }),
                }),
                connectedServices: {
                    v: 2,
                    bindingsByServiceId: {
                        'happier.agent.codex/openai-codex': { source: 'native' },
                    },
                },
                secretReferenceOverlay: {
                    v: 1,
                    bindings: {
                        OPENAI_API_KEY: {
                            ref: 'happier:shared-secret:v1:secret-1',
                            revision: 7,
                        },
                    },
                },
                teamCredentialModel: {
                    kind: 'team_credential_provider_model',
                    resourceId: 'resource-team',
                    teamId: 'team-1',
                    expectedResourceRevision: 7,
                    deliveryMode: 'brokered',
                    agentTargetKey: choice.targetKey,
                    modelId: 'gpt-5.6',
                },
                teamCredentialSessionBindingConsent: {
                    v: 1,
                    sessionId: 'session-1',
                    teamId: 'team-1',
                    resourceId: 'resource-team',
                    expectedResourceRevision: 7,
                },
            }),
        });
        if (result.ok) {
            expect(result.options).not.toHaveProperty('configOptions');
            expect(result.options).not.toHaveProperty('connectedServicesByBackendTargetKey');
        }
    });

    it('fails closed on a conflicting config alias or incomplete profile selection', () => {
        expect(resolveRowlessExecutionRunStartOptions({
            choice,
            input: {
                permissionMode: 'workspace_write',
                configOptions: { reasoning_effort: 'high' },
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 1,
                    overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } },
                },
            },
        })).toEqual({ ok: false });
        expect(resolveRowlessExecutionRunStartOptions({
            choice,
            input: { permissionMode: 'workspace_write', profileId: 'profile_work' },
        })).toEqual({ ok: false });
        expect(resolveRowlessExecutionRunStartOptions({
            choice,
            input: {
                permissionMode: 'workspace_write',
                profileSourceCustody: { kind: 'managed', immutableGenerationId: 'generation_2', installSource: 'archive' },
            },
        })).toEqual({ ok: false });
    });

    it('fails closed when a previously selected target becomes unavailable', () => {
        expect(resolveRowlessExecutionRunStartOptions({
            choice: { ...choice, disabled: true },
            input: { permissionMode: 'workspace_write' },
        })).toEqual({ ok: false });
    });
});
