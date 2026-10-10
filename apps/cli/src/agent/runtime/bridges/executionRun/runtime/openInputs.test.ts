import { describe, expect, it } from 'vitest';
import { ProviderBoundModelRefSchema, buildBackendTargetKeyV2 } from '@happier-dev/protocol';

import { buildExecutionRunConfiguration, resolveExecutionRunChildSelection } from './openInputs';
import type { ExecutionRunAppliedParentSelection } from './openInputs';

const codexTarget = { kind: 'builtInAgent', agentId: 'codex' } as const;
const claudeTarget = { kind: 'builtInAgent', agentId: 'claude' } as const;
const providerSelection = ProviderBoundModelRefSchema.parse({
    agentTargetKey: 'agent:happier.agent.codex/codex',
    providerConnectionId: 'pc_applied',
    modelId: 'applied-model',
});
const appliedParent: ExecutionRunAppliedParentSelection = {
    status: 'applied', backendTarget: codexTarget,
    modelId: 'applied-model', modelSelection: providerSelection,
    connectedServices: {
        v: 2, bindingsByServiceId: {
            'happier.agent.codex/openai-codex': {
                source: 'connected', selection: 'group', groupId: 'parent-pool', profileId: 'rotated-member',
            },
        },
    },
};

describe('resolveExecutionRunChildSelection', () => {
    it('inherits applied route and pool identity, never the selected pool member', () => {
        expect(resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: appliedParent,
        })).toMatchObject({
            modelId: 'applied-model', modelSelection: providerSelection, selectionSource: 'inherited',
            connectedServices: { v: 2, bindingsByServiceId: {
                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'parent-pool' },
            } },
        });
        expect(resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: appliedParent,
        }).connectedServices?.bindingsByServiceId['happier.agent.codex/openai-codex']).not.toHaveProperty('profileId');
    });

    it('completes a partial explicit model using the applied source', () => {
        expect(resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: appliedParent, modelId: 'override-model',
        })).toMatchObject({ modelId: 'override-model', modelSelection: { ...providerSelection, modelId: 'override-model' }, selectionSource: 'explicit' });
    });

    it('honors explicit native without reading unavailable parent state', () => {
        expect(resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: { status: 'unavailable' },
            modelSelection: { ...providerSelection, providerConnectionId: null }, connectedServices: null,
        })).toMatchObject({ modelSelection: { ...providerSelection, providerConnectionId: null }, connectedServices: null, selectionSource: 'explicit' });
    });

    it('preserves explicit Workflow model null as native instead of inheriting the parent source', () => {
        const resolved = resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: appliedParent, modelSelection: null,
        });
        expect(resolved).toMatchObject({ selectionSource: 'explicit', inheritedFromDifferentAgent: false });
        expect(resolved.modelSelection).toBeUndefined();
        expect(resolved.modelId).toBeUndefined();
        expect(resolved.connectedServices).toBeUndefined();
    });

    it('explicit Workflow model null admits an explicit native model id without parent inheritance', () => {
        expect(resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: { status: 'unavailable' }, modelSelection: null, modelId: 'native-override',
        })).toMatchObject({ modelId: 'native-override', selectionSource: 'explicit' });
    });

    it('explicit native auth clears an inherited Provider route while retaining same-Agent model', () => {
        const resolved = resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: appliedParent, connectedServices: null,
        });
        expect(resolved).toMatchObject({ modelId: 'applied-model', connectedServices: null });
        expect(resolved.modelSelection?.providerConnectionId ?? null).toBeNull();
    });

    it.each(['independent', 'retained'] as const)('keeps %s choices independent of live parent edits', (lifecycle) => {
        const resolved = resolveExecutionRunChildSelection({ backendTarget: codexTarget, lifecycle, parent: appliedParent });
        expect(resolved.modelSelection).toBeUndefined();
        expect(resolved.modelId).toBeUndefined();
        expect(resolved.connectedServices).toBeUndefined();
    });

    it('preserves explicit Account-default requests without inheriting a parent pool', () => {
        const resolved = resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: appliedParent,
            connectedServicesDefaultServiceIds: ['happier.agent.codex/openai-codex'],
        });
        expect(resolved.connectedServices).toBeUndefined();
        expect(resolved.modelSelection).toBeUndefined();
        expect(resolved.modelId).toBe('applied-model');
    });

    it.each([
        { backendTarget: codexTarget, parent: { status: 'unavailable' } as const, code: 'execution_run_parent_selection_unavailable' },
        { backendTarget: claudeTarget, parent: appliedParent, code: 'execution_run_child_choice_required' },
    ])('requires an applied or explicit model for Account-default auth ($code)', ({ backendTarget, parent, code }) => {
        expect(() => resolveExecutionRunChildSelection({
            backendTarget, lifecycle: 'attached', parent,
            connectedServicesDefaultServiceIds: ['happier.agent.codex/openai-codex'],
        })).toThrow(expect.objectContaining({ code }));
    });

    it('permits a complete explicit model and Account-default auth without a parent', () => {
        expect(resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', modelId: 'native-model',
            connectedServicesDefaultServiceIds: ['happier.agent.codex/openai-codex'],
        })).toMatchObject({ modelId: 'native-model', selectionSource: 'explicit' });
    });

    it('refuses unavailable applied state instead of choosing defaults', () => {
        expect(() => resolveExecutionRunChildSelection({ backendTarget: codexTarget, lifecycle: 'attached', parent: { status: 'unavailable' } }))
            .toThrow(expect.objectContaining({ code: 'execution_run_parent_selection_unavailable' }));
    });

    it('refuses an omitted model when only native auth is explicit and applied model is unavailable', () => {
        expect(() => resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: { status: 'unavailable' }, connectedServices: null,
        })).toThrow(expect.objectContaining({ code: 'execution_run_parent_selection_unavailable' }));
    });

    it('does not choose another Agent native default when only its auth route is explicit', () => {
        expect(() => resolveExecutionRunChildSelection({
            backendTarget: claudeTarget, lifecycle: 'attached', parent: appliedParent, connectedServices: null,
        })).toThrow(expect.objectContaining({ code: 'execution_run_child_choice_required' }));
    });

    it('rematches an inherited Provider model for canonical admission on another Agent', () => {
        expect(resolveExecutionRunChildSelection({ backendTarget: claudeTarget, lifecycle: 'attached', parent: { ...appliedParent, connectedServices: null } }))
            .toMatchObject({ modelSelection: { ...providerSelection, agentTargetKey: 'agent:happier.agent.claude/claude' }, inheritedFromDifferentAgent: true });
    });

    it('requires an explicit choice rather than reinterpret native model and pool across Agents', () => {
        expect(() => resolveExecutionRunChildSelection({
            backendTarget: claudeTarget, lifecycle: 'attached', parent: { ...appliedParent, modelSelection: { ...providerSelection, providerConnectionId: null } },
        })).toThrow(expect.objectContaining({ code: 'execution_run_child_choice_required' }));
    });

    it('inherits native sign-in model without resolving a different Account pool', () => {
        expect(resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', parent: {
                ...appliedParent, modelSelection: { ...providerSelection, providerConnectionId: null }, connectedServices: null,
            },
        })).toMatchObject({ modelSelection: { ...providerSelection, providerConnectionId: null }, connectedServices: null });
    });

    it.each(['brokered', 'direct'] as const)('keeps Team %s inheritance under current child custody admission', (deliveryMode) => {
        const parent: ExecutionRunAppliedParentSelection = {
            status: 'applied', backendTarget: codexTarget, modelId: 'team-model', connectedServices: null,
            teamCredentialModel: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
                expectedResourceRevision: 2, agentTargetKey: providerSelection.agentTargetKey, modelId: 'team-model', deliveryMode },
        };
        if (deliveryMode === 'direct') {
            expect(() => resolveExecutionRunChildSelection({ backendTarget: codexTarget, lifecycle: 'attached', parent }))
                .toThrow(expect.objectContaining({ code: 'execution_run_child_choice_required' }));
        } else {
            expect(resolveExecutionRunChildSelection({ backendTarget: codexTarget, lifecycle: 'attached', parent }))
                .toMatchObject({ teamCredentialModel: parent.status === 'applied' ? parent.teamCredentialModel : undefined });
        }
    });

    it('rejects conflicting explicit target/model before inheritance', () => {
        expect(() => resolveExecutionRunChildSelection({ backendTarget: codexTarget, lifecycle: 'attached', modelSelection: providerSelection, modelId: 'different' }))
            .toThrow('does not match modelId');
    });

    it('rejects explicit native reset alongside an explicit Team model source', () => {
        expect(() => resolveExecutionRunChildSelection({
            backendTarget: codexTarget, lifecycle: 'attached', modelSelection: null,
            teamCredentialModel: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
                expectedResourceRevision: 2, agentTargetKey: providerSelection.agentTargetKey, modelId: 'team-model', deliveryMode: 'brokered' },
        })).toThrow('conflicting Provider and Team model selections');
    });
});

