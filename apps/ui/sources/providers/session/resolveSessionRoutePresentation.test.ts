import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { ConnectedAccountSessionModelRefV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import { projectMachineAgent, projectMachineAgentForCredential } from '@/agents/machineAgents/machineAgentModel';
import { createProviderModelProjectionGroupFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { resolveSelectedProviderRoute } from './resolveSelectedProviderRoute';
import { presentArmedSessionRouteSource, presentNativeRouteSourceLabel, presentSessionRouteChip, presentSessionRouteSource, resolveSessionRoutePresentation } from './resolveSessionRoutePresentation';

describe('session route presentation', () => {
    it('names and admits the projected Connected Account route for the exact endpoint and model', () => {
        const selection = ConnectedAccountSessionModelRefV2Schema.parse({
            source: 'connected_account', agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'anthropic/test-model',
            purpose: { consumer: { pluginId: 'happier.provider.vercel-ai-gateway', localId: 'vercel-ai-gateway' }, purpose: 'model-inference' },
            endpointTemplateId: 'vercel-anthropic',
        });
        const target = { kind: 'account', account: { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'work' } } as const;
        const source = createProviderModelProjectionGroupFixture({
            connectionId: 'connected-source:vercel-work',
            connectedAccountTarget: target, providerName: 'Vercel AI Gateway', connectionName: 'Vercel work',
            suppressedConnectedServiceIds: ['happier.agent.claude/claude-subscription'],
            connectionRole: 'named', connectionDisplayNameMode: 'custom',
            rows: [{ ref: selection, descriptor: { id: selection.modelId, name: 'Test model' },
                gatewaySlots: [{ purpose: selection.purpose, target }],
                sources: { manual: false, static: true, probe: false }, confidence: 'verified_static',
                compatibility: { result: { status: 'verified', selectedProtocol: 'anthropic', evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-07-12' } },
                    compatibilityFingerprint: 'compatibility:v1:vercel-work', confirmed: true },
                endpointHealth: 'available', catalog: { stale: false }, loadState: 'loaded', visibility: 'visible' }],
        });
        expect(resolveSessionRoutePresentation({ phase: 'draft', selection,
            native: { label: 'Native', authSource: 'native', connectedCount: 0 }, sources: [source] }).applied)
            .toMatchObject({ sourceLabel: 'Vercel AI Gateway · Vercel work' });
        const input = { selection, agentTargetKey: selection.agentTargetKey, providerSources: [source],
            declarationContext: { kind: 'account' }, acceptedConnectedServiceIds: ['happier.agent.claude/claude-subscription'] } as const;
        const providerRoute = resolveSelectedProviderRoute(input);
        expect(providerRoute).toMatchObject({ ready: true });
        const signedOutAgent = projectMachineAgent({ agentId: 'claude', title: 'Claude', checking: false, stale: false, job: null,
            connectedServices: [], facts: { agentId: 'claude', title: 'Claude', installed: true, version: '1', latestVersion: null,
                update: { supported: false, command: null }, signIn: { status: 'signedOut', loginSupport: 'login_terminal' },
                platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] } });
        expect(projectMachineAgentForCredential(signedOutAgent, { modelRef: selection, providerRoute,
            credentialBindings: { v: 2, bindingsByServiceId: { 'happier.machine.vercel/vercel-account': {
                source: 'connected', selection: 'profile', profileId: 'work',
            } } },
        })).toMatchObject({ state: 'ready', signIn: { status: 'signedOut' } });
        expect(resolveSelectedProviderRoute({ ...input, selection: { ...selection, endpointTemplateId: 'vercel-chat' } }))
            .toMatchObject({ ready: false });
    });

    it('names a same-name source once in the model picker route', () => {
        expect(resolveSessionRoutePresentation({ phase: 'draft',
            selection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:codex', providerConnectionId: 'pc_a', modelId: 'model' }),
            native: { label: 'Native', authSource: 'native', connectedCount: 0 },
            sources: [{ connectionId: 'pc_a', providerName: 'QA custom live', connectionName: ' qa custom live ',
                connectionRole: 'named', connectionDisplayNameMode: 'custom' }],
        }).applied).toMatchObject({ sourceLabel: 'QA custom live' });
    });
    it('names only the selected Provider credential and omits an auth-free selected route', async () => {
        const { projectProviderRouteSignInPurposes } = await import('./resolveSessionRoutePresentation');
        const route = resolveSessionRoutePresentation({ phase: 'draft',
            selection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:claude', providerConnectionId: 'pc_selected', modelId: 'model' }),
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
        const actual = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:codex', providerConnectionId: 'pc_now', modelId: 'same' });
        const next = ProviderBoundModelRefSchema.parse({ ...actual, providerConnectionId: 'pc_next' });
        const view = resolveSessionRoutePresentation({ phase: 'running', appliedSelection: actual,
            selection: next, transitionPending: true, native: { label: 'Personal', authSource: 'connected', connectedCount: 1 },
            sources: [
                { connectionId: 'pc_now', providerName: 'Provider', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
                { connectionId: 'pc_next', providerName: 'Provider', connectionName: 'Lab', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
            ] });
        expect(view.applied).toMatchObject({ kind: 'provider', connectionId: 'pc_now', sourceLabel: 'Provider · Work' });
        expect(view.pending).toMatchObject({ kind: 'provider', connectionId: 'pc_next', sourceLabel: 'Provider · Lab' });
    });

    it('retains the last reported Provider route while the runner observation is unavailable', () => {
        const actual = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:claude', providerConnectionId: 'pc_deepseek', modelId: 'deepseek-v4-flash' });
        const native = { label: 'Native', authSource: 'native' as const, connectedCount: 0 };
        const source = { connectionId: 'pc_deepseek', providerName: 'DeepSeek', connectionName: 'DeepSeek',
            connectionRole: 'default' as const, connectionDisplayNameMode: 'automatic' as const };
        const view = resolveSessionRoutePresentation({ phase: 'running', appliedSelection: null,
            reportedSelection: actual, appliedProviderSource: source, selection: { ...actual, providerConnectionId: null },
            transitionPending: true, native });
        expect(view.applied.kind).toBe('unknown');
        expect(view.reported).toMatchObject({ kind: 'provider', connectionId: 'pc_deepseek', sourceLabel: 'DeepSeek' });
        expect(view.pending).toMatchObject({ kind: 'native' });
        expect(presentSessionRouteChip({ ...view, pending: null }, native)).toEqual({
            label: t('connectedServices.authChip.runsThrough', { source: 'DeepSeek' }),
        });
        const current = resolveSessionRoutePresentation({ phase: 'running', reportedSelection: actual,
            appliedSelection: { ...actual, providerConnectionId: null }, appliedProviderSource: source, selection: actual, native });
        expect(current.applied.kind).toBe('native');
    });

    it('names a retained Provider selection before the closed picker has requested its catalog', () => {
        const selection = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:claude', providerConnectionId: 'pc_deepseek', modelId: 'deepseek-v4-flash' });
        const native = { label: 'Native', authSource: 'native' as const, connectedCount: 0 };
        const snapshot = { connectionId: 'pc_deepseek', providerName: 'DeepSeek', connectionName: 'DeepSeek',
            connectionRole: 'default' as const, connectionDisplayNameMode: 'automatic' as const };
        const retained = resolveSessionRoutePresentation({ phase: 'draft', selection, native, appliedProviderSource: snapshot });
        expect(retained.applied).toMatchObject({ kind: 'provider', connectionId: 'pc_deepseek', sourceLabel: 'DeepSeek', unavailable: true });
        expect(presentSessionRouteChip(retained, native)).toEqual({ label: t('connectedServices.authChip.runsThrough', { source: 'DeepSeek' }) });
        const changed = resolveSessionRoutePresentation({ phase: 'draft', selection: ProviderBoundModelRefSchema.parse({ ...selection, providerConnectionId: 'pc_other' }),
            native, appliedProviderSource: snapshot });
        expect(changed.applied).toMatchObject({ kind: 'provider', connectionId: 'pc_other', sourceLabel: null });
    });

    it('preserves Team identity and never guesses native from unreadable applied state', () => {
        const selection = { source: 'team_resource' as const, teamId: 'team', resourceId: 'resource', expectedResourceRevision: 2,
            deliveryMode: 'brokered' as const, agentTargetKey: 'agent:codex', modelId: 'model' };
        const native = { label: 'Personal', authSource: 'connected' as const, connectedCount: 1 };
        expect(resolveSessionRoutePresentation({ phase: 'draft', selection, native }).applied)
            .toMatchObject({ kind: 'team', teamId: 'team', resourceId: 'resource', deliveryMode: 'brokered' });
        expect(resolveSessionRoutePresentation({ phase: 'running', selection, native }).applied.kind).toBe('unknown');
        const applied = resolveSessionRoutePresentation({ phase: 'running', selection, appliedSelection: selection, native });
        expect(presentSessionRouteChip(applied, native)).toEqual({
            label: t('connectedServices.authChip.runsThrough', { source: t('teams.credentials.title') }),
        });
    });
    it('uses applied display evidence after a rename and keeps the requested source separate', () => {
        const selection = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:codex', providerConnectionId: 'pc_a', modelId: 'model' });
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
    it('names the chip after the route that applies, or the armed route as next', () => {
        const source = { connectionId: 'pc_a', providerName: 'DeepSeek', connectionName: 'DeepSeek',
            connectionRole: 'default' as const, connectionDisplayNameMode: 'automatic' as const };
        const pool = { label: 'Claude: Work pool', authSource: 'connected' as const };
        const provider = ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:claude', providerConnectionId: 'pc_a', modelId: 'deepseek-v4' });
        const draft = resolveSessionRoutePresentation({ phase: 'draft', selection: provider, sources: [source],
            native: { ...pool, connectedCount: 1 } });
        expect(presentSessionRouteChip(draft, pool)).toEqual({ label: t('connectedServices.authChip.runsThrough', { source: 'DeepSeek' }) });
        const nativeDraft = resolveSessionRoutePresentation({ phase: 'draft', selection: null, native: { ...pool, connectedCount: 1 } });
        expect(presentSessionRouteChip(nativeDraft, pool)).toHaveProperty('label', t('connectedServices.authChip.runsThrough', { source: 'Claude: Work pool' }));
        expect(presentSessionRouteChip(nativeDraft, { label: 'Native', authSource: 'native' })).toHaveProperty('label',
            t('connectedServices.authChip.runsThroughOwnSignIn'));
        // A field select says "Runs through" as its field's name, so it reads the same route's source alone (WF-ACCEPT-1118B item 5).
        expect(presentSessionRouteSource(draft, pool)).toEqual({ kind: 'source', source: 'DeepSeek' });
        expect(presentSessionRouteSource(nativeDraft, pool)).toEqual({ kind: 'source', source: 'Claude: Work pool' });
        expect(presentSessionRouteSource(nativeDraft, { label: 'Native', authSource: 'native' })).toMatchObject({ kind: 'own_sign_in' });
        const unread = resolveSessionRoutePresentation({ phase: 'running', selection: null, appliedSelection: null,
            sources: [source], native: { ...pool, connectedCount: 1 } });
        // Without applied evidence the chip keeps the incumbent label instead of guessing the route.
        expect(presentSessionRouteChip(unread, pool)).toBeNull();
        // D15: a route picked in a running session is armed for the next message, like an Agent switch.
        // The chip names it as next — the armed route, not the one still running — with no warning mark.
        const switching = resolveSessionRoutePresentation({ phase: 'running', selection: provider,
            appliedSelection: { agentTargetKey: 'agent:claude', providerConnectionId: null, modelId: 'opus' },
            transitionPending: true, sources: [source], native: { ...pool, connectedCount: 1 } });
        expect(presentSessionRouteChip(switching, pool)).toEqual({
            label: t('connectedServices.authChip.nextVia', { source: 'DeepSeek' }) });
        expect(presentArmedSessionRouteSource(switching, pool)).toBe('DeepSeek');
        // Even before the applied route is readable, the armed one is known and named.
        const armedUnread = resolveSessionRoutePresentation({ phase: 'running', selection: provider, appliedSelection: null,
            transitionPending: true, sources: [source], native: { ...pool, connectedCount: 1 } });
        expect(presentArmedSessionRouteSource(armedUnread, pool)).toBe('DeepSeek');
        // Nothing armed in a draft or a settled session.
        expect(presentArmedSessionRouteSource(draft, pool)).toBeNull();
        // Arming back to the native account names that account.
        const toNative = resolveSessionRoutePresentation({ phase: 'running', selection: null, appliedSelection: provider,
            transitionPending: true, sources: [source], native: { ...pool, connectedCount: 1 } });
        expect(presentArmedSessionRouteSource(toNative, pool)).toBe('Claude: Work pool');
        // The picker heading names a connected account or pool, and keeps its default for the Agent's own sign-in.
        expect(presentNativeRouteSourceLabel(pool)).toBe('Claude: Work pool');
        expect(presentNativeRouteSourceLabel({ label: 'Native', authSource: 'native' })).toBeNull();
    });
    it('arms no route switch when only the model changes within the same source', () => {
        const source = { connectionId: 'pc_a', providerName: 'DeepSeek', connectionName: 'DeepSeek',
            connectionRole: 'default' as const, connectionDisplayNameMode: 'automatic' as const };
        const pool = { label: 'ChatGPT · Leeroy', authSource: 'connected' as const };
        const native = { ...pool, connectedCount: 1 };
        // A native model change keeps the Agent's own account: the route that applies is the route that runs.
        const nativeModel = resolveSessionRoutePresentation({ phase: 'running', transitionPending: true, native,
            selection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'gpt-6-sol' },
            appliedSelection: { agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'gpt-6-luna' } });
        expect(presentArmedSessionRouteSource(nativeModel, pool)).toBeNull();
        expect(presentSessionRouteChip(nativeModel, pool)).toEqual({
            label: t('connectedServices.authChip.runsThrough', { source: 'ChatGPT · Leeroy' }) });
        // Another model from the same connection is still that connection.
        const providerModel = resolveSessionRoutePresentation({ phase: 'running', transitionPending: true, native,
            sources: [source],
            selection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:claude', providerConnectionId: 'pc_a', modelId: 'deepseek-v4-pro' }),
            appliedSelection: ProviderBoundModelRefSchema.parse({ agentTargetKey: 'agent:claude', providerConnectionId: 'pc_a', modelId: 'deepseek-v4-flash' }) });
        expect(presentArmedSessionRouteSource(providerModel, pool)).toBeNull();
        expect(presentSessionRouteChip(providerModel, pool)).toEqual({
            label: t('connectedServices.authChip.runsThrough', { source: 'DeepSeek' }) });
    });
});
