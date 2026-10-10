import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorV1, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
    createProviderConnectionsDescribeFixture,
    createProviderSettingsHarness,
    flushHookEffects,
    installProviderSettingsRpcBoundary,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
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
    const button = screen.findByTestId('settings-provider-authoring-test');
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
    return screen.findAll(node => node.props.accessibilityRole === 'button'
        && node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
}


/** The rendered component that carries `prop` for a test id (the host view under it carries none). */
function findComposite(screen: RenderedScreen, testID: string, prop: string) {
    return screen.findAllByTestId(testID).find((node) => node.props[prop] !== undefined) ?? null;
}

await loadSyncSingletonForTests();
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
        await account.restore({ serverIdentityId: 'srv_provider_screen', machines: [machine], waivedActions: [
            'providers.connections.create_contribution', 'providers.connections.create_custom',
            'providers.connections.enabled.set', 'providers.probe',
        ] });
        await account.selectMachine(account.serverId, 'machine-a');
        foreignServerId = await account.addHome({
            name: 'Other Provider Account', serverUrl: 'https://provider-foreign.test', serverIdentityId: 'srv_b', accountId: 'account-foreign', active: false,
        });
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

    it('edits a built-in connection name in the shared draft and writes it only on Connect', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" displayName="Local models" />,
        );
        const name = screen.findByTestId('settings-provider-authoring-name');
        expect(name?.props.value).toBe('Local models');
        await React.act(async () => {
            name?.props.onChangeText('Renamed local models');
            await flushHookEffects();
        });
        expect(run).not.toHaveBeenCalled();
        expect(describeProviderConnections).toHaveBeenLastCalledWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({ displayName: 'Renamed local models' }),
        }));
        await React.act(async () => {
            screen.findByTestId('settings-provider-authoring-connect')?.props.onPress?.();
            await flushHookEffects();
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution', displayName: 'Renamed local models',
        }), 'save');
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

        const getKeyRow = screen.findAllByType(Item)
            .find((item) => item.props.accessibilityLabel === 'settingsProviders.links.getApiKey');
        expect(getKeyRow?.props.accessibilityLabel).toBe('settingsProviders.links.getApiKey');
        expect(getKeyRow?.props.onPress).toBeUndefined();
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
        expect(credentialRow?.props.rightElement.props.disabled).toBe(true);
        expect(credentialRow?.props.onPress).toBeUndefined();
        expect(credentialRow?.props.subtitle).toBe('settingsProviders.local.accountScopeMismatchDescription');
        const connect = screen.findByTestId('settings-provider-authoring-connect');
        expect(connect?.props.disabled).toBe(true);
        expect(modalShow).not.toHaveBeenCalled();
        expect(run).not.toHaveBeenCalled();
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
            screen.findByTestId('settings-provider-authoring-api-key.choose')?.props.onPress?.();
        });
        const picker = modalShow.mock.calls.at(-1)?.[0] as { props?: { onSelectId?: (id: string | null) => void } } | undefined;
        await React.act(async () => { picker?.props?.onSelectId?.(ref); });
        expect(screen.findByTestId('settings-provider-authoring-api-key.saved')).not.toBeNull();

        account.home.answer(account.serverId, '/v1/account/saved-secrets/resources/materials', {
            status: 503, body: { error: 'unavailable' },
        });
        await React.act(async () => { await refreshSavedSecretCatalog(scope).catch(() => undefined); });
        expect(screen.findByTestId('settings-provider-authoring-api-key.saved')).toBeNull();
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
            screen.findByTestId('settings-provider-authoring-api-key.choose')?.props.onPress?.();
        });
        const picker = modalShow.mock.calls.at(-1)?.[0] as {
            props?: { onSelectId?: (id: string | null) => void };
        } | undefined;
        await React.act(async () => picker?.props?.onSelectId?.('secret-collision'));
        const accountASave = screen.findByTestId('settings-provider-authoring-connect')?.props.onPress;

        await React.act(async () => {
            await administrationTarget.controller.select('machine-a', 'srv_b');
            accountASave?.();
            await Promise.resolve();
        });

        expect(run).not.toHaveBeenCalled();
        expect(screen.findAllByType(Item).find(
            (item) => item.props.testID === 'settings-provider-authoring-api-key',
        )?.props.rightElement.props.disabled).toBe(true);
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
            screen.findByTestId('settings-provider-authoring-api-key.choose')?.props.onPress?.();
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
        expect(describeProviderConnections).toHaveBeenLastCalledWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({
                endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://account-a.example/v1' }],
            }),
        }));
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

    it('shows the Provider website independently from credential metadata', async () => {
        state.websiteUrl = 'https://provider.example.test';
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );
        const titles = presentedTitles(screen);

        expect(findEditorMenuAction(screen, 'website')).toBeDefined();
        expect(titles).not.toContain('settingsProviders.links.getApiKey');
        await React.act(async () => {
            await findEditorMenuAction(screen, 'website')?.props.onPress?.();
            await Promise.resolve();
        });

        expect(openUrl).toHaveBeenCalledWith('https://provider.example.test');
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

        expect(describeProviderConnections).toHaveBeenCalledTimes(2);
        const subtitles = screen.findAllByType(Item).map((item) => item.props.subtitle);
        expect(subtitles).toContain('http://127.0.0.1:11434/v1');
        expect(subtitles).not.toContain('http://127.0.0.1:19999/v1');
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
        const connect = screen.findByTestId('settings-provider-authoring-connect');
        await React.act(async () => { await connect?.props.onPress?.(); });
        expect(run).not.toHaveBeenCalled();
        expect(presentedTitles(screen))
            .toContain('settingsProviders.errors.secretMissingTitle');
    });

    it('preserves explicit disabled intent when connecting a built-in contribution', async () => {
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />);
        const enable = screen.findAllByType(Item)
            .find((item) => item.props.title === 'settingsProviders.authoring.enableAfterSaving');
        expect(enable).toBeDefined();
        await React.act(async () => { enable?.props.rightElement.props.onValueChange(false); });
        const connect = screen.findByTestId('settings-provider-authoring-connect');
        await React.act(async () => { await connect?.props.onPress?.(); });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            enable: false,
            authoringReview: {
                candidateId: 'discovery-candidate:v1:default',
                fingerprint: 'authoring-review:v1:default',
                revision: 1,
                endpointOverrides: [],
            },
        }), 'save');
    });

    it('retains no save replay after an unknown built-in create outcome', async () => {
        run.mockRejectedValueOnce(new Error('create acknowledgement lost after dispatch'));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const { ProviderErrorItems } = await import('./ProviderErrorItems');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey="acme.plugin/ollama" />,
        );

        await React.act(async () => {
            await screen.findByTestId('settings-provider-authoring-connect')?.props.onPress?.();
        });

        expect(screen.findByType(ProviderErrorItems.type).props.error)
            .toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown' });
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

    it('requires an exact daemon candidate, reviews its normalized destination, and never probes from the browser', async () => {
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
        const connect = findComposite(screen, 'settings-provider-authoring-connect', 'title');

        expect(connect?.props.onPress).toBeUndefined();
        expect(run).not.toHaveBeenCalled();

        await React.act(async () => {
            screen.findAllByType(Item)
                .find((item) => item.props.title === 'http://127.0.0.1:22434/v1')
                ?.props.onPress?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        const rows = screen.findAllByType(Item);
        expect(rows.find((item) => item.props.title === 'settingsProviders.authoring.destinationScope')?.props.subtitle)
            .toBe('settingsProviders.authoring.destinationMachine · Mac');
        expect(rows.find((item) => item.props.title === 'openai-chat')?.props.subtitle)
            .toBe('http://127.0.0.1:22434/v1');
        await React.act(async () => {
            await screen.findByTestId('settings-provider-authoring-connect')?.props.onPress?.();
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            authoringReview: {
                candidateId: 'discovery-candidate:v1:second',
                fingerprint: 'authoring-review:v1:second',
                revision: 1,
                endpointOverrides: [],
            },
        }), 'save');
        expect(probeProviderDraft).not.toHaveBeenCalled();
    });

    it('reviews and persists explicit remote endpoints on the same contribution identity', async () => {
        state.contributionKey = 'happier.provider.cliproxyapi/cliproxyapi';
        state.providerName = 'CLIProxyAPI';
        state.endpointTemplates = [
            { id: 'responses', protocol: 'openai-responses' },
            { id: 'anthropic', protocol: 'anthropic' },
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
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                    normalizedUrl: 'http://127.0.0.1:8317/v1',
                    locality: 'loopback',
                    scope: 'machine',
                }, {
                    endpointTemplateId: 'anthropic',
                    protocol: 'anthropic',
                    normalizedUrl: 'http://127.0.0.1:8317/',
                    locality: 'loopback',
                    scope: 'machine',
                }],
                credential: null,
                fingerprint: 'authoring-review:v1:local',
                revision: 1,
            },
        }).mockResolvedValueOnce({
            status: 'success', connections: [], available: [], discoveryCandidates: [], localInstallations: [],
            diagnostics: [], diagnosticsTruncated: false, availableTruncated: false,
            discoveryCandidatesTruncated: false,
            authoringPreview: {
                status: 'resolved',
                connectionId: 'pc_preview',
                contributionKey: state.contributionKey,
                created: true,
                candidateId: null,
                scope: 'account',
                machineId: null,
                endpoints: [{
                    endpointTemplateId: 'responses',
                    protocol: 'openai-responses',
                    normalizedUrl: 'https://remote.gateway.example/v1',
                    locality: 'public',
                    scope: 'account',
                }, {
                    endpointTemplateId: 'anthropic',
                    protocol: 'anthropic',
                    normalizedUrl: 'https://remote.gateway.example/',
                    locality: 'public',
                    scope: 'account',
                }],
                credential: null,
                fingerprint: 'authoring-review:v1:remote',
                revision: 1,
            },
        });
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(
            <ProviderConnectionAuthoringScreen contributionKey={state.contributionKey} />,
        );

        const fields = screen.findAllByType(FieldTextInput);
        const responses = fields.find((field) =>
            field.props.testID === 'settings-provider-authoring-endpoint-responses');
        const anthropic = fields.find((field) =>
            field.props.testID === 'settings-provider-authoring-endpoint-anthropic');
        expect(responses).toBeDefined();
        expect(anthropic).toBeDefined();

        await React.act(async () => {
            responses?.props.onChangeText('https://remote.gateway.example/v1');
            anthropic?.props.onChangeText('https://remote.gateway.example');
            await flushHookEffects({ cycles: 2, turns: 2 });
        });

        const endpointOverrides = [
            { endpointTemplateId: 'responses', baseUrl: 'https://remote.gateway.example/v1' },
            { endpointTemplateId: 'anthropic', baseUrl: 'https://remote.gateway.example/' },
        ];
        expect(describeProviderConnections).toHaveBeenLastCalledWith(expect.objectContaining({
            authoringPreview: expect.objectContaining({
                contributionKey: state.contributionKey,
                selectedCandidateId: null,
                endpointOverrides,
            }),
        }));

        await React.act(async () => {
            await screen.findByTestId('settings-provider-authoring-connect')
                ?.props.onPress?.();
        });
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createContribution',
            contributionKey: state.contributionKey,
            authoringReview: {
                candidateId: null,
                fingerprint: 'authoring-review:v1:remote',
                revision: 1,
                endpointOverrides,
            },
        }), 'save');
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

    it.each(['custom', 'detected'] as const)('discards the mounted %s authoring draft when the shared machine selector changes target', async (kind) => {
        await administrationTarget.controller.setMachines([{ machineId: 'machine-a' }, { machineId: 'machine-b' }]);
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen {...(kind === 'detected' ? {
            contributionKey: 'acme.plugin/ollama',
            candidateId: 'discovery-candidate:v1:default',
            displayName: 'Detected Ollama',
        } : {})} />);
        const nameField = () => screen.findAllByType(FieldTextInput)
            .find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name');
        await React.act(async () => {
            if (kind === 'custom') nameField()?.props.onChangeText('Discard this draft');
            else screen.findAllByType(Item)
                .find((item) => item.props.title === 'settingsProviders.authoring.enableAfterSaving')
                ?.props.rightElement.props.onValueChange(false);
        });
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(true);
        let navigationResult: true | Promise<boolean> = true;
        await React.act(async () => {
            navigationResult = runGuardedNavigation(async () => { await administrationTarget.controller.select('machine-b'); });
            await flushHookEffects({ cycles: 1, turns: 2 });
        });
        const buttons = modalAlert.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void }>;
        await React.act(async () => {
            buttons.find((button) => button.style === 'destructive')?.onPress?.();
            await navigationResult;
        });
        if (kind === 'custom') expect(nameField()?.props.value).toBe('');
        expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(false);
        if (kind === 'detected') {
            await React.act(async () => {
                screen.findAllByType(Item)
                    .find((item) => item.props.title === 'settingsProviders.authoring.enableAfterSaving')
                    ?.props.rightElement.props.onValueChange(false);
            });
            await React.act(async () => {
                navigationResult = runGuardedNavigation(() => { routerPush('/settings/providers/pc_other'); });
                await flushHookEffects({ cycles: 1, turns: 2 });
            });
            const nextButtons = modalAlert.mock.calls.at(-1)?.[2] as Array<{ style?: string; onPress?: () => void }>;
            await React.act(async () => {
                nextButtons.find((button) => button.style === 'destructive')?.onPress?.();
                await navigationResult;
            });
            expect(describeProviderConnections.mock.calls.at(-1)?.[0]).toMatchObject({
                machineId: 'machine-b',
                authoringPreview: { selectedCandidateId: null, displayName: null },
            });
            expect(getActiveUnsavedChangesGuard()?.isDirtyRef.current).toBe(false);
        }
        expect(run).not.toHaveBeenCalled();
    });

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
        expect(run).toHaveBeenCalledWith(expect.objectContaining({
            action: 'createCustom',
            manualModels: [{ id: 'first/model' }, { id: 'second/model' }],
        }), 'save');
    });

    it('retains no save replay after an unknown custom create outcome', async () => {
        run.mockRejectedValueOnce(new Error('create acknowledgement lost after dispatch'));
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
        expect(run).toHaveBeenCalledWith(expect.objectContaining({ action: 'createCustom', enable: false }), 'save');
    });

    it('ignores a probe response that completes after the draft changes', async () => {
        let resolveProbe: ((value: unknown) => void) | undefined;
        probeProviderDraft.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
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
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const test = findDraftTestRow(screen);
        await React.act(async () => { test?.props.onPress?.(); });
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
        await React.act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
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
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const test = findDraftTestRow(screen);
        expect(typeof test?.props.onPress).toBe('function');
        await React.act(async () => {
            test?.props.onPress?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(probeProviderDraft).toHaveBeenCalledOnce();
        expect(findDraftTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

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
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const test = findDraftTestRow(screen);
        await React.act(async () => {
            test?.props.onPress?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(findDraftTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        await React.act(async () => {
            screen.findAllByType(FieldTextInput)
                .find((field) => field.props.accessibilityLabel === 'settingsProviders.models.addFieldLabel')
                ?.props.onChangeText('model-after-success');
        });

        expect(findDraftTestRow(screen)?.props.subtitle)
            .toBeNull();
    });

    it('invalidates successful Test connection truth after the selected Saved Secret value rotates', async () => {
        state.savedSecrets = [{
            id: 'secret-a',
            name: 'Gateway key',
            kind: 'apiKey',
            encryptedValue: { _isSecretValue: true, value: 'gateway-private-a' },
            createdAt: 1,
            updatedAt: 1,
        }];
        const { ProviderConnectionAuthoringScreen } = await import('./ProviderConnectionAuthoringScreen');
        const screen = await renderScreen(<ProviderConnectionAuthoringScreen />);
        await React.act(async () => {
            const fields = screen.findAllByType(FieldTextInput);
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.name')
                ?.props.onChangeText('Gateway');
            fields.find((field) => field.props.accessibilityLabel === 'settingsProviders.authoring.baseUrl')
                ?.props.onChangeText('https://gateway.example/v1');
            screen.findByTestId('settings-provider-authoring-api-key.choose')?.props.onPress?.();
        });
        const picker = modalShow.mock.calls.at(-1)?.[0] as { props?: { onSelectId?: (id: string | null) => void } } | undefined;
        await React.act(async () => {
            picker?.props?.onSelectId?.('secret-a');
        });
        const test = findDraftTestRow(screen);
        await React.act(async () => {
            test?.props.onPress?.();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(findDraftTestRow(screen)?.props.subtitle)
            .toBe('settingsProviders.detail.testSucceeded');

        await React.act(async () => {
            state.savedSecrets = [{
                ...state.savedSecrets[0]!,
                encryptedValue: { _isSecretValue: true, value: 'gateway-private-b' },
                updatedAt: 2,
            }];

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
