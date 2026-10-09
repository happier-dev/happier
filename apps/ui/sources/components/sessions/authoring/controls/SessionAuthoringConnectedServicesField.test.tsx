import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { AccountProfileSchema, type ConnectedServiceBindingsV2, type PluginProjectedAgentConnectedAccountPurposeV2 } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { storage } from '@/sync/domains/state/storage';
import { installConnectedAccountDescriptorProjection } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import type { ConnectedAccountDescriptorProjectionState } from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import { applyConnectedAccountCatalogSnapshot } from '@/sync/store/settings/connectedAccountCatalogSnapshot';
import { AgentInputContentPopover } from '@/components/sessions/agentInput/components/AgentInputContentPopover';
import { SelectionList } from '@/components/ui/selectionList';
import { AuthProvider } from '@/auth/context/AuthContext';
import { SessionAuthoringConnectedServicesField } from './SessionAuthoringConnectedServicesField';

installDisconnectedServerSocketBoundary();
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

it('authors a connected pick during unread inheritance and preserves controlled echoes without reporting derived defaults', async () => {
    const bridge = await loadSyncSingletonForTests();
    const previous = storage.getState();
    const accountId = 'authoring-purpose';
    const http = createHomeHubArtifactHttpBoundary(accountId);
    const features = buildServerFeaturesResponse();
    features.capabilities.connectedServices.qualifiedAccounts = { protocolVersion: 4 };
    const consumer = { pluginId: 'happier.agent.codex', localId: 'codex' };
    const service = { pluginId: consumer.pluginId, localId: 'openai-codex' };
    const serviceKey = 'happier.agent.codex/openai-codex';
    const declarations = [{ purpose: 'primary', service }] satisfies readonly PluginProjectedAgentConnectedAccountPurposeV2[];
    const value = { v: 1 as const, bindings: [{ purpose: { consumer, purpose: 'primary' },
        target: { kind: 'account' as const, account: { service, accountId: 'work' } } }] };
    let denied = false;
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://authoring-purpose.test', accountId,
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
    installConnectedAccountDescriptorProjection({ scopeKey: 'authoring-purpose', status: 'ready', descriptors: [{
        id: service.localId, serviceId: service.localId, pluginId: service.pluginId, provenance: 'first_party', sourceKind: 'bundled', title: 'Codex',
        authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', scopes: ['openid'],
            pkce: 'required', outcomeReconciliation: 'none' }] }, capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
    }], conflicts: [], errorReason: null } satisfies ConnectedAccountDescriptorProjectionState);
    applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'ready', revision: 5, record: { key: 'purposes', value } }, true);
    const onChange = vi.fn<(value: ConnectedServiceBindingsV2 | null) => void>();
    const renderField = (authored: ConnectedServiceBindingsV2 | null | undefined) => <SessionAuthoringConnectedServicesField
        agentId="codex" agentIdentity={consumer} connectedAccounts={declarations} context={{ serverId: connection.home.id }}
        value={authored} onChange={onChange} testID="authoring-auth" chipRenderContext={{ chipStyle: () => null, iconColor: '#000',
            showLabel: true, textStyle: null, countTextStyle: null, chipAnchorRef: { current: null }, popoverAnchorRef: { current: null } }} />;
    const wrapper = ({ children }: React.PropsWithChildren) => <AuthProvider initialCredentials={connection.credentials}>{children}</AuthProvider>;
    const screen = await renderScreen(renderField(undefined), { wrapper });
    let picker: Awaited<ReturnType<typeof renderScreen>> | undefined;
    try {
        expect(screen.findHostByTestId('new-session-connected-services-auth-chip')?.props.dataSet?.authSource).toBe('connected');
        expect(onChange).not.toHaveBeenCalled();
        denied = true;
        await act(async () => { applyConnectedAccountCatalogSnapshot(scope, 'purposes', { status: 'unavailable', reason: 'forbidden' }, true); });
        expect(screen.findHostByTestId('new-session-connected-services-auth-chip')?.props.dataSet?.authSource).toBe('unknown');
        const content = screen.findByType(AgentInputContentPopover).props.content;
        if (typeof content !== 'function') throw new Error('Expected the shared Connected Services picker');
        picker = await renderScreen(content({ maxHeight: 420, requestClose() {} }), { wrapper });
        const rootStep = picker.findByType(SelectionList).props.rootStep;
        const options = rootStep.sections.flatMap((section: { options: readonly { id: string; selected?: boolean; onSelect?: () => void }[] }) => section.options);
        const connected = options.find((option: { id: string }) => option.id.endsWith(':profile:work'));
        if (!connected?.onSelect) throw new Error('Expected the actual Work account option');
        await act(async () => { await connected.onSelect(); });
        expect(onChange).toHaveBeenLastCalledWith({ v: 2, bindingsByServiceId: {
            [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'work' },
        } });
        expect(screen.findHostByTestId('new-session-connected-services-auth-chip')?.props.dataSet?.authSource).toBe('connected');
        const authored = onChange.mock.calls.at(-1)?.[0];
        if (!authored) throw new Error('The pick must remain an explicit authored binding');
        onChange.mockClear();
        await screen.update(renderField(authored));
        expect(onChange).not.toHaveBeenCalled();
        await screen.update(renderField(undefined));
        expect(screen.findHostByTestId('new-session-connected-services-auth-chip')?.props.dataSet?.authSource).toBe('unknown');
        expect(onChange).not.toHaveBeenCalled();
        await screen.update(renderField(null));
        expect(screen.findHostByTestId('new-session-connected-services-auth-chip')?.props.dataSet?.authSource).toBe('native');
        expect(onChange).not.toHaveBeenCalled();
    } finally { await picker?.unmount(); await screen.unmount(); storage.setState(previous, true); await connection.dispose(); bridge.dispose(); }
});
