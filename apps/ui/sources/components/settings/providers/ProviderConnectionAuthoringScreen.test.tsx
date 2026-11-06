import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';

import {
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    createProviderSettingsAccountHarness,
    installProviderSettingsRpcBoundary,
    installProviderConnectionsCatalogHttpBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, PROVIDER_CONNECTIONS_ROWS_ROUTE_V1, ProviderConnectionsRowMutationV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { PROVIDER_ACTION_INPUT_SCHEMAS_V1, PROVIDER_CONNECTION_ACTION_ID_BY_OPERATION_V1 } from '@happier-dev/protocol/providers/providerActionsV1';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox, installOwnMachineApprovalReplayBoundary } from '@/dev/testkit/harness/approvalInbox';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { getActiveUnsavedChangesGuard, runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
    credential: null as null | { required: boolean; keyUrl?: string },
    provenance: 'first_party' as 'first_party' | 'external',
    contributionKey: 'acme.plugin/ollama',
    providerName: 'Ollama',
    websiteUrl: null as string | null,
    endpointTemplates: [{ id: 'chat', protocol: 'openai-chat' as const }] as Array<{
        id: string;
        protocol: 'openai-responses' | 'openai-chat' | 'anthropic';
    }>,
    savedSecrets: [] as Array<{
        id: string;
        name: string;
        kind: 'apiKey';
        encryptedValue: { _isSecretValue: true; value: string };
        createdAt: number;
        updatedAt: number;
    }>,
}));
const run = vi.hoisted(() => vi.fn());
const probeProviderDraft = vi.hoisted(() => vi.fn());
const describeProviderConnections = vi.hoisted(() => vi.fn());
const focusField = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn(async () => undefined));
const modalAlert = vi.hoisted(() => vi.fn());
const modalShow = vi.hoisted(() => vi.fn((_content: unknown) => 'provider-secret-picker'));
const modalHide = vi.hoisted(() => vi.fn());
const navigationDispatch = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const navigationPreventRemove = vi.hoisted(() => ({
    enabled: false,
    callback: null as null | ((event: { data: { action: unknown } }) => void),
}));
const providerHarness = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
let stored: ReturnType<typeof installProviderConnectionsCatalogHttpBoundary>;
let foreignServerId = '';
let machine = createMachineFixture({ id: 'machine-a', kind: 'persistent', activeAt: Date.now(), metadata: {
    host: 'mac.local', platform: 'darwin', displayName: 'Mac', happyCliVersion: 'test',
    happyHomeDir: '/Users/tester/.happy', homeDir: '/Users/tester',
} });
const administrationTarget = {
    controller: {
        async setMachines(entries: ReadonlyArray<Readonly<{ machineId: string; displayName?: string; serverId?: string; serverIdentityId?: string; serverLabel?: string }>>) {
            const byServer = new Map<string, ReturnType<typeof createMachineFixture>[]>();
            byServer.set(account.serverId, []);
            if (foreignServerId) byServer.set(foreignServerId, []);
            for (const entry of entries) {
                const serverId = entry.serverId === 'server-b' ? foreignServerId : account.serverId;
                const machines = byServer.get(serverId) ?? [];
                machines.push(createMachineFixture({ id: entry.machineId, kind: 'persistent', activeAt: Date.now(), metadata: {
                    ...machine.metadata!, displayName: entry.displayName ?? entry.machineId,
                } }));
                byServer.set(serverId, machines);
            }
            for (const [serverId, machines] of byServer) await account.publishMachines(serverId, machines);
        },
        async select(machineId: string, serverIdentityId?: string) {
            await account.selectMachine(serverIdentityId === 'srv_b' ? foreignServerId : account.serverId, machineId);
        },
    },
};

installSettingsViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlert, show: modalShow, hide: modalHide } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock, createFocusableTextInputMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Linking: { openURL: openUrl },
            // The actual FieldTextInput forwards focus to this native SDK boundary.
            TextInput: createFocusableTextInputMock(() => {}, props => focusField(String(props.testID ?? props.accessibilityLabel ?? 'unknown'))),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { push: routerPush, replace: routerReplace },
            navigation: {
                addListener: () => () => undefined,
                dispatch: navigationDispatch,
                isFocused: () => true,
            },
        }).module;
    },
    storage: 'real',
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock({
        usePreventRemove: (enabled, callback) => {
            navigationPreventRemove.enabled = enabled;
            navigationPreventRemove.callback = callback;
        },
    });
});


type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;

/** The editor header's Test action with its result line, read as one control. */
function findDraftTestRow(screen: RenderedScreen) {
    const button = findComposite(screen, 'settings-provider-authoring-test', 'loading');
    if (!button) return undefined;
    const result = findComposite(screen, 'settings-provider-authoring-probe-result', 'text');
    return {
        props: {
            onPress: button.props.onPress as (() => void) | undefined,
            loading: Boolean(button.props.loading),
            disabled: Boolean(button.props.disabled),
            subtitle: (result?.props.text ?? null) as string | null,
        },
    };
}

/** One entry of the editor header's `⋯` menu, as a pressable row. */
function findEditorMenuAction(screen: RenderedScreen, id: string) {
    const actions = findComposite(screen, 'settings-provider-authoring-menu', 'actions')?.props.actions as
        | Array<{ id: string; onSelect: () => unknown }>
        | undefined;
    const action = actions?.find((entry) => entry.id === id);
    return action ? { props: { onPress: action.onSelect } } : undefined;
}

function findProviderExternalLink(
    screen: Awaited<ReturnType<typeof renderScreen>>,
    label: string,
) {
    return screen.findAll((node) => (
        node.props.accessibilityRole === 'link'
        && node.props.accessibilityLabel === label
        && typeof node.props.onPress === 'function'
    )).at(-1);
}

function presentedTitles(screen: RenderedScreen) {
    const errors = screen.findAll(node => typeof node.props.testID === 'string'
        && node.props.testID.startsWith('provider-error:') && typeof node.props.title === 'string');
    return [...screen.findAllByType(Item).map(item => item.props.title),
        ...errors.flatMap(node => [node.props.title, node.props.action?.label].filter(Boolean))];
}

function findProviderRecoveryAction(screen: RenderedScreen, label: string) {
    const node = screen.findAll(node => node.props.accessibilityLabel === label
        && (typeof node.props.onPress === 'function' || typeof node.props.action === 'function'))[0];
    return node ? { props: { onPress: node.props.onPress ?? node.props.action } } : undefined;
}


/** The rendered component that carries `prop` for a test id (the host view under it carries none). */
function findComposite(screen: RenderedScreen, testID: string, prop: string) {
    return screen.findAllByTestId(testID).find((node) => node.props[prop] !== undefined) ?? null;
}

/** Publish through the catalog's HTTP boundary; Provider authoring receives references only. */
async function publishProviderKey() {
    const ref = 'happier:shared-secret:v1:provider-key';
    const entry = SavedSecretCatalogEntryV1Schema.parse({
        ref, source: 'shared_resource', relationship: 'owner', name: 'Provider key', kind: 'apiKey',
        revision: 1, materialStatus: 'ready',
        capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
    });
    // Picker material and Save's revision capture observe the same Home resource.
    account.home.answer(account.serverId, 'GET /v1/account/saved-secrets/resources', { body: { resources: [entry] } });
    account.home.answer(account.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [{
        resourceId: 'provider-key', encryptionMode: 'plain', recipientEnvelope: null,
        storedContent: { t: 'plain', v: { v: 1, name: 'Provider key', kind: 'apiKey', value: 'test-provider-key' } },
        entry,
    }] } });
    const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = storage.getState().settingsScope;
    if (!scope) throw new Error('Expected an Account settings scope');
    await React.act(async () => { await refreshSavedSecretCatalog(scope); });
    return ref;
}

async function openProviderKeySheet(screen: RenderedScreen, event?: unknown) {
    const trigger = findComposite(screen, 'settings-provider-authoring-api-key.choose', 'onPress');
    if (!trigger) throw new Error('Missing Provider Add key or Replace trigger');
    await React.act(async () => { trigger.props.onPress(event); });
    const modal = modalShow.mock.calls.at(-1)?.[0] as { props?: {
        request: { current?: string; anchor?: unknown; service: { suggestedName?: string } };
        onResult: (result: { kind: 'connected' | 'selected'; secretRef: string } | { kind: 'dismissed' }) => void;
    } } | undefined;
    if (!modal?.props) throw new Error('Missing Connect sheet');
    return modal.props;
}

