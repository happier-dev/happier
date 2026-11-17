import * as React from 'react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { DaemonProviderModelProjectionResponseV1Schema } from '@happier-dev/protocol/rpc/providers';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary,
    installBundledProviderDeclarationsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';

// Only the socket transport is substituted. The Account, projection resource,
// source-browse owner, protocol parser and mounted picker remain real.
const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { SessionModelPicker } = await import('./SessionModelPicker');
await loadSyncSingletonForTests();
const machineId = '6a37defb-c9fd-46bd-8b59-5a341cf630a9';
let serverId = '';
beforeEach(async () => {
    rpc.state.machines.push(createMachineFixture({ id: machineId, activeAt: Date.now() }));
    installBundledProviderDeclarationsRpcBoundary(rpc);
    serverId = (await account.restore({ waivedActions: ['providers.models.refresh'] })).serverId;
});
afterEach(async () => { standardCleanup(); await account.reset(); rpc.reset(); });

it.each([
    ['provider_probe_response_invalid', 'settingsProviders.errors.probeResponseInvalidTitle'],
    ['provider_agent_runtime_unsupported', 'settingsProviders.errors.agentRuntimeUnsupportedTitle'],
    ['provider_materialization_failed', 'settingsProviders.errors.materializationFailedTitle'],
    ['provider_settings_invalid', 'settingsProviders.errors.connectionInvalidTitle'],
    ['provider_connection_invalid', 'settingsProviders.errors.connectionConfigurationInvalidTitle'],
] as const)('shows the typed %s title after the real picker model request', async (code, titleKey) => {
    rpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_MODEL_PROJECTION, () =>
        DaemonProviderModelProjectionResponseV1Schema.parse({ status: 'error', error: createProviderErrorV1(code) }));
    const screen = await renderScreen(<SessionModelPicker
        declarationContext={{ kind: 'account' }} agentTargetKey="agent:happier.agent.codex/codex"
        nativeModels={[]} providerGroups={[]} providerProjectionAuthoritative
        selected={null} onSelect={() => {}} sourceBrowse={{ machineId, serverId }}
        connectedServices={{ v: 2, bindingsByServiceId: {
            'happier.agent.muse/muse-account': { source: 'connected', selection: 'profile', profileId: 'journey' },
        } }} />);
    await waitForHomeGovernance(() => {
        const failure = screen.findByTestId('provider-error:' + code);
        expect(failure).not.toBeNull();
        expect(screen.getTextContent()).toContain(t(titleKey));
    });
});
