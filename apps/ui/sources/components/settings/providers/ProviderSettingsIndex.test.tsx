import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS, DaemonProviderConnectionsDescribeResponseV1Schema } from '@happier-dev/protocol/rpc';

import { createMachineFixture, renderInCollectionLayout, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import {
    createProviderConnectionViewFixture,
    createProviderConnectionsDescribeFixture,
    createProviderSettingsAccountHarness,
    createProviderSettingsHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import { TokenStorage } from '@/auth/storage/tokenStorage';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));

// Static imports reach transport consumers before the account harness is configured.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installSettingsViewCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/settings/providers', params: () => route.params }).module;
    },
    storage: 'real',
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

// Load real screen owners after boundary setup, outside behavior deadlines.
const providerRpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerRpc);
const account = createProviderSettingsAccountHarness();
const { ProviderSettingsIndex } = await import('./ProviderSettingsIndex');
let releaseRead: (() => void) | null = null;
let restoreCredentialRead: (() => void) | null = null;

describe('ProviderSettingsIndex', () => {
    beforeEach(async () => {
        providerRpc.reset();
        const { serverId } = await account.restore({ serverIdentityId: 'srv_provider_index' });
        await account.publishMachines(serverId, []);
    });
    afterEach(async () => {
        releaseRead?.();
        releaseRead = null;
        restoreCredentialRead?.();
        restoreCredentialRead = null;
        standardCleanup();
        route.params = {};
        await account.reset();
    });

    it('keeps a searched collection control on screen instead of landing on a detail in split layout', async () => {
        route.params = { setting: 'providers.custom' };
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findByTestId('settings-providers-screen')).not.toBeNull();
    });

    it('keeps the normal landing for a setting outside the Providers collection', async () => {
        route.params = { setting: 'appearance.density' };
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findByTestId('settings-providers-screen')).toBeNull();
    });

    it('shows Account configuration while a selected machine becomes ready, then shows its Provider projection', async () => {
        route.params = { setting: 'providers.custom' };
        const machine = createMachineFixture({ id: 'machine-a', kind: 'persistent', activeAt: Date.now() });
        await account.publishMachines(account.serverId, [machine]);
        await account.selectMachine(account.serverId, machine.id);
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Saved provider',
                baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Saved provider', displayNameMode: 'custom',
            revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        const pending = createDeferred<void>();
        releaseRead = pending.resolve;
        const machineProjection = createProviderConnectionsDescribeFixture({ connections: [
            createProviderConnectionViewFixture({ connectionId: 'pc_a', contributionKey: null,
                displayName: 'Machine provider', providerName: 'Machine provider', role: 'named',
                displayNameMode: 'custom', runtime: { health: 'available', modelCount: 0,
                    checkedAt: 1, endpoints: [] } }),
        ] });
        providerRpc.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async () => {
            await pending.promise;
            return machineProjection;
        });
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Saved provider'));
        expect(screen.getTextContent()).not.toContain('Machine provider');
        await act(async () => { pending.resolve(); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Machine provider'));
        const { describeProviderConnections } = await import('@/providers/actions/client');
        const consumed = await describeProviderConnections({ machineId: machine.id, serverId: account.serverId });
        expect(DaemonProviderConnectionsDescribeResponseV1Schema.parse(consumed))
            .toMatchObject({ status: 'success', connections: [{ connectionId: 'pc_a', runtime: { modelCount: 0 } }] });
        expect(providerRpc.state.requests.map(request => ({ method: request.method, machineId: request.machineId,
            serverId: request.serverId }))).toContainEqual({
            method: RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE,
            machineId: machine.id,
            serverId: 'srv_provider_index',
        });
    });

    it.each(['populated', 'empty', 'error'] as const)('shows pending Account data in the detail pane then %s, without a machine', async (result) => {
        const pending = createDeferred<void>();
        releaseRead = pending.resolve;
        if (result === 'error') {
            // Device credential access is an external Account boundary; the scope/read owners stay real.
            const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
            const workingRead = credentialRead.getMockImplementation()!;
            restoreCredentialRead = () => credentialRead.mockImplementation(workingRead);
            credentialRead.mockImplementation(async () => {
                await pending.promise;
                throw new Error('device credential store unavailable');
            });
        }
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: result === 'populated' ? [{ v: 1, id: 'pc_a', source: { kind: 'custom', template: buildCustomProviderTemplate({
                ...createCustomProviderDraft('openai-chat'), name: 'Acme', baseUrl: 'https://models.example.test/v1', requiresApiKey: false,
            }) }, role: 'named', displayName: 'Acme', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }] : [],
        });
        account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            respondAfter: pending.promise, body: { status: 'present', revision: 1, content: { t: 'plain', v: catalog } },
        });
        const screen = await renderInCollectionLayout(<ProviderSettingsIndex />, 'split');
        expect(screen.findByTestId('settings-providers-loading')).not.toBeNull();
        expect(screen.findByTestId('settings-providers-invitation')).toBeNull();
        await act(async () => { pending.resolve(); });
        await vi.waitFor(() => expect(screen.findByTestId('settings-providers-loading')).toBeNull());
        if (result === 'populated') {
            expect(screen.findAllByType('Redirect')[0]?.props.href).toContain('pc_a');
            expect(screen.findByTestId('settings-providers-invitation')).toBeNull();
        } else if (result === 'empty') {
            expect(screen.findByTestId('settings-providers-invitation')).not.toBeNull();
        } else {
            expect(screen.findByTestId('settings-providers-invitation')).toBeNull();
            const retry = screen.root.findAll(node => typeof node.props.testID === 'string'
                && node.props.testID.startsWith('provider-error-action:') && typeof node.props.onPress === 'function')[0];
            expect(retry).toBeDefined();
            restoreCredentialRead?.();
            account.home.answer(account.serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
                body: { status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } },
            });
            await act(async () => { await retry.props.onPress(); });
            await vi.waitFor(() => expect(screen.findByTestId('settings-providers-invitation')).not.toBeNull());
        }
    });
});
