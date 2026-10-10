import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema, ProviderSettingsV1Schema,
    buildBackendTargetKeyV2,
} from '@happier-dev/protocol';
import { splitProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { CODEX_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../../../../packages/plugins/codex/src/agent/providerBinding/adapter';
import { CLAUDE_PROVIDER_BINDING_ADAPTER_V1 } from '../../../../../../../../packages/plugins/claude/src/agent/providerBinding/adapter';
import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import * as runtimeLease from '@/plugins/runtime/reload/runtimeLease';
import { resolveProviderConnectionForMachine } from '@/providers/registry/resolve';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { admitExecutionRunInheritedProviderSelection } from './providerLaunch';

afterEach(() => vi.restoreAllMocks());

function fixture(agentId: 'codex' | 'claude', modelId = 'model-a') {
    const contributionKey = 'acme.inheritance/models';
    const definition = ProviderContributionV1Schema.parse({
        v: 1, id: 'models', name: 'Inheritance models', kind: 'cloud',
        endpointTemplates: [{ id: 'responses', protocol: 'openai-responses', baseUrl: 'https://1.1.1.1/v1',
            capabilities: { streaming: 'supported', toolRoundTrips: 'supported', reasoningControls: 'supported', statefulResponses: 'supported' } }],
        catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [{ id: 'model-a', name: 'Model A',
            capabilities: { toolRoundTrips: 'supported' } }] },
        compatibilityOverrides: [{ agentTargetKey: 'agent:happier.agent.codex/codex', protocol: 'openai-responses',
            status: 'verified', reason: 'Controlled Provider boundary', evidence: { sourceUrls: ['https://example.test/contract'],
                verifiedAt: '2026-10-09', testIds: ['inherited-child-admission'] } }],
    });
    const contributes = {
        ...getResolvedContributionRegistry(),
        providersByContributionKey: new Map([[contributionKey, {
            provenance: 'external' as const, source: { kind: 'path' as const }, pluginId: 'acme.inheritance',
            identity: { pluginId: 'acme.inheritance', localId: 'models' }, definition,
        }]]),
    };
    const initialSettings = ProviderSettingsV1Schema.parse({
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [{ v: 1, id: 'pc_inherited', source: { kind: 'contribution', contributionKey },
            role: 'default', displayName: 'Inherited', displayNameMode: 'automatic', revision: 1, createdAt: 1, updatedAt: 1 }],
    });
    const resolved = resolveProviderConnectionForMachine({
        connectionId: 'pc_inherited', machineId: 'machine-child', providerSettings: initialSettings, registry: contributes,
        dnsEvidenceByEndpointUrl: new Map([['https://1.1.1.1/v1', ['1.1.1.1']]]),
    });
    if (resolved.status !== 'resolved') throw new Error('Fixture Provider did not resolve');
    const settings = ProviderSettingsV1Schema.parse({ ...initialSettings, accountGrants: [{
        v: 1, connectionId: 'pc_inherited', connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, confirmedAt: 1,
    }] });
    const adapter = agentId === 'codex' ? CODEX_PROVIDER_BINDING_ADAPTER_V1 : CLAUDE_PROVIDER_BINDING_ADAPTER_V1;
    // The executable registry is a system boundary. Keep the actual first-party adapter
    // and all host compatibility/authorization logic beneath that boundary real.
    const materialize = vi.fn(adapter.materialize);
    const release = vi.fn(async () => {});
    const activateContributionsOnDemand = vi.fn(async () => []);
    const lease: PluginRuntimeRegistryLease = {
        source: 'active', durableRevision: -1, release,
        registry: {
            contributes, activatedPluginIds: new Set([`happier.agent.${agentId}`]),
            activateContributionsOnDemand,
            agentRuntimesByAgentId: new Map([[agentId, {
                pluginId: `happier.agent.${agentId}`, providerBinding: { ...adapter, materialize },
                isCurrent: () => true, retirementSignal: new AbortController().signal,
            }]]),
        } as unknown as PluginRuntimeRegistryLease['registry'],
    };
    const accountSettingsSnapshot: ActiveAccountSettingsSnapshot = {
        scopeKey: 'account-fixture', source: 'network', settings: AccountSettingsSchema.parse({}), settingsVersion: 1,
        loadedAtMs: 1, settingsSecretsReadKeys: [],
        providerConnectionsCatalog: { status: 'ready', revision: 1, catalog: splitProviderSettingsV1(settings).catalog },
    };
    vi.spyOn(runtimeLease, 'acquireAuthoritativePluginRuntimeRegistryLease').mockResolvedValue(lease);
    const backendTarget = { kind: 'backend' as const, backendId: agentId, sourceKind: 'built_in' as const };
    return { release, materialize, activateContributionsOnDemand, input: {
        backendTarget, agentId, runId: 'run-child', machineId: 'machine-child', featureEnabled: true,
        happyHomeDir: '/tmp/happier-inherited-admission', accountSettingsSnapshot,
        selection: { agentTargetKey: buildBackendTargetKeyV2(backendTarget), providerConnectionId: 'pc_inherited', modelId },
    } };
}

describe('inherited child Provider admission', () => {
    it('requires a compatible exact model before child publication and releases preparation without materializing', async () => {
        const { input, release, materialize } = fixture('codex');
        await expect(admitExecutionRunInheritedProviderSelection(input)).resolves.toBeUndefined();
        expect(materialize).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });

    it.each([
        ['claude', 'model-a', 'provider_incompatible_with_agent'],
        ['codex', 'missing-model', 'provider_model_not_found'],
    ] as const)('requires a new child choice for %s with %s rather than native/model fallback', async (agentId, modelId, providerErrorCode) => {
        const { input, release, materialize } = fixture(agentId, modelId);
        await expect(admitExecutionRunInheritedProviderSelection(input)).rejects.toMatchObject({
            code: 'execution_run_child_choice_required', executionRunErrorCode: 'execution_run_child_choice_required',
            details: { providerError: { code: providerErrorCode } },
        });
        expect(materialize).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledOnce();
    });
});