await loadSyncSingletonForTests();
// Install transport leaves before loading the screen; cold compilation is collection work.
await import('./ProviderConnectionAuthoringScreen');
const [{ Item }, { ItemGroup }, { FieldTextInput }] = await Promise.all([
    import('@/components/ui/lists/Item'), import('@/components/ui/lists/ItemGroup'),
    import('@/components/ui/forms/FieldTextInput'),
]);

describe('ProviderConnectionAuthoringScreen', () => {
    afterEach(async () => { standardCleanup(); await account.reset(); });
    beforeEach(async () => {
        providerHarness.reset();
        machine = createMachineFixture({ ...machine, activeAt: Date.now() });


        state.credential = null;
        state.provenance = 'first_party';
        state.contributionKey = 'acme.plugin/ollama';
        state.providerName = 'Ollama';
        state.websiteUrl = null;
        state.endpointTemplates = [{ id: 'chat', protocol: 'openai-chat' }];
        run.mockReset();
        openUrl.mockReset();
        openUrl.mockResolvedValue(undefined);
        modalAlert.mockReset();
        modalShow.mockClear();
        modalHide.mockClear();
        navigationDispatch.mockReset();
        routerPush.mockReset();
        routerReplace.mockReset();
        navigationPreventRemove.enabled = false;
        navigationPreventRemove.callback = null;

        focusField.mockReset();
        probeProviderDraft.mockReset();
        probeProviderDraft.mockResolvedValue({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:test' });
        describeProviderConnections.mockReset();
        describeProviderConnections.mockResolvedValue({
            status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
            diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
            discoveryCandidatesTruncated: false,
            authoringPreview: {
                status: 'resolved', connectionId: 'pc_preview',
                contributionKey: 'acme.plugin/ollama', created: true,
                candidateId: 'discovery-candidate:v1:default',
                scope: 'machine',
                machineId: 'machine-a',
                endpoints: [{
                    endpointTemplateId: 'chat', protocol: 'openai-chat',
                    normalizedUrl: 'http://127.0.0.1:11434/v1', locality: 'loopback', scope: 'machine',
                }],
                credential: null,
                fingerprint: 'authoring-review:v1:default',
                revision: 1,
            },
        });
        await account.restore({ serverIdentityId: 'srv_provider_screen', currentAccount: true, machines: [machine], waivedActions: [
            'providers.connections.create_contribution', 'providers.connections.create_custom',
            'providers.connections.enabled.set', 'providers.probe', 'secrets.shared.create',
        ] });
        await account.selectMachine(account.serverId, 'machine-a');
        stored = installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: account.serverId,
            catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
        foreignServerId = await account.addHome({
            name: 'Other Provider Account', serverUrl: 'https://provider-foreign.test', serverIdentityId: 'srv_b', accountId: 'account-foreign', active: false,
        });
        installProviderConnectionsCatalogHttpBoundary({ home: account.home, serverId: foreignServerId,
            catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 });
        await account.home.selectHomes([account.serverId]);
        const { storage } = await import('@/sync/domains/state/storage');
        const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
        Object.defineProperty(state, 'savedSecrets', {
            configurable: true,
            get: () => storage.getState().settings.secrets,
            set: (secrets) => getSyncSingleton().applySettings({ secrets }, {
                expectedSettingsScope: storage.getState().settingsScope, source: 'ui',
            }),
        });
        state.savedSecrets = [];
        account.home.answer(account.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [] } });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE, async (request) => {
            const payload = request.payload as { authoringPreview?: unknown };
            if (payload.authoringPreview) return await describeProviderConnections(payload);
            return createProviderConnectionsDescribeFixture({
                connections: [],
                available: [{
                    contributionKey: state.contributionKey,
                    name: state.providerName,
                    kind: 'local',
                    credential: state.credential,
                    provenance: state.provenance,
                    icon: null,
                    endpointTemplates: state.endpointTemplates,
                    ...(state.websiteUrl ? { websiteUrl: state.websiteUrl } : {}),
                }],
            });
        });
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_PROBE, async (request) => (
            await probeProviderDraft(request.payload)
        ));
        providerHarness.intercept(RPC_METHODS.DAEMON_PROVIDERS_CONNECTION_MUTATE, async (request, next) => {
            const payload = request.payload as { action?: string; connectionId?: string };
            const key = payload.action === 'createContribution' || payload.action === 'createCustom'
                ? 'save'
                : payload.connectionId;
            return await run(payload, key) ?? await next();
        });
    });

    it('renders contribution metadata supplied by the shared Provider RPC boundary', async () => {
        state.contributionKey = 'acme.plugin/boundary';
        state.providerName = 'Boundary provider';
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/boundary" />,
        );

        await waitForHomeGovernance(() => expect({
            title: findComposite(screen, 'settings-provider-authoring-header', 'title')?.props.title,
            titles: screen.findAllByType(Item).map(item => item.props.title),
            requests: providerHarness.state.requests,
        }).toMatchObject({ title: expect.stringContaining('Boundary provider') }));
    });

    it('edits a built-in connection name without re-describing its named preview and writes it only on Connect', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" displayName="Local models" />,
        );
        const name = screen.findByTestId('settings-provider-authoring-name');
        expect(name?.props.value).toBe('Local models');
        await waitForHomeGovernance(() => expect(describeProviderConnections).toHaveBeenLastCalledWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({ displayName: 'Local models' }),
        })));
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(false));
        describeProviderConnections.mockClear();
        for (const value of ['Renamed', 'Renamed local', 'Renamed local models']) {
            await React.act(async () => {
                screen.findByTestId('settings-provider-authoring-name')?.props.onChangeText(value);
                await flushHookEffects();
            });
        }
        expect(describeProviderConnections).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('settings-provider-authoring-connect');
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution', displayName: 'Renamed local models',
        }), 'save'));
    });

    it('re-describes the preview when a default draft becomes named and when discarding restores its default role', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(false));
        expect(describeProviderConnections.mock.calls.at(-1)?.[0]).toMatchObject({
            authoringPreview: { displayName: null },
        });
        describeProviderConnections.mockClear();
        await React.act(async () => {
            screen.findByTestId('settings-provider-authoring-name')?.props.onChangeText('Local models');
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(describeProviderConnections).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({ displayName: 'Local models' }),
        })));
        describeProviderConnections.mockClear();
        await React.act(async () => {
            runGuardedNavigation(() => { routerPush('/settings/providers'); });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        const buttons = modalAlert.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await React.act(async () => {
            buttons.find(button => button.style === 'destructive')?.onPress?.();
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(describeProviderConnections).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({ displayName: null }),
        })));
        expect(screen.findByTestId('settings-provider-authoring-name')?.props.value).toBe('');
        expect(run).not.toHaveBeenCalled();
    });

    it('cancels a named built-in draft without creating a connection', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" displayName="Local models" />,
        );
        const cancel = screen.findByTestId('settings-provider-authoring-cancel');
        expect(cancel).toBeTruthy();
        await React.act(async () => {
            cancel?.props.onPress?.();
            await flushHookEffects();
        });
        expect(run).not.toHaveBeenCalled();
        expect(routerReplace).toHaveBeenCalledWith('/(app)/settings/providers');
    });

    it('opens the projected API-key destination without mutating the Provider draft', async () => {
        state.credential = { required: true, keyUrl: 'https://keys.example.test' };
        describeProviderConnections.mockResolvedValueOnce({
            status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
            diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
            discoveryCandidatesTruncated: false,
            authoringPreview: {
                status: 'resolved', connectionId: 'pc_preview',
                contributionKey: 'acme.plugin/ollama', created: true,
                candidateId: 'discovery-candidate:v1:default',
                scope: 'machine', machineId: 'machine-a',
                endpoints: [{
                    endpointTemplateId: 'chat', protocol: 'openai-chat',
                    normalizedUrl: 'http://127.0.0.1:11434/v1', locality: 'loopback', scope: 'machine',
                }],
                credential: { slotId: 'apiKey', label: 'api_key', required: true },
                fingerprint: 'authoring-review:v1:default', revision: 1,
            },
        });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );

        // Where to get a key sits beside the key field as a quiet link, not a row of its own.
        expect(findProviderExternalLink(screen, 'settingsProviders.links.getApiKey')).toBeDefined();
        await React.act(async () => {
            await findProviderExternalLink(screen, 'settingsProviders.links.getApiKey')?.props.onPress?.();
            await Promise.resolve();
        });

        expect(openUrl).toHaveBeenCalledWith('https://keys.example.test');
        expect(run).not.toHaveBeenCalled();
    });

    it('inspects a foreign daemon but never offers Account A Saved Secrets with colliding ids', async () => {
        state.credential = { required: true };
        state.savedSecrets = [{
            id: 'secret-collision',
            name: 'Account A key',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'account-a-private-key' },
            createdAt: 1,
            updatedAt: 1,
        }];
        await administrationTarget.controller.setMachines([
            { machineId: 'machine-a', displayName: 'Account A machine' },
            {
                machineId: 'machine-a',
                displayName: 'Account B machine',
                serverIdentityId: 'srv_b',
                serverId: 'server-b',
                serverLabel: 'Server B',
            },
        ]);
        await administrationTarget.controller.select('machine-a', 'srv_b');

        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );
        await flushHookEffects();

        const credentialRow = screen.findAllByType(Item).find(
            (item) => item.props.testID === 'settings-provider-authoring-api-key',
        );
        await waitForHomeGovernance(() => expect(findComposite(screen, 'settings-provider-authoring-api-key.choose', 'disabled')?.props.disabled).toBe(true));
        expect(credentialRow?.props.onPress).toBeUndefined();
        expect(credentialRow?.props.subtitle).toBe('settingsProviders.local.accountScopeMismatchDescription');
        const connect = screen.findByTestId('settings-provider-authoring-connect');
        expect(connect?.props.disabled).toBe(true);
        expect(modalShow).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
        expect(stored.writes).toBe(0);
        expect(providerHarness.state.requests.some((request) => (
            request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE
            && request.serverId === resolveServerProfileScopeIdForIdentifier(foreignServerId)
        ))).toBe(true);
    });

    it('stops presenting a retained shared Saved Secret as selected when its canonical projection becomes stale', async () => {
        state.credential = { required: true };
        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({
            features: { providers: { enabled: true }, teams: { enabled: true } },
        }));
        const ref = 'happier:shared-secret:v1:provider-key';
        account.home.answer(account.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [{
            resourceId: 'provider-key', encryptionMode: 'plain', recipientEnvelope: null,
            storedContent: { t: 'plain', v: { v: 1, name: 'Provider key', kind: 'token', value: 'private-key' } },
            entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Provider key', kind: 'token',
                revision: 1, materialStatus: 'ready',
                capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
        }] } });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
        const { storage } = await import('@/sync/domains/state/storage');
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Expected the restored Account settings scope');
        await React.act(async () => { await refreshSavedSecretCatalog(scope); });
        await React.act(async () => {
            findComposite(screen, 'settings-provider-authoring-api-key.choose', 'onPress')?.props.onPress?.();
        });
        const picker = modalShow.mock.calls.at(-1)?.[0] as { props?: { onResult?: (result: { kind: 'selected'; secretRef: string }) => void } } | undefined;
        await React.act(async () => { picker?.props?.onResult?.({ kind: 'selected', secretRef: ref }); });
        // Settings may still hold importer input; it never overrides the
        // selected resource's canonical catalog identity or availability.
        await React.act(async () => {
            state.savedSecrets = [{ id: ref, name: 'Legacy key collision', kind: 'apiKey',
                encryptedValue: { _isSecretValue: true, value: 'legacy-private-key' }, createdAt: 1, updatedAt: 1 }];
        });
        expect(screen.findByTestId('settings-provider-authoring-api-key.saved')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Provider key');
        expect(screen.getTextContent()).not.toContain('Legacy key collision');
        expect(screen.getTextContent()).not.toContain('private-key');

        account.home.answer(account.serverId, '/v1/account/saved-secrets/resources/materials', {
            status: 503, body: { error: 'unavailable' },
        });
        await React.act(async () => { await refreshSavedSecretCatalog(scope).catch(() => undefined); });
        expect(screen.findByTestId('settings-provider-authoring-api-key.saved')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Provider key');
        expect(run).not.toHaveBeenCalled();
    });

    it('defers pristine contribution validation, then presents invalid edited endpoints without enabling Connect', async () => {
        state.contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
        state.providerName = 'CLIProxyAPI';
        describeProviderConnections.mockResolvedValue({ status: 'error', error: createProviderErrorV1('provider_connection_invalid') });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey={state.contributionKey} />);
        await waitForHomeGovernance(() => expect(describeProviderConnections).toHaveBeenCalled());
        expect(screen.findAll(node => node.props.testID === 'provider-error:provider_connection_invalid')).toHaveLength(0);
        expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(true);

        await waitForHomeGovernance(() => expect(screen.findAllByType(FieldTextInput).find(
            field => field.props.testID === 'settings-provider-authoring-endpoint-chat',
        )).toBeDefined());
        await React.act(async () => {
            screen.findAllByType(FieldTextInput).find(
                field => field.props.testID === 'settings-provider-authoring-endpoint-chat',
            )!.props.onChangeText('https://rejected.example.test/v1');
            await flushHookEffects();
        });
        await waitForHomeGovernance(() => expect(screen.findAll(node => node.props.testID === 'provider-error:provider_connection_invalid').length).toBeGreaterThan(0));
        expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(true);
        expect(run).not.toHaveBeenCalled();
    });

    it('presents transport failures before any contribution draft interaction', async () => {
        describeProviderConnections.mockResolvedValue({ status: 'error', error: createProviderErrorV1('provider_machine_unavailable') });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        await waitForHomeGovernance(() => expect(describeProviderConnections).toHaveBeenCalled());
        expect(screen.findAll(node => node.props.testID === 'provider-error:provider_machine_unavailable').length).toBeGreaterThan(0);
        expect(run).not.toHaveBeenCalled();
    });

    it('refuses a selected Account A secret when the target switches to B before save dispatch', async () => {
        state.credential = { required: true };
        state.savedSecrets = [{
            id: 'secret-collision',
            name: 'Account A key',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'account-a-private-key' },
            createdAt: 1,
            updatedAt: 1,
        }];
        await administrationTarget.controller.setMachines([
            { machineId: 'machine-a', displayName: 'Account A machine' },
            {
                machineId: 'machine-a',
                displayName: 'Account B machine',
                serverIdentityId: 'srv_b',
                serverId: 'server-b',
                serverLabel: 'Server B',
            },
        ]);

        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );
        await flushHookEffects();
        await React.act(async () => {
            findComposite(screen, 'settings-provider-authoring-api-key.choose', 'onPress')?.props.onPress?.();
        });
        const picker = modalShow.mock.calls.at(-1)?.[0] as {
            props?: { onResult?: (result: { kind: 'selected'; secretRef: string }) => void };
        } | undefined;
        await React.act(async () => picker?.props?.onResult?.({ kind: 'selected', secretRef: 'secret-collision' }));
        const accountASave = screen.findByTestId('settings-provider-authoring-connect')?.props.onPress;

        await React.act(async () => {
            await administrationTarget.controller.select('machine-a', 'srv_b');
            accountASave?.();
            await Promise.resolve();
        });

        expect(run).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => expect(findComposite(screen, 'settings-provider-authoring-api-key.choose', 'disabled')?.props.disabled).toBe(true));
        expect(stored.writes).toBe(0);
    });

    it('retires Account A authored authoring buffers when the active Account lifetime retires', async () => {

        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await flushHookEffects();
        const nameField = () => screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name');
        const manualModelsField = () => screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.models.addFieldLabel');
        await React.act(async () => {
            nameField()?.props.onChangeText('Account A gateway');
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://account-a.example/v1');
            manualModelsField()?.props.onChangeText('a/account-only-model');
        });
        expect(navigationPreventRemove.enabled).toBe(true);
        await React.act(async () => {
            findComposite(screen, 'settings-provider-authoring-api-key.choose', 'onPress')?.props.onPress?.();
        });
        expect(modalShow).toHaveBeenCalledTimes(1);
        // Captured while Account A is still current: even this stale callback
        // must never be able to save Account A's buffers into Account B.
        const accountASave = screen.findByTestId('settings-provider-authoring-save')?.props.onPress;

        await React.act(async () => {
            await account.restore({ accountId: 'account-b', serverIdentityId: 'srv_provider_screen', machines: [machine] });
            // A fresh Account may view several saved Homes. This case owns one
            // eligible Home, not the fail-closed Home-context availability arm.
            await account.home.selectHomes([account.serverId]);
            await account.selectMachine(account.serverId, 'machine-a');
        });

        expect(modalHide).toHaveBeenCalledWith('provider-secret-picker');
        // Observe the successor's eligible editor, not the availability notice.
        await waitForHomeGovernance(() => expect(nameField()).toBeDefined());
        expect(nameField()?.props.value).toBe('');
        expect(screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')?.props.value).toBe('');
        expect(manualModelsField()?.props.value).toBe('');
        // The guard stays truthful: retirement left no unsaved Account A work.
        expect(navigationPreventRemove.enabled).toBe(false);
        await React.act(async () => { await accountASave?.(); });
        expect(run).not.toHaveBeenCalled();
        expect(routerReplace).not.toHaveBeenCalled();
    });

    it('keeps an Account authored draft while the same Account lifetime stays current', async () => {

        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await flushHookEffects();
        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Same Account gateway');
        });

        // Changed displayName props force the memoized screen to re-run while
        // the same Account lifetime stays captured.
        await screen.update(<ProviderConnectionAuthoringScreen displayName="continuity-render-1" />);
        await screen.update(<ProviderConnectionAuthoringScreen displayName="continuity-render-2" />);

        expect(screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')?.props.value)
            .toBe('Same Account gateway');
        expect(navigationPreventRemove.enabled).toBe(true);
    });

    it('rebuilds built-in contribution buffers under the successor Account after a lifetime retires', async () => {

        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen
                contributionKey="acme.plugin/ollama"
                candidateId="discovery-candidate:v1:account-a"
                displayName="Account A discovered provider"
            />,
        );
        await flushHookEffects();
        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.testID === 'settings-provider-authoring-endpoint-chat')
                ?.props.onChangeText('https://account-a.example/v1');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        await waitForHomeGovernance(() => expect(describeProviderConnections).toHaveBeenLastCalledWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({
                endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://account-a.example/v1' }],
            }),
        })));
        const accountARequestCount = providerHarness.state.requests.length;

        // The incumbent reset retires Account A's lifetime, then Account B
        // mounts on the same route. The changed displayName prop forces the
        // memoized screen to re-run under B's freshly captured lifetime.
        await React.act(async () => {
            await account.restore({ accountId: 'account-b', serverIdentityId: 'srv_provider_screen', machines: [machine] });
            await account.home.selectHomes([account.serverId]);
            await account.selectMachine(account.serverId, 'machine-a');
        });

        await screen.update(
            <ProviderConnectionAuthoringScreen
                contributionKey="acme.plugin/ollama"
                displayName="account-b-render"
            />,
        );
        const accountBPreviews = () => providerHarness.state.requests.slice(accountARequestCount).filter(request =>
            request.accountId === 'account-b'
            && request.method === RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE
            && typeof request.payload === 'object' && request.payload !== null
            && Object.hasOwn(request.payload, 'authoringPreview'));
        await waitForHomeGovernance(() => expect(accountBPreviews().length).toBeGreaterThan(0));

        // Check every actual Account B outward preview, not a historical A call.
        for (const request of accountBPreviews()) {
            expect(request.payload).toMatchObject({ authoringPreview: {
                selectedCandidateId: null,
                displayName: null,
                endpointOverrides: [],
            } });
        }
    });

    it('keeps a draft free of the saved provider\'s `⋯` menu, website included (P2-7)', async () => {
        state.websiteUrl = 'https://provider.example.test';
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-provider-authoring-built-in')).not.toBeNull());

        expect(findEditorMenuAction(screen, 'website')).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
    });

    it('fails closed without any Provider RPC when the feature is unavailable', async () => {
        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: { providers: { enabled: false } } }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );

        expect(presentedTitles(screen))
            .toContain('settingsProviders.unavailable');
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('recovers a directly opened authoring route when Provider availability finishes loading', async () => {
        const { deleteServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        let releaseFeatures!: () => void;
        const pendingFeatures = new Promise<void>(resolve => { releaseFeatures = resolve; });
        const features = createRootLayoutFeaturesResponse({ features: { providers: { enabled: true } } });
        account.home.answer(account.serverId, '/v1/features', { body: features, respondAfter: pendingFeatures });
        account.home.answer(account.serverId, '/v1/features/authenticated', { body: features, respondAfter: pendingFeatures });
        deleteServerFeaturesSnapshot({ serverId: account.serverId });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        expect(providerHarness.state.requests).toEqual([]);
        await React.act(async () => {
            releaseFeatures();
            await account.publishFeatures(account.serverId, features);
            await flushHookEffects();
        });
        expect(providerHarness.state.requests.map(request => request.method)).toContain(RPC_METHODS.DAEMON_PROVIDERS_CONNECTIONS_DESCRIBE);
        expect(screen.findByTestId('settings-provider-authoring-connect')).not.toBeNull();
    });

    it('invalidates a late authoring preview when the feature becomes unavailable', async () => {
        let resolveLatePreview: ((value: unknown) => void) | undefined;
        describeProviderConnections.mockReturnValueOnce(new Promise((resolve) => {
            resolveLatePreview = resolve;
        }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );
        expect(describeProviderConnections).toHaveBeenCalledOnce();

        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: { providers: { enabled: false } } }));
        await screen.update(
            <ProviderConnectionAuthoringScreen
                contributionKey="acme.plugin/ollama"
                displayName="force-disabled-render"
            />,
        );
        await React.act(async () => {
            resolveLatePreview?.(createProviderConnectionsDescribeFixture({
                connections: [],
                authoringPreview: {
                    status: 'resolved',
                    connectionId: ProviderConnectionIdSchema.parse('pc_preview'),
                    contributionKey: 'acme.plugin/ollama',
                    created: true,
                    candidateId: 'discovery-candidate:v1:late',
                    scope: 'machine',
                    machineId: 'machine-a',
                    endpoints: [{
                        endpointTemplateId: 'chat',
                        protocol: 'openai-chat',
                        normalizedUrl: 'http://127.0.0.1:19999/v1',
                        locality: 'loopback',
                        scope: 'machine',
                    }],
                    credential: null,
                    fingerprint: 'authoring-review:v1:late',
                    revision: 1,
                },
            }));
            await Promise.resolve();
        });

        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({ features: { providers: { enabled: true } } }));
        await screen.update(
            <ProviderConnectionAuthoringScreen
                contributionKey="acme.plugin/ollama"
                displayName="force-enabled-render"
            />,
        );

        await waitForHomeGovernance(() => expect(describeProviderConnections).toHaveBeenCalledTimes(2));
        // The add sheet no longer lists a computer destination (PA1), so the adopted review is read
        // from what Connect submits: the current preview, never the late one.
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-connect');
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            authoringReview: expect.objectContaining({ fingerprint: 'authoring-review:v1:default' }),
        }), 'save'));
        expect(JSON.stringify(run.mock.calls)).not.toContain('authoring-review:v1:late');
    });

    it('does not show a fake API-key control for a no-auth contribution', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionAuthoringScreen, {
            contributionKey: 'acme.plugin/ollama',
        }));
        expect(presentedTitles(screen))
            .not.toContain('settingsProviders.authoring.apiKey');
    });

    it('labels only externally sourced contributions as experimental', async () => {
        state.provenance = 'external';
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const external = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        expect(findComposite(external, 'settings-provider-authoring-experimental', 'label')?.props.label)
            .toBe('settingsProviders.compatibility.experimental');

        state.provenance = 'first_party';
        const bundled = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        expect(bundled.findByTestId('settings-provider-authoring-experimental')).toBeNull();
    });

    it('shows an API-key control for optional or required credential contributions', async () => {
        state.credential = { required: false };
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(React.createElement(ProviderConnectionAuthoringScreen, {
            contributionKey: 'acme.plugin/ollama',
        }));
        expect(presentedTitles(screen))
            .toContain('settingsProviders.authoring.apiKey');
    });

    it('does not create a contribution when its required Saved Secret is missing', async () => {
        state.credential = { required: true };
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        // Connect waits for a key: it stays disabled, and pressing it anyway creates nothing.
        const connect = screen.findByTestId('settings-provider-authoring-connect');
        expect(connect?.props.disabled).toBe(true);
        await React.act(async () => { await connect?.props.onPress?.(); });
        expect(run).not.toHaveBeenCalled();
        expect(modalShow).not.toHaveBeenCalled();
    });

    it.each(['custom', 'built-in'] as const)('links the %s Connect key result, preserves it on dismissal, and creates no duplicate Secret', async kind => {
        state.credential = { required: true };
        const ref = await publishProviderKey();
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen {...(kind === 'built-in' ? { contributionKey: 'acme.plugin/ollama' } : {})} />);
        if (kind === 'custom') await React.act(async () => {
            const fields = screen.findAllByType(FieldTextInput);
            fields.find(field => field.props.accessibilityLabel === 'settingsProviders.authoring.name')!.props.onChangeText('Gateway');
            fields.find(field => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')!.props.onChangeText('https://gateway.example/v1');
        });
        const trigger = { measureInWindow: (_callback: unknown) => undefined };
        const sheet = await openProviderKeySheet(screen, { currentTarget: trigger });
        expect(sheet.request).toMatchObject({
            service: { suggestedName: kind === 'built-in' ? 'Ollama' : 'Gateway' },
            anchor: { kind: 'view', ref: { current: trigger } },
        });
        await React.act(async () => { sheet.onResult({ kind: 'connected', secretRef: ref }); });
        expect(screen.getTextContent()).toContain('Provider key');
        const replacement = await openProviderKeySheet(screen);
        expect(replacement.request.current).toBe(ref);
        await React.act(async () => { replacement.onResult({ kind: 'dismissed' }); });
        expect(screen.getTextContent()).toContain('Provider key');
        await screen.pressByTestIdAsync(kind === 'built-in' ? 'settings-provider-authoring-connect' : 'settings-provider-authoring-save');
        if (kind === 'built-in') await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution', savedSecretId: ref,
        }), 'save'));
        else await waitForHomeGovernance(() => expect(JSON.stringify(stored.catalog)).toContain(ref));
        expect(account.home.requestsFor('/v1/account/saved-secrets/resources').filter(request => request.input != null)).toHaveLength(0);
    });

    it('connects a built-in contribution in one step, switched on (PA1)', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        // No "Enable after saving" on the add sheet: a provider someone just connected is simply on.
        expect(screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.enableAfterSaving')).toBeUndefined();
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-connect');
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            enable: true,
            authoringReview: {
                candidateId: 'discovery-candidate:v1:default',
                fingerprint: 'authoring-review:v1:default',
                revision: 1,
                endpointOverrides: [],
            },
        }), 'save'));
    });

    it('retains no save replay after an unknown built-in create outcome', async () => {
        run.mockRejectedValueOnce(new Error('create acknowledgement lost after dispatch'));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-connect');

        await waitForHomeGovernance(() => expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' }));
        expect(screen.findByType(ProviderErrorItems.type).props.retry).toBeUndefined();
        expect(run).toHaveBeenCalledOnce();
        const createRequest = run.mock.calls[0]?.[0] as { connectionId: string };
        const reviewCurrentState = findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState');
        expect(reviewCurrentState).toBeDefined();
        expect(routerPush).not.toHaveBeenCalled();

        await React.act(async () => {
            reviewCurrentState?.props.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(routerPush).toHaveBeenCalledWith(
            `/(app)/settings/providers/${encodeURIComponent(createRequest.connectionId)}`,
        );
        expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' });
        expect(run).toHaveBeenCalledOnce();
    });

    it('requires an exact daemon candidate, keeps the computer destination off the add sheet, and never probes from the browser', async () => {
        describeProviderConnections
            .mockResolvedValueOnce({
                status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
                diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
                discoveryCandidatesTruncated: false,
                authoringPreview: {
                    status: 'selection_required', connectionId: 'pc_preview',
                    contributionKey: 'acme.plugin/ollama', created: true, credential: null,
                    candidates: [
                        {
                            candidateId: 'discovery-candidate:v1:first', scope: 'machine', machineId: 'machine-a',
                            endpoints: [{
                                endpointTemplateId: 'chat', protocol: 'openai-chat',
                                normalizedUrl: 'http://127.0.0.1:11434/v1', locality: 'loopback', scope: 'machine',
                            }],
                        },
                        {
                            candidateId: 'discovery-candidate:v1:second', scope: 'machine', machineId: 'machine-a',
                            endpoints: [{
                                endpointTemplateId: 'chat', protocol: 'openai-chat',
                                normalizedUrl: 'http://127.0.0.1:22434/v1', locality: 'loopback', scope: 'machine',
                            }],
                        },
                    ],
                },
            })
            .mockResolvedValueOnce({
                status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
                diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
                discoveryCandidatesTruncated: false,
                authoringPreview: {
                    status: 'resolved', connectionId: 'pc_preview',
                    contributionKey: 'acme.plugin/ollama', created: true,
                    candidateId: 'discovery-candidate:v1:second', scope: 'machine', machineId: 'machine-a',
                    endpoints: [{
                        endpointTemplateId: 'chat', protocol: 'openai-chat',
                        normalizedUrl: 'http://127.0.0.1:22434/v1', locality: 'loopback', scope: 'machine',
                    }],
                    credential: null,
                    fingerprint: 'authoring-review:v1:second', revision: 1,
                },
            });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        await waitForHomeGovernance(() => expect(screen.findAllByType(Item)
            .find((item) => item.props.title === 'http://127.0.0.1:22434/v1')?.props.onPress).toBeTypeOf('function'));
        const connect = findComposite(screen, 'settings-provider-authoring-connect', 'title');

        expect(connect?.props.onPress).toBeUndefined();
        expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(true);
        expect(run).not.toHaveBeenCalled();

        await React.act(async () => {
            screen.findAllByType(Item)
                .find((item) => item.props.title === 'http://127.0.0.1:22434/v1')
                ?.props.onPress?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        // Choosing is the decision; the resolved computer destination is shown under "On this computer" on the
        // saved provider, not reviewed again here.
        const rows = screen.findAllByType(Item);
        expect(rows.find((item) => item.props.title === 'settingsProviders.authoring.destinationScope')).toBeUndefined();
        expect(rows.find((item) => item.props.title === 'openai-chat')).toBeUndefined();
        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-connect');
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            authoringReview: {
                candidateId: 'discovery-candidate:v1:second',
                fingerprint: 'authoring-review:v1:second',
                revision: 1,
                endpointOverrides: [],
            },
        }), 'save'));
        expect(probeProviderDraft).not.toHaveBeenCalled();
    });

    it('reviews and persists explicit remote endpoints on the same contribution identity', async () => {
        state.contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
        state.providerName = 'CLIProxyAPI';
        state.endpointTemplates = [
            { id: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
            { id: 'cliproxyapi-openai-chat', protocol: 'openai-chat' },
            { id: 'cliproxyapi-anthropic', protocol: 'anthropic' },
        ];
        describeProviderConnections.mockResolvedValueOnce({
            status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
            diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
            discoveryCandidatesTruncated: false,
            authoringPreview: {
                status: 'resolved',
                connectionId: 'pc_preview',
                contributionKey: state.contributionKey,
                created: true,
                candidateId: 'discovery-candidate:v1:local',
                scope: 'machine',
                machineId: 'machine-a',
                endpoints: [{
                    endpointTemplateId: 'cliproxyapi-openai-responses',
                    protocol: 'openai-responses',
                    normalizedUrl: 'http://127.0.0.1:8317/v1',
                    locality: 'loopback',
                    scope: 'machine',
                }, {
                    endpointTemplateId: 'cliproxyapi-anthropic',
                    protocol: 'anthropic',
                    normalizedUrl: 'http://127.0.0.1:8317/',
                    locality: 'loopback',
                    scope: 'machine',
                }],
                credential: null,
                fingerprint: 'authoring-review:v1:local',
                revision: 1,
            },
        }).mockImplementation(async (payload: unknown) => {
            // The daemon's remote review uses the same Account semantics as the subsequent create.
            // Let the real owner derive its fingerprint from the admitted CPX declaration.
            const { describeProviderConnections: describeAccount } = await import('@/providers/actions/client');
            const input = PROVIDER_ACTION_INPUT_SCHEMAS_V1['providers.connections.describe'].parse(payload);
            return describeAccount({ ...input, machineId: undefined, serverId: account.serverId });
        });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey={state.contributionKey} />,
        );

        const fields = screen.findAllByType(FieldTextInput);
        const responses = fields.find((field) =>
            field.props.testID === 'settings-provider-authoring-endpoint-cliproxyapi-openai-responses');
        const chat = fields.find((field) =>
            field.props.testID === 'settings-provider-authoring-endpoint-cliproxyapi-openai-chat');
        const anthropic = fields.find((field) =>
            field.props.testID === 'settings-provider-authoring-endpoint-cliproxyapi-anthropic');
        expect(responses).toBeDefined();
        expect(chat).toBeDefined();
        expect(anthropic).toBeDefined();

        await React.act(async () => {
            responses?.props.onChangeText('https://remote.gateway.example/v1');
            chat?.props.onChangeText('https://remote.gateway.example/v1');
            anthropic?.props.onChangeText('https://remote.gateway.example');
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        const endpointOverrides = [
            { endpointTemplateId: 'cliproxyapi-openai-responses', baseUrl: 'https://remote.gateway.example/v1' },
            { endpointTemplateId: 'cliproxyapi-openai-chat', baseUrl: 'https://remote.gateway.example/v1' },
            { endpointTemplateId: 'cliproxyapi-anthropic', baseUrl: 'https://remote.gateway.example/' },
        ];
        await waitForHomeGovernance(() => expect(describeProviderConnections).toHaveBeenLastCalledWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({
                contributionKey: state.contributionKey,
                selectedCandidateId: null,
                endpointOverrides,
            }),
        })));

        await waitForHomeGovernance(() => expect(screen.findByTestId('settings-provider-authoring-connect')?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-connect');
        await waitForHomeGovernance(() => expect(stored.writes).toBe(1));
        expect(stored.catalog.connections).toEqual([expect.objectContaining({
            source: { kind: 'contribution', contributionKey: state.contributionKey },
            endpointOverrides: [...endpointOverrides].sort((left, right) => left.endpointTemplateId.localeCompare(right.endpointTemplateId)),
        })]);
        expect(run).not.toHaveBeenCalled();
    });

    it('progressively reveals all advanced protocol endpoints without a modal', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const advanced = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.advancedSetup');
        expect(advanced).toBeDefined();
        await React.act(async () => {
            advanced?.props.rightElement.props.onValueChange(true);
        });
        expect(screen.findAllByType(ItemGroup).map((group) => group.props.title)).toEqual(expect.arrayContaining([
            'settingsProviders.authoring.protocol.openai-responses.title',
            'settingsProviders.authoring.protocol.openai-chat.title',
            'settingsProviders.authoring.protocol.anthropic.title',
            'settingsProviders.authoring.catalogTitle',
        ]));
        const advancedSwitchRows = screen.findAllByType(Item).filter((item) => (
            item.props.title === 'settingsProviders.authoring.endpointEnabled'
            || item.props.title === 'settingsProviders.authoring.requiresApiKey'
        ));
        expect(advancedSwitchRows.length).toBeGreaterThan(0);
        expect(advancedSwitchRows
            .filter((row) => row.props.title === 'settingsProviders.authoring.endpointEnabled')
            .map((row) => row.props.rightElement.props.accessibilityLabel))
            .toEqual([
                'settingsProviders.authoring.protocol.openai-responses.title, settingsProviders.authoring.endpointEnabled',
                'settingsProviders.authoring.protocol.openai-chat.title, settingsProviders.authoring.endpointEnabled',
                'settingsProviders.authoring.protocol.anthropic.title, settingsProviders.authoring.endpointEnabled',
            ]);
    });

    it('returns an invalid advanced-header probe to its preserved draft without routing', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const advanced = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.advancedSetup');

        await React.act(async () => {
            advanced?.props.rightElement.props.onValueChange(true);
        });
        const fields = screen.findAllByType(FieldTextInput);
        await React.act(async () => {
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Draft gateway');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('http://127.0.0.1:38197');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.publicHeaders')
                ?.props.onChangeText('Authorization: forbidden');
        });
        const test = findDraftTestRow(screen);
        await React.act(async () => { await test?.props.onPress?.(); });

        expect(probeProviderDraft).not.toHaveBeenCalled();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.connectionInvalidTitle');
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.actions.reviewConnection');
        expect(presentedTitles(screen))
            .not.toContain('settingsProviders.errors.unreachableTitle');

        await React.act(async () => {
            findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewConnection')?.props.onPress?.();
            await Promise.resolve();
        });

        expect(routerPush).not.toHaveBeenCalled();
        expect(screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')?.props.value)
            .toBe('Draft gateway');
        expect(screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')?.props.value)
            .toBe('http://127.0.0.1:38197');
        expect(screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.publicHeaders')?.props.value)
            .toBe('Authorization: forbidden');
        expect(presentedTitles(screen))
            .not.toContain('settingsProviders.errors.actions.reviewConnection');
        expect(focusField).toHaveBeenCalledWith('settings-provider-authoring-base-url');
        expect(typeof findDraftTestRow(screen)?.props.onPress)
            .toBe('function');
    });

    it('returns a malformed daemon probe response to its preserved draft without routing', async () => {
        probeProviderDraft.mockImplementationOnce(async (request: { draftConnectionId: string }) => ({
            status: 'error',
            error: createProviderErrorV1('provider_probe_response_invalid', {
                connectionId: request.draftConnectionId,
                machineId: 'machine-a',
            }),
        }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);

        await React.act(async () => {
            const fields = screen.findAllByType(FieldTextInput);
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Malformed-response draft');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            screen.findAllByType(Item)
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        await React.act(async () => {
            findDraftTestRow(screen)
                ?.props.onPress?.();
            await Promise.resolve();
        });
        await waitForHomeGovernance(() => expect(findProviderRecoveryAction(screen,
            'settingsProviders.errors.actions.reviewConnection')).toBeDefined());
        await React.act(async () => {
            findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewConnection')?.props.onPress?.();
            await Promise.resolve();
        });

        expect(routerPush).not.toHaveBeenCalled();
        expect(screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')?.props.value)
            .toBe('Malformed-response draft');
        expect(screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')?.props.value)
            .toBe('https://gateway.example/v1');
        expect(presentedTitles(screen))
            .not.toContain('settingsProviders.errors.actions.reviewConnection');
        expect(focusField).toHaveBeenCalledWith('settings-provider-authoring-base-url');
    });

    it('lets a successful active-guard save own the resulting Provider detail destination', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            await Promise.resolve();
        });

        expect(getActiveUnsavedChangesGuard()?.continueOnSave).toBe(false);
    });

    it('stays pristine when the resolved target machine changes under an untouched form', async () => {
        // The target machine is a persisted Administration preference that can
        // resolve or move after the first render — automatic sole-candidate
        // initialization does exactly that. It is not user-entered draft
        // content, so an untouched form must not claim unsaved changes.
        await administrationTarget.controller.setMachines([
            { machineId: 'machine-a' },
            { machineId: 'machine-b' },
        ]);
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        await renderScreen(<ProviderConnectionAuthoringScreen />);
        expect(navigationPreventRemove.enabled).toBe(false);

        await React.act(async () => {
            await administrationTarget.controller.select('machine-b');
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(navigationPreventRemove.enabled).toBe(false);
    });

    it('keeps or discards a dirty Provider draft through the shared navigation transaction', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Unsaved gateway');
        });

        expect(navigationPreventRemove.enabled).toBe(true);
        const action = { type: 'GO_BACK' };
        await React.act(async () => {
            navigationPreventRemove.callback?.({ data: { action } });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        const firstButtons = modalAlert.mock.calls.at(-1)?.[2] as Array<{
            style?: string;
            onPress?: () => void;
        }>;
        await React.act(async () => {
            firstButtons.find((button) => button.style === 'cancel')?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        expect(navigationDispatch).not.toHaveBeenCalled();
        expect(navigationPreventRemove.enabled).toBe(true);

        await React.act(async () => {
            navigationPreventRemove.callback?.({ data: { action } });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        const secondButtons = modalAlert.mock.calls.at(-1)?.[2] as Array<{
            style?: string;
            onPress?: () => void;
        }>;
        await React.act(async () => {
            secondButtons.find((button) => button.style === 'destructive')?.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        expect(navigationDispatch).toHaveBeenCalledOnce();
        expect(navigationDispatch).toHaveBeenCalledWith(action);
        expect(run).not.toHaveBeenCalled();
        expect(screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')?.props.value).toBe('');
        expect(navigationPreventRemove.enabled).toBe(false);
    });

    it('keeps the draft when its Machine field changes and still guards departure', () => withPopoverWebGlobals(async () => {
        await administrationTarget.controller.setMachines([{ machineId: 'machine-a' }, { machineId: 'machine-b' }]);
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const { MachineAdministrationContextBar } = await import('@/components/settings/machines/MachineAdministrationContextBar');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const field = (label: string) => screen.findAllByType(FieldTextInput)
            .find((entry) => entry.props.accessibilityLabel === label);
        const name = 'Keep this gateway';
        const baseUrl = 'https://gateway.example/v1';
        const models = '/models';
        await React.act(async () => {
            field('settingsProviders.authoring.name')!.props.onChangeText(name);
            field('settingsProviders.authoring.baseUrl')!.props.onChangeText(baseUrl);
            field('settingsProviders.authoring.modelsPath')!.props.onChangeText(models);
        });
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        modalAlert.mockClear();
        await screen.pressByTestIdAsync('settings.providers.administration.target.chip');
        await React.act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 400 }); });
        await screen.pressByTestIdAsync('settings.providers.administration.target.picker-option:machine-b');
        expect(modalAlert).not.toHaveBeenCalled();
        expect(screen.findByType(MachineAdministrationContextBar).props.selection.selectedTarget?.machineId).toBe('machine-b');
        expect(field('settingsProviders.authoring.name')?.props.value).toBe(name);
        expect(field('settingsProviders.authoring.baseUrl')?.props.value).toBe(baseUrl);
        expect(field('settingsProviders.authoring.modelsPath')?.props.value).toBe(models);
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);

        // A real departure is still a navigation transaction, unlike editing the Machine field.
        let navigationResult: true | Promise<boolean> = true;
        await React.act(async () => {
            navigationResult = runGuardedNavigation(() => { routerPush('/settings/providers/pc_other'); });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        expect(routerPush).not.toHaveBeenCalled();
        const buttons = modalAlert.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void }>;
        expect(buttons.some(button => button.style === 'destructive')).toBe(true);
        await React.act(async () => {
            buttons.find(button => button.style === 'cancel')!.onPress?.();
            await navigationResult;
        });
        expect(routerPush).not.toHaveBeenCalled();
        expect(field('settingsProviders.authoring.name')?.props.value).toBe(name);
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        expect(run).not.toHaveBeenCalled();
    }));

    it('keeps the required connection name visible, focusable, and continuous in advanced mode', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const advanced = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.advancedSetup');
        const nameField = () => screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name');

        await React.act(async () => { nameField()?.props.onChangeText('Company gateway'); });
        await React.act(async () => { advanced?.props.rightElement.props.onValueChange(true); });

        expect(nameField()?.props.value).toBe('Company gateway');
        await React.act(async () => { nameField()?.props.onChangeText(''); });
        const save = screen.findByTestId('settings-provider-authoring-save');
        await React.act(async () => { await save?.props.onPress?.(); });

        expect(run).not.toHaveBeenCalled();
        expect(nameField()?.props.error).toBeTruthy();
        expect(focusField).toHaveBeenCalledWith('settings-provider-authoring-name');

        await React.act(async () => { nameField()?.props.onChangeText('Recovered gateway'); });
        await React.act(async () => { advanced?.props.rightElement.props.onValueChange(false); });
        expect(nameField()?.props.value).toBe('Recovered gateway');
    });

    it('labels every standalone authoring switch with its owning row', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const switchRows = screen.findAllByType(Item).filter((item) => (
            typeof item.props.rightElement?.props?.onValueChange === 'function'
        ));

        expect(switchRows.length).toBeGreaterThan(0);
        for (const row of switchRows) {
            expect(row.props.rightElement.props.accessibilityLabel).toBe(row.props.title);
        }
    });

    it('sends initial manual models inside the one create mutation', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const fields = screen.findAllByType(FieldTextInput);
        await React.act(async () => {
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')?.props.onChangeText('Anthropic bridge');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')?.props.onChangeText('https://gateway.example/anthropic');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.models.addFieldLabel')?.props.onChangeText('first/model\nsecond/model');
            screen.findAllByType(Item)
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        const save = screen.findByTestId('settings-provider-authoring-save');
        await React.act(async () => { await save?.props.onPress?.(); });
        expect(stored.writes).toBe(1);
        const connection = stored.catalog.connections[0]!;
        expect(connection.source.kind).toBe('custom');
        expect(stored.catalog.manualModelsByConnectionId[connection.id]).toEqual([
            expect.objectContaining({ id: 'first/model' }), expect.objectContaining({ id: 'second/model' }),
        ]);
        expect(run).not.toHaveBeenCalled();
    });

    it.each(['name', 'url', 'models'] as const)('validates custom %s before binding the selected key', async invalid => {
        const ref = await publishProviderKey();
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            const fields = screen.findAllByType(FieldTextInput);
            fields.find(field => field.props.accessibilityLabel === 'settingsProviders.authoring.name')!.props.onChangeText(invalid === 'name' ? '' : 'Gateway');
            fields.find(field => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')!.props.onChangeText(invalid === 'url' ? 'invalid-url' : 'https://gateway.example/v1');
            if (invalid === 'models') fields.find(field => field.props.accessibilityLabel === 'settingsProviders.models.addFieldLabel')!.props.onChangeText('bad model');
        });
        const sheet = await openProviderKeySheet(screen);
        await React.act(async () => { sheet.onResult({ kind: 'selected', secretRef: ref }); });
        await screen.pressByTestIdAsync('settings-provider-authoring-save');
        expect(account.home.requestsFor('/v1/account/saved-secrets/resources').filter(request => request.input != null)).toHaveLength(0);
        expect(stored.writes).toBe(0);
    });

    it('retains the selected key reference for an intentional connection-save retry', async () => {
        state.credential = { required: true };
        const ref = await publishProviderKey();
        run.mockResolvedValueOnce({ status: 'error', error: createProviderErrorV1('provider_endpoint_unreachable') });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        const sheet = await openProviderKeySheet(screen);
        await React.act(async () => { sheet.onResult({ kind: 'selected', secretRef: ref }); });
        await screen.pressByTestIdAsync('settings-provider-authoring-connect');
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledTimes(1));
        await flushHookEffects();
        await screen.pressByTestIdAsync('settings-provider-authoring-connect');
        await waitForHomeGovernance(() => expect(run).toHaveBeenCalledTimes(2));
        expect(run.mock.calls.map(call => call[0].savedSecretId)).toEqual([ref, ref]);
        expect(account.home.requestsFor('/v1/account/saved-secrets/resources').filter(request => request.input != null)).toHaveLength(0);
    });

    it('retains no save replay after an unknown custom create outcome', async () => {
        account.home.answer(account.serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, { dispatchThenFail: true });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const fields = screen.findAllByType(FieldTextInput);
        await React.act(async () => {
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')?.props.onChangeText('Gateway');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')?.props.onChangeText('https://gateway.example/v1');
            screen.findAllByType(Item)
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        await React.act(async () => {
            await screen.findByTestId('settings-provider-authoring-save')?.props.onPress?.();
        });

        expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' });
        expect(screen.findByType(ProviderErrorItems.type).props.retry).toBeUndefined();
        const writes = () => account.home.requestsFor(PROVIDER_CONNECTIONS_ROWS_ROUTE_V1).filter(request => request.input != null);
        expect(writes()).toHaveLength(1);
        const mutation = ProviderConnectionsRowMutationV1Schema.parse(writes()[0]!.input);
        if (mutation.content?.t !== 'plain') throw new Error('Expected a Plain Account write');
        const connectionId = mutation.content.v.connections[0]!.id;
        const reviewCurrentState = findProviderRecoveryAction(screen, 'settingsProviders.errors.actions.reviewCurrentState');
        expect(reviewCurrentState).toBeDefined();
        expect(routerPush).not.toHaveBeenCalled();

        await React.act(async () => {
            reviewCurrentState?.props.onPress?.();
            await flushHookEffects({ cycles: 1, turns: 2 });
        });

        expect(routerPush).toHaveBeenCalledWith(
            `/(app)/settings/providers/${encodeURIComponent(connectionId)}`,
        );
        expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' });
        expect(writes()).toHaveLength(1);
        expect(run).not.toHaveBeenCalled();
        expect(focusField).not.toHaveBeenCalled();
    });

    it('blocks custom creation and marks rejected manual model lines inline', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const fields = screen.findAllByType(FieldTextInput);
        await React.act(async () => {
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')?.props.onChangeText('Gateway');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')?.props.onChangeText('https://gateway.example/v1');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.models.addFieldLabel')?.props.onChangeText('valid-model\nbad model');
            screen.findAllByType(Item)
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });

        const save = screen.findByTestId('settings-provider-authoring-save');
        await React.act(async () => { await save?.props.onPress?.(); });

        expect(run).not.toHaveBeenCalled();
        const manualModels = screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.models.addFieldLabel');
        expect(manualModels?.props.error).toBeTruthy();
        expect(focusField).toHaveBeenCalledWith('provider-manual-model-ids');
    });

    it('shows exact machine-scoped confirmation for a local address and respects disabled save intent', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            const fields = screen.findAllByType(FieldTextInput);
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')?.props.onChangeText('Local gateway');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')?.props.onChangeText('http://127.0.0.1:1234/v1');
            screen.findAllByType(Item)
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        const localNotice = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.localAddressTitle');
        expect(localNotice?.props.subtitle).toBe(
            'settingsProviders.authoring.localAddressDescription(machine=Mac,endpoint=http://127.0.0.1:1234/v1)',
        );
        const enable = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.enableAfterSaving');
        await React.act(async () => { enable?.props.rightElement.props.onValueChange(false); });
        const save = screen.findByTestId('settings-provider-authoring-save');
        await React.act(async () => { await save?.props.onPress?.(); });
        expect(stored.writes).toBe(1);
        expect(stored.catalog.connections[0]!.source.kind).toBe('custom');
        expect(stored.catalog.accountGrants).toEqual([]);
        expect(stored.catalog.machineGrants).toEqual([]);
        expect(run).not.toHaveBeenCalled();
    });

    it('ignores a probe response that completes after the draft changes', async () => {
        let resolveProbe: ((value: unknown) => void) | undefined;
        probeProviderDraft.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const requiresApiKey = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey');
        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://initial.example/v1');
            requiresApiKey?.props.rightElement.props.onValueChange(false);
        });
        await waitForHomeGovernance(() => expect(findDraftTestRow(screen)?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-test');
        await waitForHomeGovernance(() => expect(probeProviderDraft).toHaveBeenCalledOnce());
        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://changed.example/v1');
        });
        await React.act(async () => {
            resolveProbe?.({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:late' });
            await Promise.resolve();
        });
        const refreshedTest = findDraftTestRow(screen);
        expect(refreshedTest?.props.subtitle).toBeNull();
        expect(refreshedTest?.props.loading).toBe(false);
    });

    it('retains successful Test connection truth across a display-only rename', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const requiresApiKey = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey');
        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            requiresApiKey?.props.rightElement.props.onValueChange(false);
        });
        await waitForHomeGovernance(() => expect(findDraftTestRow(screen)?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-test');
        await waitForHomeGovernance(() => expect(findDraftTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded'));
        expect(probeProviderDraft).toHaveBeenCalledOnce();

        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Renamed gateway');
        });

        expect(findDraftTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');
    });

    it('invalidates successful Test connection truth after the manual model list changes', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            const fields = screen.findAllByType(FieldTextInput);
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            screen.findAllByType(Item)
                .find((item) => item.props.title === 'settingsProviders.authoring.requiresApiKey')
                ?.props.rightElement.props.onValueChange(false);
        });
        await waitForHomeGovernance(() => expect(findDraftTestRow(screen)?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-test');
        await waitForHomeGovernance(() => expect(findDraftTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded'));

        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.models.addFieldLabel')
                ?.props.onChangeText('model-after-success');
        });

        expect(findDraftTestRow(screen)?.props.subtitle)
            .toBeNull();
    });

    it.each(['is revalidated', 'rotates', 'is deleted', 'access is removed'] as const)('keeps Test connection truth current when the selected Saved Secret %s', async change => {
        await account.publishFeatures(account.serverId, createRootLayoutFeaturesResponse({
            features: { providers: { enabled: true }, teams: { enabled: true } },
        }));
        const ref = 'happier:shared-secret:v1:gateway-key';
        const publishSecret = (revision: number, value: string, materialStatus: 'ready' | 'access_removed' = 'ready') => account.home.answer(account.serverId,
            '/v1/account/saved-secrets/resources/materials', { body: { resources: [{
                resourceId: 'gateway-key', encryptionMode: 'plain', recipientEnvelope: null,
                storedContent: { t: 'plain', v: { v: 1, name: 'Gateway key', kind: 'token', value } },
                entry: { ref, source: 'shared_resource', relationship: 'owner', name: 'Gateway key', kind: 'token',
                    revision, materialStatus,
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
            }] } });
        publishSecret(1, 'gateway-private-a');
        let settleProbe!: (value: unknown) => void;
        if (change === 'is revalidated') probeProviderDraft.mockReturnValueOnce(new Promise(resolve => { settleProbe = resolve; }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        const { refreshSavedSecretCatalog } = await import('@/sync/engine/settings/savedSecretCatalogEngine');
        const { storage } = await import('@/sync/domains/state/storage');
        const scope = storage.getState().settingsScope;
        if (!scope) throw new Error('Expected the restored Account settings scope');
        await React.act(async () => { await refreshSavedSecretCatalog(scope); });
        await React.act(async () => {
            const fields = screen.findAllByType(FieldTextInput);
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            findComposite(screen, 'settings-provider-authoring-api-key.choose', 'onPress')?.props.onPress?.();
        });
        const picker = modalShow.mock.calls.at(-1)?.[0] as { props?: { onResult?: (result: { kind: 'selected'; secretRef: string }) => void } } | undefined;
        await React.act(async () => {
            picker?.props?.onResult?.({ kind: 'selected', secretRef: ref });
        });
        await waitForHomeGovernance(() => expect(findDraftTestRow(screen)?.props.disabled).toBe(false));
        await screen.pressByTestIdAsync('settings-provider-authoring-test');
        if (change === 'is revalidated') {
            await waitForHomeGovernance(() => expect(probeProviderDraft).toHaveBeenCalledOnce());
            expect(findDraftTestRow(screen)?.props.loading).toBe(true);
            const { invalidateSavedSecretCatalog } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
            await React.act(async () => { invalidateSavedSecretCatalog(scope); });
            expect(findDraftTestRow(screen)?.props.loading).toBe(true);
            await React.act(async () => {
                settleProbe({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:revalidated' });
            });
        }
        await waitForHomeGovernance(() => expect(findDraftTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded'));
        if (change === 'is revalidated') return;

        await React.act(async () => {
            if (change === 'rotates') publishSecret(2, 'gateway-private-b');
            else if (change === 'access is removed') publishSecret(1, 'gateway-private-a', 'access_removed');
            else account.home.answer(account.serverId, '/v1/account/saved-secrets/resources/materials', { body: { resources: [] } });
            await refreshSavedSecretCatalog(scope);
        });

        expect(findDraftTestRow(screen)?.props.subtitle)
            .toBeNull();
    });

    it('renders an opaque probe failure with its canonical recovery without invoking save', async () => {
        probeProviderDraft
            .mockRejectedValueOnce(new Error('socket implementation detail'))
            .mockResolvedValueOnce({ status: 'success', models: [], requestFingerprint: 'probe-request:v1:retry' });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);

        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Retry gateway');
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://models.example/v1');
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const test = findDraftTestRow(screen);
        await React.act(async () => {
            test?.props.onPress?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.genericTitle');
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.actions.reviewConnection');
        expect(run).not.toHaveBeenCalled();
    });
});
