import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { AccountProfileSchema, type PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol';
import { renderHook } from '@/dev/testkit';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { storage } from '@/sync/domains/state/storage';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ConnectedAccountDescriptorProjectionState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { applyConnectedAccountCatalogSnapshot } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { t } from '@/text';
import { useSessionConnectedServicesAuthSwitch } from './useSessionConnectedServicesAuthSwitch';

installDisconnectedServerSocketBoundary();

// authSource is the web chip's published dataset; select that native boundary.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const consumer = { pluginId: 'happier.agent.codex', localId: 'codex' };
const service = { pluginId: consumer.pluginId, localId: 'openai-codex' };
const serviceKey = 'happier.agent.codex/openai-codex';
const declarations = [{ purpose: 'primary', service }] satisfies readonly PluginProjectedAgentConnectedAccountPurposeV2[];
const projection = {
    scopeKey: 'armed-purpose-catalog', status: 'ready', descriptors: [{
        id: service.localId, serviceId: service.localId, pluginId: service.pluginId,
        provenance: 'first_party', sourceKind: 'bundled', title: 'Codex',
        authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode',
            scopes: ['openid'], pkce: 'required', outcomeReconciliation: 'none' }] },
        capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }], conflicts: [], errorReason: null,
} satisfies ConnectedAccountDescriptorProjectionState;

function authSource(chip: AgentInputExtraActionChip | null) {
    const element = chip?.render({ chipStyle: () => null, iconColor: '#000', showLabel: true,
        textStyle: null, countTextStyle: null, chipAnchorRef: { current: null }, popoverAnchorRef: { current: null },
    }) as React.ReactElement<{ dataSet?: { authSource?: string } }> | undefined;
    return element?.props.dataSet?.authSource;
}

it('previews destination-only armed defaults without inferring Native from unread defaults or demanding them for explicit session auth', async () => {
    // Only secure-storage, HTTP and socket transports are replaced. Account
    // admission, feature decisions, catalog subscriptions and auth labels are real.
    const bridge = await loadSyncSingletonForTests();
    const previous = storage.getState();
    const accountId = 'armed-purpose-catalog';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const features = buildServerFeaturesResponse();
    features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
    const value = { v: 1 as const, bindings: [{ purpose: { consumer, purpose: 'primary' },
        target: { kind: 'account' as const, account: { service, accountId: 'work' } } }] };
    let denied = false;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://armed-purpose-catalog.test', accountId,
        request: (input, init) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === '/v1/features') return Promise.resolve(Response.json(features));
            if (pathname === '/v1/account/entity-rows/connected-accounts/purposes') return Promise.resolve(denied
                ? new Response(null, { status: 403 })
                : Response.json({ status: 'present', revision: 5, content: { t: 'plain', v: { key: 'purposes', value } } }));
            return http.request(input, init);
        } });
    const scope = { serverId: connection.home.id, accountId };
    storage.setState({ profileScope: scope, profile: AccountProfileSchema.parse({ id: accountId,
        connectedAccountsV4: [{ revisionSemantics: 'legacy_unfenced', ref: { service, accountId: 'work' },
            status: 'connected', authenticationModeId: null, configurationReady: true, configurationRevision: null,
            credentialRevision: null, kind: 'oauth', expiresAt: null, lastUsedAt: null, providerIdentity: {} }],
    }) });
    installConnectedAccountDescriptorProjection(projection);
    applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 5, record: { key: 'purposes', value } }, true);
    const armed = { agentId: 'codex', agentIdentity: consumer, connectedAccounts: declarations };
    type ArmedTarget = NonNullable<Parameters<typeof useSessionConnectedServicesAuthSwitch>[0]['armedContinuationAgent']>;
    const hook = await renderHook((target: ArmedTarget | null) => useSessionConnectedServicesAuthSwitch({
        sessionId: 'armed-session', agentId: 'codex', agentIdentity: consumer, machineId: null, serverId: connection.home.id,
        connectedAccounts: declarations, armedContinuationAgent: target,
        sessionMetadata: { connectedServices: { v: 2, bindingsByServiceId: {
            [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } } }, settings: { connectedServicesDefaultProfileByServiceId: {} }, switchingDisabledReason: null,
    }), { initialProps: armed });
    try {
        expect(authSource(hook.getCurrent().connectedServicesAuthChip)).toBe('connected');
        const knownLabel = hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label;
        denied = true;
        await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'loading' }, true); });
        expect(authSource(hook.getCurrent().connectedServicesAuthChip)).toBe('unknown');
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label).toBe(knownLabel);
        await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'partial', revision: 6,
            authority: 'active', record: { key: 'purposes', value }, diagnostics: [{ path: 'bindings.1', reason: 'invalid-stored-content' }] }, true); });
        expect(authSource(hook.getCurrent().connectedServicesAuthChip)).toBe('unknown');
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label).toBe(knownLabel);
        await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'partial', revision: 6,
            authority: 'inactive', record: { key: 'purposes', value: { v: 1, bindings: [] } },
            diagnostics: [{ path: 'bindings.0', reason: 'invalid-stored-content' }] }, true); });
        expect(authSource(hook.getCurrent().connectedServicesAuthChip)).toBe('unknown');
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label).toBe(t('common.unavailable'));
        await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'forbidden' }, true); });
        expect(authSource(hook.getCurrent().connectedServicesAuthChip)).toBe('unknown');
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label).toBe(t('common.unavailable'));
        await hook.rerender({ ...armed, agentIdentity: null });
        expect(authSource(hook.getCurrent().connectedServicesAuthChip)).toBe('unknown');
        expect(hook.getCurrent().connectedServicesAuthChip?.collapsedContentPopover?.label).toBe(t('common.unavailable'));
        await hook.rerender(null);
        expect(authSource(hook.getCurrent().connectedServicesAuthChip)).toBe('connected');
    } finally { await hook.unmount(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});
