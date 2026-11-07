import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';
import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/selection/v1';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import { applyTeamProjection, resetTeamsSnapshotsForTests } from '@/sync/store/teams/teamsSnapshots';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createTeamAddress } from '@/sync/domains/teams/teamAddress';
import { teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { readManagedSessionDefaults } from '@/sync/ops/teams/managedSessionDefaults';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';

import { useNewSessionAgentAuthoringOptionsState } from './useNewSessionAgentAuthoringOptionsState';

function nativeSelection(agentTargetKey: string, modelId: string, updatedAt: number) {
    return SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt,
        ref: { agentTargetKey, providerConnectionId: null, modelId },
    });
}

describe('useNewSessionAgentAuthoringOptionsState', () => {
    it('reads pushed Team model defaults without settings writes, retains explicit choices, and honors policy locks', async () => {
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        const scope = createServerAccountScope('home-a', 'member-a')!;
        const address = createTeamAddress('home-a', 'team-a')!;
        const publish = (modelId: string) => applyTeamProjection({ scope, address, observedAt: 1,
            team: teamSummaryFixture({ policy: teamPolicyFixture({ managedDefaultsStatus: 'available',
                managedDefaults: { team: { modelByAgentTargetKey: { [agentTargetKey]: nativeSelection(agentTargetKey, modelId, 1) } }, groups: {} },
            }) }),
        });
        const read = () => readManagedSessionDefaults({ serverId: 'home-a', teamId: 'team-a', memberAccountId: 'member-a', agentTargetKey });
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const props: Props = { agentType: 'claude', backendTargetKey: agentTargetKey,
            hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null };
        publish('haiku');
        const storageWrite = vi.spyOn(getPersistenceStorage(), 'set');
        const hook = await renderHook(useNewSessionAgentAuthoringOptionsState, {
            initialProps: { ...props, managedDefaults: read().context },
        });
        try {
            expect(hook.getCurrent().modelSelection?.ref.modelId).toBe('haiku');
            expect(hook.getCurrent().modelIsManagedDefault).toBe(true);
            expect(hook.getCurrent().modelSelectionForPersistence).toBeUndefined();
            publish('sonnet');
            await hook.rerender({ ...props, managedDefaults: read().context });
            expect(hook.getCurrent().modelSelection?.ref.modelId).toBe('sonnet');
            act(() => { hook.getCurrent().setModelSelection(nativeSelection(agentTargetKey, 'opus', 2)); });
            expect(hook.getCurrent().modelSelection?.ref.modelId).toBe('opus');
            expect(hook.getCurrent().modelIsManagedDefault).toBe(false);
            expect(hook.getCurrent().modelSelectionForPersistence?.ref.modelId).toBe('opus');
            publish('haiku');
            await hook.rerender({ ...props, managedDefaults: read().context });
            expect(hook.getCurrent().modelSelection?.ref.modelId).toBe('opus');
            const managedDefaults = { ...read().context, policyDefaults: { organization: 'Example', locked: true,
                values: { modelByAgentTargetKey: { [agentTargetKey]: nativeSelection(agentTargetKey, 'sonnet', 3) } } } };
            await hook.rerender({ ...props, managedDefaults });
            expect(hook.getCurrent().modelSelection?.ref.modelId).toBe('sonnet');
            expect(hook.getCurrent().modelIsManagedDefault).toBe(true);
            expect(hook.getCurrent().modelSelectionForPersistence?.ref.modelId).toBe('opus');
            act(() => { hook.getCurrent().setModelSelection(nativeSelection(agentTargetKey, 'haiku', 4)); });
            expect(hook.getCurrent().modelSelection?.ref.modelId).toBe('sonnet');
            expect(hook.getCurrent().modelSelectionForPersistence?.ref.modelId).toBe('haiku');
            expect(storageWrite).toHaveBeenCalledTimes(0);
        } finally { await hook.unmount(); storageWrite.mockRestore(); resetTeamsSnapshotsForTests(); }
    });

    it('keeps a managed Team V2 source when a personal V1 fallback cannot represent it', async () => {
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        const selection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 1, ref: {
            source: 'team_resource', teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
            deliveryMode: 'brokered', agentTargetKey, modelId: 'team-model',
        } });
        const hook = await renderHook(useNewSessionAgentAuthoringOptionsState, { initialProps: {
            agentType: 'claude', backendTargetKey: agentTargetKey,
            hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: { v: 1 as const, updatedAt: 1, modelSelection: nativeSelection(agentTargetKey, 'haiku', 1),
                acpSessionModeId: null, sessionConfigOptionOverrides: null },
            managedDefaults: { teamDefaults: { team: { modelByAgentTargetKey: { [agentTargetKey]: selection } }, groups: {} } },
        } });
        try {
            expect(hook.getCurrent().modelMode).toBe('team-model');
            expect(hook.getCurrent().modelSelection).toBeNull();
            expect(hook.getCurrent().modelSelectionV2).toEqual(selection);
            expect(hook.getCurrent().teamCredentialModel).toMatchObject({ teamId: 'team-a', resourceId: 'resource-a', modelId: 'team-model' });
        } finally { await hook.unmount(); }
    });

    it('retains accepted native references through managed and explicitly chosen Team model projections', async () => {
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        const nativeDelivery = { managedId: 'managed', controllerInstallationId: 'controller', guestInstallationId: 'guest',
            bindingKey: 'binding', placeholderRef: 'reference', sourceRevision: 'source:1', providerTicket: 'a'.repeat(43) };
        const selection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 1, ref: {
            source: 'team_resource', teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
            deliveryMode: 'vendor-native', agentTargetKey, modelId: 'team-model', nativeDelivery,
        } });
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const props: Props = { agentType: 'claude', backendTargetKey: agentTargetKey,
            hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null };
        const initialProps: Props = { ...props,
            managedDefaults: { teamDefaults: { team: { modelByAgentTargetKey: { [agentTargetKey]: selection } }, groups: {} } },
        };
        const hook = await renderHook(useNewSessionAgentAuthoringOptionsState, { initialProps });
        try {
            expect(hook.getCurrent().teamCredentialModel?.nativeDelivery).toEqual(nativeDelivery);
            await hook.rerender({ ...props, explicitTeamCredentialModel: { kind: 'team_credential_provider_model',
                teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 7,
                deliveryMode: 'vendor-native', agentTargetKey, modelId: 'team-model', nativeDelivery,
            } });
            expect(hook.getCurrent().modelSelectionV2?.ref).toMatchObject({ source: 'team_resource', nativeDelivery });
            expect(hook.getCurrent().modelSelectionForPersistence).toMatchObject({ v: 2, ref: { source: 'team_resource', nativeDelivery } });
            expect(hook.getCurrent().teamCredentialModel?.nativeDelivery).toEqual(nativeDelivery);
        } finally { await hook.unmount(); }
    });

    it.each(['mode', 'selection'] as const)('keeps explicit native Automatic null while overriding unlocked defaults through %s', async (intent) => {
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        const hook = await renderHook(useNewSessionAgentAuthoringOptionsState, { initialProps: {
            agentType: 'claude', backendTargetKey: agentTargetKey,
            hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null,
            managedDefaults: { teamDefaults: { team: { modelByAgentTargetKey: {
                [agentTargetKey]: nativeSelection(agentTargetKey, 'sonnet', 1),
            } }, groups: {} } },
        } });
        try {
            act(() => { if (intent === 'mode') hook.getCurrent().setModelMode('default');
                else hook.getCurrent().setModelSelection(null); });
            expect(hook.getCurrent().modelMode).toBe('default');
            expect(hook.getCurrent().modelSelection).toBeNull();
        } finally { await hook.unmount(); }
    });
    it('uses the selected target without probing a bundled fallback on unrelated renders', async () => {
        const parses = vi.spyOn(AgentExecutionTargetV1Schema, 'safeParse');
        const targetKey = 'agent:acme.review/reviewer';
        const props = { agentType: 'claude', backendTargetKey: targetKey,
            hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: null };
        const hook = await renderHook(useNewSessionAgentAuthoringOptionsState, { initialProps: props });
        try {
            act(() => { hook.getCurrent().setModelMode('review-model'); });
            expect(hook.getCurrent().modelSelection?.ref.agentTargetKey).toBe(targetKey);
            for (let index = 0; index < 3; index++) await hook.rerender({ ...props });
            expect(parses.mock.calls.filter(([value]) => value && typeof value === 'object'
                && 'kind' in value && value.kind === 'backend')).toHaveLength(0);
            await hook.rerender({ ...props, backendTargetKey: 'agent:acme.other/reviewer' });
            act(() => { hook.getCurrent().setModelMode('other-model'); });
            expect(hook.getCurrent().modelSelection?.ref.agentTargetKey).toBe('agent:acme.other/reviewer');
        } finally { await hook.unmount(); parses.mockRestore(); }
    });
    it('hydrates late draft engine options for the already selected target and keeps edits on unrelated updates', async () => {
        const agentTargetKey = 'agent:happier.agent.claude/claude';
        const draft = {
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: nativeSelection(agentTargetKey, 'haiku', 123),
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: { v: 1, updatedAt: 123, overrides: {
                speed: { updatedAt: 123, value: 'fast' },
            } },
            capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
        } satisfies NonNullable<Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0]['hydratedPersistedAuthoringDraft']>;
        const props = (persisted: typeof draft | null) => ({
            agentType: 'claude', backendTargetKey: agentTargetKey, hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: persisted, rememberedEngineSelection: null,
        });
        const hook = await renderHook((input: ReturnType<typeof props>) => useNewSessionAgentAuthoringOptionsState(input),
            { initialProps: props(null) });
        await hook.rerender(props(draft));
        expect(hook.getCurrent()).toMatchObject({ modelMode: 'haiku', modelSelection: draft.modelSelection,
            acpSessionModeId: 'plan', sessionConfigOptionOverrides: draft.sessionConfigOptionOverrides,
            capabilitySelection: draft.capabilitySelection });
        act(() => { hook.getCurrent().setModelMode('sonnet'); });
        await hook.rerender(props({ ...draft, sessionConfigOptionOverrides: { ...draft.sessionConfigOptionOverrides, updatedAt: 124 } }));
        expect(hook.getCurrent().modelMode).toBe('sonnet');
        const editedSelection = hook.getCurrent().modelSelection;
        if (!editedSelection) throw new Error('Expected the edited model selection');
        await hook.rerender(props({ ...draft, modelSelection: editedSelection,
            sessionConfigOptionOverrides: { ...draft.sessionConfigOptionOverrides, updatedAt: 124 } }));
        expect(hook.getCurrent().modelSelection).toBe(editedSelection);
        await hook.unmount();
    });

    it('keeps pending model edits when same-target draft hydration arrives', async () => {
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const targetKey = 'agent:happier.agent.claude/claude';
        const props = (draft: Props['hydratedPersistedAuthoringDraft']): Props => ({
            agentType: 'claude', backendTargetKey: targetKey,
            hydratedTempAuthoringDraft: null, hydratedPersistedAuthoringDraft: draft,
        });
        const hook = await renderHook(useNewSessionAgentAuthoringOptionsState, { initialProps: props(null) });
        act(() => { hook.getCurrent().setModelSelection(nativeSelection(targetKey, 'sonnet', 321)); });
        const editedSelection = hook.getCurrent().modelSelection;
        const remembered = {
            v: 1, modelSelection: editedSelection, acpSessionModeId: null,
            sessionConfigOptionOverrides: null, updatedAt: 321,
        } satisfies NonNullable<Props['rememberedEngineSelection']>;
        // The screen's real picker setter remembers the choice before the late
        // draft arrives; that echo must not make the explicit edit unprotected.
        await hook.rerender({ ...props(null), rememberedEngineSelection: remembered });
        await hook.rerender({ ...props({
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            modelSelection: nativeSelection(targetKey, 'haiku', 123),
            acpSessionModeId: 'plan',
        }), rememberedEngineSelection: remembered });
        expect(hook.getCurrent().modelSelection).toBe(editedSelection);
        expect(hook.getCurrent().acpSessionModeId).toBe('plan');
        await hook.unmount();
    });

    it('reconciles config overrides for a backend target switch without a passive follow-up commit', async () => {
        const commitPhases: string[] = [];
        const wrapper = (props: React.PropsWithChildren) => (
            <React.Profiler
                id="authoring-options"
                onRender={(_id, phase) => {
                    commitPhases.push(phase);
                }}
            >
                {props.children}
            </React.Profiler>
        );
        const buildProps = (agentType: AgentId, value: string | null) => ({
            agentType,
            backendTargetKey: `agent:happier.agent.${agentType}/${agentType}`,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: value === null ? null : {
                agentTarget: {
                    kind: 'agent' as const,
                    identity: { pluginId: `happier.agent.${agentType}`, localId: agentType },
                },
                sessionConfigOptionOverrides: {
                    v: 1 as const,
                    updatedAt: 123,
                    overrides: {
                        service_tier: { updatedAt: 123, value },
                    },
                },
            },
            rememberedEngineSelection: null,
        });
        const hook = await renderHook(
            (props: ReturnType<typeof buildProps>) => useNewSessionAgentAuthoringOptionsState(props),
            { initialProps: buildProps('codex', 'fast'), wrapper },
        );
        commitPhases.length = 0;

        await hook.rerender(buildProps('opencode', null));

        expect(commitPhases).toEqual(['update']);
        expect(hook.getCurrent().sessionConfigOptionOverrides).toBeNull();
    });

    it('keeps an unbacked external Agent model control neutral', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'acme.review.backend',
            backendTargetKey: 'backend:acme.review.backend',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe('default');
        expect(hook.getCurrent().modelSelection).toBeNull();
    });

    it('preserves a provider-bound draft selection instead of reconstructing it as native', async () => {
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: 'agent:happier.agent.claude/claude',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'provider/claude-sonnet',
            },
        });
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude',
            backendTargetKey: 'agent:happier.agent.claude/claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                modelSelection,
            },
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe('provider/claude-sonnet');
        expect(hook.getCurrent().modelSelection).toEqual(modelSelection);
    });

    it('preserves a provider-bound model literally named default instead of treating it as Automatic', async () => {
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: 'agent:happier.agent.opencode/opencode',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'default',
            },
        });
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'opencode',
            backendTargetKey: 'agent:happier.agent.opencode/opencode',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } },
                modelSelection,
            },
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe('default');
        expect(hook.getCurrent().modelSelection).toEqual(modelSelection);
    });

    it('seeds model, session mode, and config options from a remembered engine selection when no draft exists', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude',
            backendTargetKey: 'agent:happier.agent.claude/claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: {
                v: 1,
                modelSelection: nativeSelection('agent:happier.agent.claude/claude', 'claude-sonnet-4-5', 123),
                acpSessionModeId: 'plan',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 123,
                    overrides: {
                        reasoning_effort: {
                            updatedAt: 123,
                            value: 'high',
                        },
                    },
                },
                updatedAt: 123,
            },
        } as any));

        expect(hook.getCurrent().modelMode).toBe('claude-sonnet-4-5');
        expect(hook.getCurrent().acpSessionModeId).toBe('plan');
        expect(hook.getCurrent().sessionConfigOptionOverrides).toEqual({
            v: 1,
            updatedAt: 123,
            overrides: {
                reasoning_effort: {
                    updatedAt: 123,
                    value: 'high',
                },
            },
        });
    });

    it('seeds a remembered dynamic backend model even when the static catalog is stale', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'codex',
            backendTargetKey: 'agent:happier.agent.codex/codex',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: {
                v: 1,
                modelSelection: nativeSelection('agent:happier.agent.codex/codex', 'gpt-5.5', 123),
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                updatedAt: 123,
            },
        } as any));

        expect(hook.getCurrent().modelMode).toBe('gpt-5.5');
    });

    it('rejects stale persisted freeform models that do not match constrained provider prefixes', async () => {
        const geminiTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' } } as const;
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'gemini',
            backendTargetKey: resolveBackendTargetKeyV2(geminiTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' } },
                modelId: 'gpt-5.5',
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
            },
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe(getAgentCore('gemini')!.model?.defaultMode);
        expect(hook.getCurrent().modelMode).not.toBe('gpt-5.5');
    });

    it('keeps explicit persisted draft values ahead of remembered engine selections', async () => {
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                modelId: 'persisted-model',
                acpSessionModeId: 'persisted-mode',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 456,
                    overrides: {
                        speed: {
                            updatedAt: 456,
                            value: 'fast',
                        },
                    },
                },
            },
            rememberedEngineSelection: {
                v: 1,
                modelSelection: nativeSelection('agent:happier.agent.claude/claude', 'remembered-model', 123),
                acpSessionModeId: 'remembered-mode',
                sessionConfigOptionOverrides: {
                    v: 1,
                    updatedAt: 123,
                    overrides: {
                        reasoning_effort: {
                            updatedAt: 123,
                            value: 'high',
                        },
                    },
                },
                updatedAt: 123,
            },
        } as any));

        expect(hook.getCurrent().modelMode).toBe('persisted-model');
        expect(hook.getCurrent().acpSessionModeId).toBe('persisted-mode');
        expect(hook.getCurrent().sessionConfigOptionOverrides).toEqual({
            v: 1,
            updatedAt: 456,
            overrides: {
                speed: {
                    updatedAt: 456,
                    value: 'fast',
                },
            },
        });
    });

    it('uses implicit profile model intent after explicit drafts but before remembered selection', async () => {
        const profileSelection = SessionModelSelectionV1Schema.parse({
            v: 1, updatedAt: 200,
            ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc_profile', modelId: 'profile-model' },
        });
        const implicitHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude', backendTargetKey: 'agent:happier.agent.claude/claude',
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            implicitProfileModelSelection: profileSelection,
            rememberedEngineSelection: {
                v: 1, modelSelection: nativeSelection('agent:happier.agent.claude/claude', 'remembered-model', 100),
                acpSessionModeId: null, sessionConfigOptionOverrides: null, updatedAt: 100,
            },
        }));
        expect(implicitHook.getCurrent().modelSelection).toEqual(profileSelection);

        const explicitSelection = nativeSelection('agent:happier.agent.claude/claude', 'draft-model', 300);
        const explicitHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'claude', backendTargetKey: 'agent:happier.agent.claude/claude',
            hydratedTempAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
                modelSelection: explicitSelection,
            },
            hydratedPersistedAuthoringDraft: null,
            implicitProfileModelSelection: profileSelection,
            rememberedEngineSelection: null,
        }));
        expect(explicitHook.getCurrent().modelSelection).toEqual(explicitSelection);
    });

    it('applies implicit profile model intent only to the target it names when the person picks another Agent', async () => {
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const codexTargetKey = 'agent:happier.agent.codex/codex';
        const claudeTargetKey = 'agent:happier.agent.claude/claude';
        // Live repro (repo-dev, 2026-11-06): a Codex launch profile pinned an OpenRouter model;
        // choosing Claude in the Agent chip crashed New Session with "target mismatch".
        const profileSelection = SessionModelSelectionV1Schema.parse({
            v: 1, updatedAt: 200,
            ref: { agentTargetKey: codexTargetKey, providerConnectionId: 'pc_profile', modelId: 'openrouter/free' },
        });
        const remembered = nativeSelection(claudeTargetKey, 'remembered-claude', 100);
        const buildProps = (agentType: AgentId, backendTargetKey: string): Props => ({
            agentType, backendTargetKey,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            implicitProfileModelSelection: profileSelection,
            rememberedEngineSelection: backendTargetKey === claudeTargetKey
                ? { v: 1, modelSelection: remembered, acpSessionModeId: null, sessionConfigOptionOverrides: null, updatedAt: 100 }
                : null,
        });
        const hook = await renderHook((props: Props) => useNewSessionAgentAuthoringOptionsState(props),
            { initialProps: buildProps('codex', codexTargetKey) });
        try {
            expect(hook.getCurrent().modelSelection).toEqual(profileSelection);
            await hook.rerender(buildProps('claude', claudeTargetKey));
            expect(hook.getCurrent().modelSelection).toEqual(remembered);
            expect(hook.getCurrent().modelMode).toBe('remembered-claude');
        } finally { await hook.unmount(); }
    });

    it('can stage an exact provider selection for a profile-preferred backend before that backend renders', async () => {
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const claudeTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' });
        const codexTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: 'codex' });
        const profileSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 200,
            ref: {
                agentTargetKey: claudeTargetKey,
                providerConnectionId: 'pc_profile',
                modelId: 'profile-model',
            },
        });
        const buildProps = (agentType: AgentId): Props => ({
            agentType,
            backendTargetKey: resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentType }),
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection: null,
        });
        const hook = await renderHook(
            (props: Props) => useNewSessionAgentAuthoringOptionsState(props),
            { initialProps: buildProps('codex') },
        );

        await act(async () => {
            hook.getCurrent().setModelSelectionForBackendTarget(claudeTargetKey, profileSelection);
        });
        // A current-target draft may arrive before the profile's preferred
        // target renders. It must hydrate Codex without dropping staged Claude.
        await hook.rerender({
            ...buildProps('codex'),
            hydratedPersistedAuthoringDraft: {
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                modelSelection: nativeSelection(codexTargetKey, 'gpt-5.5', 123),
            },
        });
        expect(hook.getCurrent().modelMode).toBe('gpt-5.5');
        await hook.rerender(buildProps('claude'));

        expect(hook.getCurrent().modelSelection).toEqual(profileSelection);
        expect(hook.getCurrent().modelMode).toBe('profile-model');
        expect(codexTargetKey).not.toBe(claudeTargetKey);
    });

    it('reconciles model and config state when the selected backend changes without picker setters', async () => {
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const buildProps = (
            agentType: AgentId,
            rememberedEngineSelection: Props['rememberedEngineSelection'],
        ): Props => ({
            agentType,
            backendTargetKey: resolveBackendTargetKeyV2({
                kind: 'agent',
                identity: { pluginId: `happier.agent.${agentType}`, localId: agentType },
            }),
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: null,
            rememberedEngineSelection,
        });

        const hook = await renderHook(
            (props: Props) => useNewSessionAgentAuthoringOptionsState(props),
            {
                initialProps: buildProps('codex', {
                    v: 1,
                    modelSelection: SessionModelSelectionV1Schema.parse({
                        v: 1,
                        updatedAt: 123,
                        ref: {
                            agentTargetKey: 'agent:happier.agent.codex/codex',
                            providerConnectionId: null,
                            modelId: 'gpt-5.5',
                        },
                    }),
                    acpSessionModeId: 'plan',
                    sessionConfigOptionOverrides: {
                        v: 1,
                        updatedAt: 123,
                        overrides: {
                            reasoning_effort: {
                                updatedAt: 123,
                                value: 'high',
                            },
                        },
                    },
                    updatedAt: 123,
                }),
            },
        );

        expect(hook.getCurrent().modelMode).toBe('gpt-5.5');
        expect(hook.getCurrent().acpSessionModeId).toBe('plan');
        expect(hook.getCurrent().sessionConfigOptionOverrides).not.toBeNull();

        await hook.rerender(buildProps('opencode', null));

        expect(hook.getCurrent().modelMode).toBe(getAgentCore('opencode')!.model?.defaultMode);
        expect(hook.getCurrent().modelMode).not.toBe('gpt-5.5');
        expect(hook.getCurrent().acpSessionModeId).toBeNull();
        expect(hook.getCurrent().sessionConfigOptionOverrides).toBeNull();
    });

    it('rekeys a persisted legacy backend-keyed model selection onto the canonical Agent target', async () => {
        const codexTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const canonicalKey = resolveBackendTargetKeyV2(codexTarget);
        const hook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'codex',
            backendTargetKey: canonicalKey,
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: {
                agentTarget: codexTarget,
                modelSelection: nativeSelection('agent:happier.agent.codex/codex', 'gpt-5.5', 42),
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
            },
            rememberedEngineSelection: null,
        }));

        expect(hook.getCurrent().modelMode).toBe('gpt-5.5');
        expect(hook.getCurrent().modelSelection?.ref.agentTargetKey).toBe(canonicalKey);
        expect(hook.getCurrent().modelSelection?.ref.modelId).toBe('gpt-5.5');
    });

    it('ignores persisted draft engine state when the selected backend target differs', async () => {
        const codexTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const opencodeTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.opencode', localId: 'opencode' } } as const;
        const persistedCodexDraft = {
            agentTarget: codexTarget,
            modelId: 'gpt-5.5',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 123,
                overrides: {
                    reasoning_effort: {
                        updatedAt: 123,
                        value: 'high',
                    },
                },
            },
        } as const;

        const matchingHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'codex',
            backendTargetKey: resolveBackendTargetKeyV2(codexTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: persistedCodexDraft,
            rememberedEngineSelection: null,
        }));

        expect(matchingHook.getCurrent().modelMode).toBe('gpt-5.5');
        expect(matchingHook.getCurrent().acpSessionModeId).toBe('plan');
        expect(matchingHook.getCurrent().sessionConfigOptionOverrides).toEqual(persistedCodexDraft.sessionConfigOptionOverrides);

        const mismatchedHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'opencode',
            backendTargetKey: resolveBackendTargetKeyV2(opencodeTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: persistedCodexDraft,
            rememberedEngineSelection: null,
        }));

        expect(mismatchedHook.getCurrent().modelMode).toBe(getAgentCore('opencode')!.model?.defaultMode);
        expect(mismatchedHook.getCurrent().modelMode).not.toBe('gpt-5.5');
        expect(mismatchedHook.getCurrent().acpSessionModeId).toBeNull();
        expect(mismatchedHook.getCurrent().sessionConfigOptionOverrides).toBeNull();
    });

    it('ignores a targetless draft instead of inferring retired Agent identity fields', async () => {
        const codexTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const geminiTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' } } as const;
        const legacyCodexDraft = {
            agentId: 'codex',
            modelId: 'gpt-5.5',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 123,
                overrides: {
                    reasoning_effort: {
                        updatedAt: 123,
                        value: 'high',
                    },
                },
            },
        } as const;

        const matchingHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'codex',
            backendTargetKey: resolveBackendTargetKeyV2(codexTarget),
            allowTargetlessDraftEngineSelection: true,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: legacyCodexDraft,
            rememberedEngineSelection: null,
        }));

        expect(matchingHook.getCurrent().modelMode).toBe(getAgentCore('codex')!.model?.defaultMode);
        expect(matchingHook.getCurrent().acpSessionModeId).toBeNull();

        const mismatchedHook = await renderHook(() => useNewSessionAgentAuthoringOptionsState({
            agentType: 'gemini',
            backendTargetKey: resolveBackendTargetKeyV2(geminiTarget),
            allowTargetlessDraftEngineSelection: true,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: legacyCodexDraft,
            rememberedEngineSelection: {
                v: 1,
                modelSelection: SessionModelSelectionV1Schema.parse({
                    v: 1,
                    updatedAt: 456,
                    ref: {
                        agentTargetKey: 'agent:happier.agent.gemini/gemini',
                        providerConnectionId: null,
                        modelId: 'gemini-2.5-pro',
                    },
                }),
                acpSessionModeId: null,
                sessionConfigOptionOverrides: null,
                updatedAt: 456,
            },
        }));

        expect(mismatchedHook.getCurrent().modelMode).toBe('gemini-2.5-pro');
        expect(mismatchedHook.getCurrent().modelMode).not.toBe('gpt-5.5');
        expect(mismatchedHook.getCurrent().acpSessionModeId).toBeNull();
        expect(mismatchedHook.getCurrent().sessionConfigOptionOverrides).toBeNull();
    });

    it('reconciles mcp selection from target-scoped drafts when the selected backend changes', async () => {
        const claudeTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
        const codexTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
        const codexDraft = {
            agentTarget: codexTarget,
            modelId: null,
            acpSessionModeId: null,
            sessionConfigOptionOverrides: null,
            capabilitySelection: { mcp: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-codex'],
                forceExcludeServerIds: ['server-claude'],
            } },
        } as const;
        type Props = Parameters<typeof useNewSessionAgentAuthoringOptionsState>[0];
        const buildProps = (
            agentType: AgentId,
            backendTarget: typeof claudeTarget | typeof codexTarget,
        ): Props => ({
            agentType,
            backendTargetKey: resolveBackendTargetKeyV2(backendTarget),
            allowTargetlessDraftEngineSelection: false,
            hydratedTempAuthoringDraft: null,
            hydratedPersistedAuthoringDraft: codexDraft,
            rememberedEngineSelection: null,
        });

        const hook = await renderHook(
            (props: Props) => useNewSessionAgentAuthoringOptionsState(props),
            { initialProps: buildProps('claude', claudeTarget) },
        );

        expect(hook.getCurrent().capabilitySelection).toEqual({});

        await hook.rerender(buildProps('codex', codexTarget));

        expect(hook.getCurrent().capabilitySelection).toEqual(codexDraft.capabilitySelection);
    });
});
