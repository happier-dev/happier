import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { presentSessionRouteChip, resolveSessionRoutePresentation } from './resolveSessionRoutePresentation';

describe('session route presentation', () => {
    it('names only the selected Provider credential and omits an auth-free selected route', async () => {
        const { projectProviderRouteSignInPurposes } = await import('./resolveSessionRoutePresentation');
        const route = resolveSessionRoutePresentation({ phase: 'draft',
            selection: { agentTargetKey: 'agent:claude', providerConnectionId: 'pc_selected', modelId: 'model' },
            native: { label: 'Native', authSource: 'native', connectedCount: 0 },
            sources: [{ connectionId: 'pc_selected', providerName: 'Gateway', connectionName: 'Work',
                connectionRole: 'named', connectionDisplayNameMode: 'custom' }],
        }).applied;
        const bindings = { account: { apiKey: 'ss-private-account-reference' } };
        expect(projectProviderRouteSignInPurposes({ route, machineId: 'machine', secretBindings: bindings }))
            .toEqual(['Gateway · Work']);
        expect(projectProviderRouteSignInPurposes({ route, machineId: 'machine', secretBindings: {} })).toEqual([]);
        expect(projectProviderRouteSignInPurposes({ route, machineId: 'machine', secretBindings: bindings,
            credentialSlotId: null })).toEqual([]);
        expect(JSON.stringify(projectProviderRouteSignInPurposes({ route, machineId: 'machine', secretBindings: bindings })))
            .not.toContain('ss-private-account-reference');
    });

    it('keeps the runtime-applied route separate from a requested restart change', () => {
        const actual = { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_now', modelId: 'same' };
        const next = { ...actual, providerConnectionId: 'pc_next' };
        const view = resolveSessionRoutePresentation({ phase: 'running', appliedSelection: actual,
            selection: next, transitionPending: true, native: { label: 'Personal', authSource: 'connected', connectedCount: 1 },
            sources: [
                { connectionId: 'pc_now', providerName: 'Provider', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
                { connectionId: 'pc_next', providerName: 'Provider', connectionName: 'Lab', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
            ] });
        expect(view.applied).toMatchObject({ kind: 'provider', connectionId: 'pc_now', sourceLabel: 'Provider · Work' });
        expect(view.pending).toMatchObject({ kind: 'provider', connectionId: 'pc_next', sourceLabel: 'Provider · Lab' });
    });

    it('preserves Team identity and never guesses native from unreadable applied state', () => {
        const selection = { source: 'team_resource' as const, teamId: 'team', resourceId: 'resource', expectedResourceRevision: 2,
            deliveryMode: 'brokered' as const, agentTargetKey: 'agent:codex', modelId: 'model' };
        const native = { label: 'Personal', authSource: 'connected' as const, connectedCount: 1 };
        expect(resolveSessionRoutePresentation({ phase: 'draft', selection, native }).applied)
            .toMatchObject({ kind: 'team', teamId: 'team', resourceId: 'resource', deliveryMode: 'brokered' });
        expect(resolveSessionRoutePresentation({ phase: 'running', selection, native }).applied.kind).toBe('unknown');
    });
    it('uses applied display evidence after a rename and keeps the requested source separate', () => {
        const selection = { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_a', modelId: 'model' };
        const current = { connectionId: 'pc_a', providerName: 'Provider', connectionName: 'Renamed',
            connectionRole: 'named' as const, connectionDisplayNameMode: 'custom' as const };
        const view = resolveSessionRoutePresentation({ phase: 'running', selection, appliedSelection: selection,
            transitionPending: true, sources: [current], appliedProviderSource: { ...current, connectionName: 'Work' },
            native: { label: 'Account pool', authSource: 'connected', connectedCount: 1 } });
        expect(view.applied).toMatchObject({ kind: 'provider', sourceLabel: 'Provider · Work' });
        expect(view.pending).toMatchObject({ kind: 'provider', sourceLabel: 'Provider · Renamed' });
        expect(resolveSessionRoutePresentation({ phase: 'draft', selection: null,
            native: { label: 'Account pool', authSource: 'connected', connectedCount: 1 } }).applied)
            .toMatchObject({ kind: 'native', sourceLabel: 'Account pool', authSource: 'connected' });
    });
    it('names the chip after the route that actually applies, and marks a requested change as pending', () => {
        const source = { connectionId: 'pc_a', providerName: 'DeepSeek', connectionName: 'DeepSeek',
            connectionRole: 'default' as const, connectionDisplayNameMode: 'automatic' as const };
        const pool = { label: 'Claude: Work pool', authSource: 'connected' as const };
        const provider = { agentTargetKey: 'agent:claude', providerConnectionId: 'pc_a', modelId: 'deepseek-v4' };
        const draft = resolveSessionRoutePresentation({ phase: 'draft', selection: provider, sources: [source],
            native: { ...pool, connectedCount: 1 } });
        expect(presentSessionRouteChip(draft, pool)).toEqual({ label: t('connectedServices.authChip.runsThrough', { source: 'DeepSeek' }), changePending: false });
        const nativeDraft = resolveSessionRoutePresentation({ phase: 'draft', selection: null, native: { ...pool, connectedCount: 1 } });
        expect(presentSessionRouteChip(nativeDraft, pool).label).toBe(t('connectedServices.authChip.runsThrough', { source: 'Claude: Work pool' }));
        expect(presentSessionRouteChip(nativeDraft, { label: 'Native', authSource: 'native' }).label)
            .toBe(t('connectedServices.authChip.runsThroughOwnSignIn'));
        const running = resolveSessionRoutePresentation({ phase: 'running', selection: provider, appliedSelection: null,
            transitionPending: true, sources: [source], native: { ...pool, connectedCount: 1 } });
        // Without applied evidence the chip keeps the incumbent label instead of guessing the route.
        expect(presentSessionRouteChip(running, pool)).toBeNull();
        const switching = resolveSessionRoutePresentation({ phase: 'running', selection: provider,
            appliedSelection: { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'opus' },
            transitionPending: true, sources: [source], native: { ...pool, connectedCount: 1 } });
        expect(presentSessionRouteChip(switching, pool)).toEqual({
            label: t('connectedServices.authChip.nowVia', { source: 'Claude: Work pool' }), changePending: true });
    });
});