describe('buildExecutionRunConfiguration', () => {
    it('keeps hands-off independent of the delegation permission ceiling', () => {
        expect(buildExecutionRunConfiguration({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, permissionMode: 'yolo',
            workspaceWrites: 'deny', updatedAtMs: 1,
        }).configuration).toMatchObject({ workspaceWrites: 'deny', permissionIntent: { value: 'yolo' } });
    });

    it('builds a bounded configuration snapshot for the canonical qualified Provider selection', () => {
        const agentTargetKey = buildBackendTargetKeyV2({
            kind: 'agent',
            identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' },
        });
        expect(buildExecutionRunConfiguration({
            backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
            modelId: 'gpt-5.1-codex',
            modelSelection: ProviderBoundModelRefSchema.parse({
                agentTargetKey,
                providerConnectionId: 'pc_openai',
                modelId: 'gpt-5.1-codex',
            }),
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 7,
                overrides: {
                    reasoning_effort: { value: 'high', updatedAt: 7 },
                },
            },
            acpSessionModeId: 'plan',
            permissionMode: 'read_only',
            updatedAtMs: 11,
        })).toEqual({
            modelSelection: {
                agentTargetKey,
                providerConnectionId: 'pc_openai',
                modelId: 'gpt-5.1-codex',
            },
            configuration: {
                mode: { value: 'plan', updatedAtMs: 11 },
                model: { value: 'gpt-5.1-codex', updatedAtMs: 11 },
                permissionIntent: { value: 'read-only', updatedAtMs: 11 },
                options: {
                    reasoning_effort: { value: 'high', updatedAtMs: 7 },
                },
            },
        });
    });

    it.each([
        {
            label: 'Agent target',
            modelSelection: ProviderBoundModelRefSchema.parse({
                agentTargetKey: 'agent:happier.agent.claude/claude',
                providerConnectionId: 'pc_openai',
                modelId: 'gpt-5.1-codex',
            }),
            modelId: 'gpt-5.1-codex',
            message: 'does not target its backend',
        },
        {
            label: 'model',
            modelSelection: ProviderBoundModelRefSchema.parse({
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_openai',
                modelId: 'gpt-5.1-codex',
            }),
            modelId: 'different-model',
            message: 'does not match modelId',
        },
    ])('rejects a split-brain $label before Provider authorization', ({
        modelSelection,
        modelId,
        message,
    }) => {
        expect(() => buildExecutionRunConfiguration({
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            modelSelection,
            modelId,
            permissionMode: 'default',
            updatedAtMs: 1,
        })).toThrow(message);
    });
});
