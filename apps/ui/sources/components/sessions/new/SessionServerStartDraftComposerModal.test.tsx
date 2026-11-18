import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SessionServerStartSpawnDraftV1Schema, type SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createMachineFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { CustomModalChromeConfig } from '@/modal';
import { PluginUiExecuteActionRequestV1Schema, PluginUiJsonObjectV1Schema, type PluginUiJsonValueV1, type PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { PluginHostApiProvider } from '@happier-dev/plugin-ui/advanced';
import { HappierUiEnvironmentProvider, projectHappierUiEnvironment } from '@happier-dev/plugin-ui/environment';
import {
    useTriageEntrySessionStart,
    type TriageEntrySessionStartPhaseV1,
    type TriageEntrySessionStartRequestV1,
} from '../../../../../../packages/plugins/triage/src/ui/header/useEntrySessionStart';
import { buildTriageEntryAttachmentPresentation } from '../../../../../../packages/plugins/triage/src/composer/mutationPlan';
import {
    TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1,
    TriageStartEntrySessionInputV1Schema,
    type TriageStartEntrySessionInputV1,
    type TriageStartEntrySessionResultV1,
} from '../../../../../../packages/plugins/triage/src/actions/entrySessionProtocol';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

// Only network/device/native boundaries are replaced. The modal, catalog,
// organization hook, shared controls and strict draft-edit adapter stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { SessionServerStartDraftComposerModal } = await import('./SessionServerStartDraftComposerModal');
const { useNewSessionOrganizationPlacement } = await import('./organization/useNewSessionOrganizationPlacement');
const { SessionAuthoringControls } = await import('@/components/sessions/authoring/controls/SessionAuthoringControls');
const { NewSessionPathSelectionContent } = await import('./components/NewSessionPathSelectionContent');
const { SessionPlacementChips } = await import('./placement/SessionPlacementChips');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { Item } = await import('@/components/ui/lists/Item');
const { Modal } = await import('@/modal');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createPluginActionInputSelectionHostApiHandler } = await import('@/components/plugins/surfaces/pluginActionInputSelectionHostApi');
const { createPluginSurfaceHostApi } = await import('@/components/plugins/surfaces/createPluginSurfaceHostApi');
const { createCanonicalPluginReactNativeHostApiAdapter } = await import('@/components/plugins/reactNative/hostApi');

/** The recipe's folder is New Session's folder chip and picker (owner 2026-11-12: two chips everywhere). */
async function chooseRecipeFolder(screen: Awaited<ReturnType<typeof renderScreen>>, path: string) {
    await screen.pressByTestIdAsync('agent-input-path-chip');
    await act(async () => { screen.findByType(NewSessionPathSelectionContent).props.onSubmitSelectedPath(path); });
}

function RecipeRequestingPlugin({ api, request }: Readonly<{ api: PluginUiHostApi; request(): void }>) {
    return <RoundButton title="Choose recipe" onPress={request} disabled={!api.version().methods.includes('selectActionInput')} />;
}

function TriageRecipeRequestingPlugin(props: Readonly<{
    request: TriageEntrySessionStartRequestV1;
    observe(phase: TriageEntrySessionStartPhaseV1): void;
}>) {
    const controller = useTriageEntrySessionStart();
    React.useLayoutEffect(() => { props.observe(controller.phase); }, [controller.phase, props.observe]);
    return <RoundButton title="Walk through" onPress={() => controller.start(props.request)} />;
}

afterAll(async () => {
    await disconnectActiveServerConnection();
    await network.dispose();
});
afterEach(async () => {
    standardCleanup();
    clearDaemonMergedProjectionCacheForTests();
    await disconnectActiveServerConnection();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
});

describe('mounted Session server-start recipe composer', () => {
    let serverId: string;
    let serverAlias: string;
    let otherServerId: string;
    let foldersEnabled = true;
    let homeSequence = 0;
    beforeEach(async () => {
        foldersEnabled = true;
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        const profilesByOrigin = new Map<string, ReturnType<typeof AccountProfileSchema.parse>>();
        network.setHttpResponder(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: { sessions: { folders: { enabled: foldersEnabled } } },
            }));
            // This fixture restores the real Sync singleton. Its core bootstrap
            // must settle before a later restoration can acquire Machine data.
            if (url.pathname === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
                content: { t: 'plain', v: { experiments: true, featureToggles: { 'sessions.folders': true } } }, version: 1,
            }));
            const profile = profilesByOrigin.get(url.origin);
            return url.pathname === '/v1/account/profile' && profile ? Response.json(profile) : null;
        });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            'acme.recipe/agent': { id: 'acme.recipe/agent', identity: { pluginId: 'acme.recipe', localId: 'agent' },
                title: 'Recipe Agent', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        } });
        network.setRpcAckResponder(async request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? { ok: true, result: { protocolVersion: 1, projection } }
            : { ok: false, error: 'Not available in fixture', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        homeSequence += 1;
        const home = await network.addHome(`https://recipe-composer-${homeSequence}.example.test`, 'recipe-account');
        const other = await network.addHome(`https://recipe-other-${homeSequence}.example.test`, 'other-account');
        profilesByOrigin.set(new URL(home.serverUrl).origin, AccountProfileSchema.parse({ id: home.accountId }));
        profilesByOrigin.set(new URL(other.serverUrl).origin, AccountProfileSchema.parse({ id: other.accountId }));
        serverAlias = home.id;
        await setServerProfileIdentityForUrl(home.serverUrl, `srv_recipe_composer_${homeSequence}`);
        serverId = resolveServerProfileScopeIdForIdentifier(serverAlias);
        otherServerId = other.id;
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        await waitForHomeGovernance(() => {
            expect(storage.getState().machines['machine-1']).toBeDefined();
            expect(storage.getState().accountSettingsSyncStatus.state).toBe('synced');
            expect(storage.getState().profile.id).toBe(home.accountId);
        });
        // Keep the Home-served row (its plain content mode is what admits Machine reads); only refresh its presence.
        const served = storage.getState().machines['machine-1']!;
        storage.getState().applyMachines([{ ...createMachineFixture({ id: 'machine-1' }), ...served, active: true, activeAt: Date.now() }], true, { sourceServerId: serverId });
        storage.getState().upsertSessionOrganizationFolderOptimistic(serverId, {
            folderId: 'intake', folderKey: 'intake', parentFolderId: null, parentFolderKey: null,
            sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1,
            display: { t: 'plain', v: { name: 'Intake', workspace: {
                t: 'workspaceScope', serverId, machineId: 'machine-1', rootPath: '/repo',
            } } },
            displayState: { status: 'available', value: { name: 'Intake', workspace: {
                t: 'workspaceScope', serverId, machineId: 'machine-1', rootPath: '/repo',
            } } },
        });
        clearDaemonMergedProjectionCacheForTests();
    });

    function recipe(configuration = false): SessionServerStartSpawnDraftV1 {
        return SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId, machineId: 'machine-1' }, directory: { kind: 'path', path: '/repo' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            title: 'Intake', roleId: 'intake', profileId: 'work', permissionMode: 'read-only',
            allowedTools: ['mcp__intake__*'], unlistedTools: 'deny',
            organizationPlacement: { folderId: 'intake', tagIds: ['mail'] },
            capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['intake'], forceExcludeServerIds: [] } },
            ...(configuration ? { configuration: { mode: { value: null, updatedAtMs: 1 },
                model: { value: null, updatedAtMs: 2 }, permissionIntent: { value: 'read-only', updatedAtMs: 3 },
                options: { reasoning: { value: 'low', updatedAtMs: 4 } },
                providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-resume' } } } : {}),
        });
    }
    async function mount(draft: SessionServerStartSpawnDraftV1, target = draft.executionTarget) {
        let chrome: CustomModalChromeConfig | null = null;
        const onResolve = vi.fn();
        const screen = await renderScreen(<SessionServerStartDraftComposerModal
            seed={{ existingDraft: draft }} target={target} onResolve={onResolve} onClose={() => {}}
            setChrome={value => { chrome = value; }} />);
        function submitButton() {
            if (chrome?.kind !== 'card') throw new Error('Missing card');
            const footer = chrome.footer as React.ReactElement<{ children: React.ReactNode }>;
            const button = React.Children.toArray(footer.props.children).find(child =>
                React.isValidElement<{ title: string }>(child) && child.type === RoundButton && child.props.title === 'newSession.recipeComposerSubmit');
            if (!React.isValidElement<{ disabled: boolean }>(button)) throw new Error('Missing submit');
            return button;
        }
        async function submit() {
            await waitForHomeGovernance(() => {
                expect(submitButton().props.disabled).toBe(false);
            });
            if (chrome?.kind !== 'card') throw new Error('Missing card');
            const footer = await renderScreen(<>{chrome.footer}</>);
            await act(async () => { footer.findAllByType(RoundButton).find(node => node.props.title === 'newSession.recipeComposerSubmit')!.props.onPress(); });
            await footer.unmount();
            expect(onResolve).toHaveBeenCalledTimes(1);
            return SessionServerStartSpawnDraftV1Schema.parse(onResolve.mock.calls[0]![0]);
        }
        return { screen, submit, submitButton };
    }

    it('shows a saved Team recipe model and carries a replacement binding out of the chooser', async () => {
        const teamBinding = { v: 1 as const, slot: { kind: 'provider_model' as const },
            teamId: 'team-a', resourceId: 'resource-a', expectedResourceRevision: 2, deliveryMode: 'brokered' as const,
            providerModelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-recipe-model' } };
        const draft = { ...recipe(true), teamCredentialBindings: [teamBinding] };
        const { screen, submit } = await mount(draft);
        try {
            await waitForHomeGovernance(() => {
                expect(screen.findAllByType(SessionAuthoringControls)[0]?.props.values.teamCredentialBindings).toEqual([teamBinding]);
            });
            const replacement = { ...teamBinding, resourceId: 'resource-b',
                providerModelSelection: { ...teamBinding.providerModelSelection, modelId: 'team-recipe-model-b' } };
            await act(async () => {
                screen.findAllByType(SessionAuthoringControls)[0]!.props.onChangeFields({
                    modelSelection: null, teamCredentialBindings: [replacement],
                });
            });
            expect(await submit()).toMatchObject({ teamCredentialBindings: [replacement],
                configuration: { model: { value: replacement.providerModelSelection.modelId },
                    providerSessionResume: draft.configuration?.providerSessionResume } });
        } finally { await screen.unmount(); }
    });

    it('keeps Account section placement before a Machine is selected and after same-Home placement changes', async () => {
        const draft = recipe();
        const initialProps: Pick<Parameters<typeof useNewSessionOrganizationPlacement>[0], 'executionTarget' | 'directory'> = {
            executionTarget: null, directory: '',
        };
        const hook = await renderHook((props: typeof initialProps) => useNewSessionOrganizationPlacement({
            serverId,
            ...props,
            initialPlacement: draft.organizationPlacement,
        }), { initialProps });

        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().folderTargets.some(target => target.folderId === 'intake')).toBe(true);
            expect(hook.getCurrent().valid).toBe(true);
        });
        expect(hook.getCurrent().placement).toEqual(draft.organizationPlacement);
        expect(hook.getCurrent().selectedSectionAddress).toEqual({ serverId, sectionId: 'intake' });

        await hook.rerender({ executionTarget: { serverId, machineId: 'machine-2' }, directory: '/another-project' });
        expect(hook.getCurrent().placement).toEqual(draft.organizationPlacement);
        expect(hook.getCurrent().valid).toBe(true);
        await hook.unmount();
    });

    it('does not bind a retained placement to another Account during same-Home hydration', async () => {
        const draft = recipe();
        const hook = await renderHook(() => useNewSessionOrganizationPlacement({
            serverId,
            executionTarget: null,
            directory: '',
            initialPlacement: draft.organizationPlacement,
            initialPlacementScope: { serverId, accountId: 'retired-account' },
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().folderTargets.some(target => target.folderId === 'intake')).toBe(true));
        expect(hook.getCurrent().placement).toEqual(draft.organizationPlacement);
        expect(hook.getCurrent().valid).toBe(false);
        expect(hook.getCurrent().sectionSelectionValid).toBe(false);
        expect(hook.getCurrent().sections.some(section => section.address.serverId === serverId
            && section.address.sectionId === 'intake')).toBe(true);

        await act(async () => { hook.getCurrent().setSectionAddress({ serverId: otherServerId, sectionId: 'intake' }); });
        expect(hook.getCurrent().placement).toEqual(draft.organizationPlacement);
        expect(hook.getCurrent().selectedSectionAddress).toEqual({ serverId, sectionId: 'intake' });
        expect(hook.getCurrent().valid).toBe(false);

        await act(async () => { hook.getCurrent().setSectionAddress({ serverId, sectionId: 'intake' }); });
        expect(hook.getCurrent().placement).toEqual({ folderId: 'intake', tagIds: [] });
        expect(hook.getCurrent().valid).toBe(true);
        expect(hook.getCurrent().sectionSelectionValid).toBe(true);
        await hook.unmount();
    });

    it.each([
        { name: 'canonical Home', aliasHost: false, aliasRecipe: false, fresh: false, managed: false },
        { name: 'saved recipe Home alias', aliasHost: false, aliasRecipe: true, fresh: false, managed: false },
        { name: 'mounted and saved Home aliases', aliasHost: true, aliasRecipe: true, fresh: false, managed: false },
        { name: 'fresh connected Codex recipe without a launch profile', aliasHost: false, aliasRecipe: false, fresh: true, managed: false },
        { name: 'fresh managed directory seed', aliasHost: false, aliasRecipe: false, fresh: true, managed: true },
    ])('composes a mounted external plugin recipe with $name and all authoring controls', async ({ aliasHost, aliasRecipe, fresh, managed }) => {
        const draft = recipe();
        const requestedDraft = aliasRecipe
            ? { ...draft, executionTarget: { ...draft.executionTarget, serverId: serverAlias } }
            : draft;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing Home lifetime');
        const requestSurface: PluginUiSurfaceContextV1 = {
            pluginId: 'example.recipe', contributionId: 'settings', surfaceId: 'recipe-settings',
            placement: 'appSurface', platform: 'ios', channel: 'internal', resourceScope: [], diagnostics: [],
        };
        const selector = createPluginActionInputSelectionHostApiHandler({
            host: { machineId: 'machine-1', serverId: aliasHost ? serverAlias : serverId,
                targetPluginId: requestSurface.pluginId, accountLifetime: lifetime },
            isCurrent: lifetime.isCurrent,
        });
        const host = createPluginSurfaceHostApi({ surfaceContext: requestSurface, handlers: { selectActionInput: selector } });
        const surface = createPluginSurfaceContextFixture({ platform: 'ios', target: { kind: 'app' },
            accountEncryptionMode: 'plain', targetedContributions: undefined, mount: { kind: 'destination',
                destination: { pluginId: requestSurface.pluginId, localId: 'settings' }, container: 'appPage' } });
        const request = { hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
            draft: PluginUiJsonObjectV1Schema.parse({ ...(fresh
                ? { ...(managed ? { directoryIntent: { kind: 'managed' } } : { directory: '/tmp' }), agentId: 'codex', permissionMode: 'default' }
                : { existingDraft: requestedDraft }),
                candidates: [{ projectKey: { id: 'project-intake' }, serverId: aliasRecipe ? serverAlias : serverId,
                    machineId: 'machine-1', rootPath: '/repo', reachable: true, worktrees: [] }] }) } as const;
        // Removing the real host registration must refuse before any dialog opens.
        vi.mocked(Modal.show).mockClear();
        const unwiredHost = createPluginSurfaceHostApi({ surfaceContext: requestSurface });
        const unwired = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface,
            handleRequest: unwiredHost.handleRequest, installedMethods: unwiredHost.installedMethods });
        try {
            await expect(unwired.api.selectActionInput(request)).rejects.toMatchObject({ code: 'unsupported_method' });
            expect(Modal.show).not.toHaveBeenCalled();
        } finally { unwired.dispose(); }
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface,
            requestSurface, handleRequest: host.handleRequest, installedMethods: host.installedMethods,
        });
        let selection: ReturnType<PluginUiHostApi['selectActionInput']> | undefined;
        let earlySettlement: unknown = null;
        const plugin = await renderScreen(<RecipeRequestingPlugin api={adapter.api} request={() => {
            selection = adapter.api.selectActionInput(request);
            void selection.then(value => { earlySettlement = value; }, error => { earlySettlement = error; });
        }} />);
        try {
            vi.mocked(Modal.show).mockClear();
            await act(async () => { plugin.findByType(RoundButton).props.onPress(); });
            await waitForHomeGovernance(() => expect(vi.mocked(Modal.show).mock.calls.length > 0 || earlySettlement !== null).toBe(true));
            expect(earlySettlement).toBeNull();
            expect(Modal.show).toHaveBeenCalledTimes(1);
            const config = vi.mocked(Modal.show).mock.calls[0]![0];
            expect(config.component).toBe(SessionServerStartDraftComposerModal);
            expect(config.props?.target).toEqual({ serverId, machineId: 'machine-1' });
            // Modal.show is the actual UI presentation boundary; its selected component and props are mounted unchanged.
            const chrome: { current: CustomModalChromeConfig | null } = { current: null };
            const dialog = await renderScreen(React.createElement(config.component, { ...config.props, onClose: () => {},
                setChrome: (value: CustomModalChromeConfig) => { chrome.current = value; } }));
            try {
                await dialog.pressByTestIdAsync('server-start-draft-tools-header');
                await waitForHomeGovernance(() => expect(dialog.findAllByType(SessionAuthoringControls).length,
                    dialog.getTextContent()).toBe(2));
                const facts = dialog.findAllByType(SessionAuthoringControls)[0]!.props.facts;
                expect(facts.agentPickerContext).toMatchObject({ serverId, machineId: 'machine-1' });
                expect(facts.agentTargets).toEqual(expect.arrayContaining([expect.objectContaining({
                    label: 'Recipe Agent', target: { kind: 'agent', identity: { pluginId: 'acme.recipe', localId: 'agent' } },
                })]));
                const fields = dialog.findAllByType(SessionAuthoringControls).flatMap(node => node.props.fields);
                expect(fields).toEqual(expect.arrayContaining(['modelSelection', 'sessionConfigOptionOverrides', 'allowedTools', 'unlistedTools']));
                for (const field of ['agentTarget', 'allowedTools', 'unlistedTools']) {
                    expect(dialog.findHostByTestId(`server-start-draft-control-${field}-row`)).not.toBeNull();
                }
                if (!fresh) expect(dialog.findByTestId('server-start-draft-folder')).not.toBeNull();
                await dialog.pressByTestIdAsync('agent-input-path-chip');
                expect(dialog.findByType(NewSessionPathSelectionContent).props.machineBrowse).toEqual({ enabled: true, machineId: 'machine-1', serverId });
                if (!managed) expect(dialog.findByType(NewSessionPathSelectionContent).props.selectedPath).toBe(fresh ? '/tmp' : '/repo');
                if (fresh) {
                    await act(async () => {
                        dialog.findAllByType(SessionAuthoringControls)[0]!.props.onChangeFields({
                            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                            modelSelection: { v: 1, updatedAt: 12, ref: {
                                agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6.1-sol',
                            } },
                            sessionConfigOptionOverrides: { v: 1, updatedAt: 12, overrides: {
                                reasoning_effort: { value: 'low', updatedAt: 12 },
                            } },
                            connectedServices: { v: 2, bindingsByServiceId: {
                                'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: '97bd5614-8970-4068-87f2-1447de69d604' },
                            } },
                        });
                    });
                }
                if (chrome.current?.kind !== 'card') throw new Error('Missing composer card');
                const footer = await renderScreen(<>{chrome.current.footer}</>);
                try {
                    const submit = footer.findAllByType(RoundButton).find(node => node.props.title === 'newSession.recipeComposerSubmit')!;
                    expect(submit.props.disabled).toBe(false);
                    await act(async () => { submit.props.onPress(); });
                } finally { await footer.unmount(); }
                if (fresh) {
                    const settled = await selection;
                    expect(settled).toMatchObject({ kind: 'serverStartDraft', draft: {
                        executionTarget: { serverId, machineId: 'machine-1' },
                        directory: managed ? { kind: 'managed' } : { kind: 'path', path: '/tmp' },
                        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                        modelSelection: { ref: { modelId: 'gpt-6.1-sol' } },
                        configuration: { options: { reasoning_effort: { value: 'low' } } },
                        connectedServices: { bindingsByServiceId: {
                            'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: '97bd5614-8970-4068-87f2-1447de69d604' },
                        } },
                    } });
                    if (!settled || settled.kind !== 'serverStartDraft') throw new Error('Missing recipe settlement');
                    expect(settled.draft).not.toHaveProperty('profileId');
                    expect(PluginUiJsonObjectV1Schema.safeParse(settled.draft).success).toBe(true);
                    expect(SessionServerStartSpawnDraftV1Schema.safeParse(settled.draft).success).toBe(true);
                } else {
                    await expect(selection).resolves.toEqual({ kind: 'serverStartDraft', draft });
                }
            } finally { await dialog.unmount(); }
        } finally { adapter.dispose(); await plugin.unmount(); }
    });

    it.each([false, true])('settles the real chooser through its mounted Triage owner (owner retired=%s)', async (retireOwner) => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing Home lifetime');
        const requestSurface: PluginUiSurfaceContextV1 = {
            pluginId: 'happier.triage', contributionId: 'list', surfaceId: 'triage-list',
            placement: 'appSurface', platform: 'ios', channel: 'internal', resourceScope: [], diagnostics: [],
        };
        const comparison = { kind: 'pullRequest', locator: { providerId: 'forge', repository: 'example/repository',
            number: 17, baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) } } as const;
        const entryRef = { source: { pluginId: 'example.forge', localId: 'pull-requests' },
            kindId: 'pull-request', collisionScope: 'example/repository', entryId: '17' };
        const request = {
            action: { actionId: 'walk-comparison', label: 'Walk through', enabled: true, appliesTo: ['pullRequest'],
                profileId: null, workspaceMode: 'reference_only',
                target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' } },
            entryRef, sourceInstance: { source: entryRef.source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
            display: { locator: { v: 1, webUrl: 'https://example.test/pull/17' }, scopeLabel: 'example/repository' },
            presentation: buildTriageEntryAttachmentPresentation({ title: 'Repair the parser', scopeLabel: 'example/repository' }),
            comparisonDestination: { kind: 'scmReview', comparison, view: 'walkthrough' },
        } satisfies TriageEntrySessionStartRequestV1;
        const starts: TriageStartEntrySessionInputV1[] = [];
        const opens: unknown[] = [];
        const selections: PluginUiJsonValueV1[] = [];
        const selector = createPluginActionInputSelectionHostApiHandler({
            host: { machineId: 'machine-1', serverId, targetPluginId: requestSurface.pluginId, accountLifetime: lifetime },
            isCurrent: lifetime.isCurrent,
        });
        const host = createPluginSurfaceHostApi({ surfaceContext: requestSurface, handlers: {
            selectActionInput: async (envelope, options) => {
                const outcome = await selector(envelope, options);
                if (outcome !== undefined) selections.push(outcome);
                return outcome;
            },
            executeAction: async (envelope): Promise<PluginUiJsonValueV1> => {
                const action = PluginUiExecuteActionRequestV1Schema.parse(envelope.payload);
                if (action.action === 'projects.list') return { items: [], truncated: false };
                if (action.action === TRIAGE_START_ENTRY_SESSION_ACTION_LOCAL_ID_V1) {
                    starts.push(TriageStartEntrySessionInputV1Schema.parse(action.input));
                    return { v: 1, type: 'linked', sessionId: 'recipe-session', disposition: 'created',
                        delivery: 'none', finalOpen: 'deferred' } satisfies TriageStartEntrySessionResultV1;
                }
                if (action.action === 'session.open') { opens.push(action.input); return null; }
                throw new Error(`Unexpected Action: ${String(action.action)}`);
            },
        } });
        const surface = createPluginSurfaceContextFixture({ platform: 'ios', target: { kind: 'app' },
            accountEncryptionMode: 'plain', targetedContributions: undefined, mount: { kind: 'destination',
                destination: { pluginId: requestSurface.pluginId, localId: 'list' }, container: 'appPage' } });
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface,
            handleRequest: host.handleRequest, installedMethods: host.installedMethods });
        let phase: TriageEntrySessionStartPhaseV1 = { kind: 'idle' };
        const observe = (next: TriageEntrySessionStartPhaseV1) => { phase = next; };
        const plugin = await renderScreen(<HappierUiEnvironmentProvider environment={projectHappierUiEnvironment(surface)}><PluginHostApiProvider hostApi={adapter.api}>
            <TriageRecipeRequestingPlugin request={request} observe={observe} />
        </PluginHostApiProvider></HappierUiEnvironmentProvider>);
        try {
            vi.mocked(Modal.show).mockClear();
            vi.mocked(Modal.hide).mockClear();
            await act(async () => { plugin.findByType(RoundButton).props.onPress(); });
            await waitForHomeGovernance(() => expect(Modal.show).toHaveBeenCalledTimes(1));
            expect(phase).toEqual({ kind: 'choosing' });
            const config = vi.mocked(Modal.show).mock.calls[0]![0];
            const chrome: { current: CustomModalChromeConfig | null } = { current: null };
            const chooser = (key: string) => React.createElement(config.component, { ...config.props, key,
                onClose: () => config.onRequestClose?.(), setChrome: (value: CustomModalChromeConfig) => { chrome.current = value; } });
            const dialog = await renderScreen(chooser('before-remount'));
            try {
                await dialog.update(chooser('after-remount'));
                expect(phase).toEqual({ kind: 'choosing' });
                await chooseRecipeFolder(dialog, '/repo');
                await dialog.pressByTestIdAsync('server-start-draft-tools-header');
                await waitForHomeGovernance(() => {
                    expect(dialog.findAllByType(SessionAuthoringControls)).toHaveLength(2);
                    if (chrome.current?.kind !== 'card') throw new Error('Missing recipe footer');
                });
                if (chrome.current?.kind !== 'card') throw new Error('Missing recipe footer');
                const footer = await renderScreen(<>{chrome.current.footer}</>);
                try {
                    const submit = footer.findAllByType(RoundButton).find(node => node.props.title === 'newSession.recipeComposerSubmit')!;
                    expect(submit.props.disabled).toBe(false);
                    if (retireOwner) {
                        await plugin.unmount();
                        await flushHookEffects();
                        // The host presentation must withdraw before any old submit callback can run.
                        expect(Modal.hide).toHaveBeenCalledTimes(1);
                        expect(selections).toEqual([{ code: 'unavailable', diagnostics: ['aborted'] }]);
                        await act(async () => { submit.props.onPress(); });
                        await flushHookEffects();
                        expect(starts).toEqual([]);
                        expect(opens).toEqual([]);
                        return;
                    }
                    await act(async () => { submit.props.onPress(); });
                } finally { await footer.unmount(); }
                await flushHookEffects();
                expect(starts, JSON.stringify(phase)).toHaveLength(1);
                expect(opens, JSON.stringify(phase)).toHaveLength(1);
                expect(starts[0]?.destination).toMatchObject({ kind: 'new', spawn: {
                    executionTarget: { serverId, machineId: 'machine-1' },
                }, materialization: { kind: 'referenceOnly', directory: '/repo' } });
                expect(opens).toEqual([{ sessionId: 'recipe-session', serverId,
                    destination: { kind: 'scmReview', comparison, view: 'walkthrough' } }]);
                expect(phase).toMatchObject({ kind: 'settled', result: { type: 'opened', sessionId: 'recipe-session' } });
            } finally { await dialog.unmount(); }
        } finally { adapter.dispose(); await plugin.unmount(); }
    });

    it.each(['custom:removed', null, undefined] as const)('preserves the inherited approval profile %s through the mounted configured recipe', async approvalProfileId => {
        const draft = SessionServerStartSpawnDraftV1Schema.parse({ ...recipe(),
            ...(approvalProfileId !== undefined ? { approvalProfileId } : {}),
        });
        const mounted = await mount(draft);
        try {
            await waitForHomeGovernance(() => expect(mounted.screen.findAllByType(DropdownMenu).some(node =>
                node.props.testID === 'server-start-draft-control-approvalProfileId')).toBe(true));
            const picker = mounted.screen.findAllByType(DropdownMenu).find(node =>
                node.props.testID === 'server-start-draft-control-approvalProfileId')!;
            expect(picker.props.selectedId).toBe(approvalProfileId === undefined ? 'inherit'
                : approvalProfileId === null ? '__none__' : approvalProfileId);
            if (approvalProfileId === 'custom:removed') {
                await waitForHomeGovernance(() => expect(mounted.screen.tree.root.findAllByProps({
                    testID: 'server-start-draft-control-approvalProfileId-missing',
                }).length).toBeGreaterThan(0));
            } else {
                expect(mounted.screen.tree.root.findAllByProps({
                    testID: 'server-start-draft-control-approvalProfileId-missing',
                })).toHaveLength(0);
            }
            expect(await mounted.submit()).toEqual(draft);
        } finally { await mounted.screen.unmount(); }
    });

    it('retains section, configuration and tool policy through save/reopen and refuses foreign same-id substitution', async () => {
        const draft = recipe();
        const mounted = await mount(draft);
        await waitForHomeGovernance(() => expect(mounted.screen.findAllByType(DropdownMenu).some(node =>
            node.props.items?.some((item: { id: string }) => item.id === 'intake'))).toBe(true));
        expect(await mounted.submit()).toEqual(draft);
        await mounted.screen.unmount();
        const changed = await mount(draft);
        await chooseRecipeFolder(changed.screen, '/elsewhere');
        expect(await changed.submit()).toEqual({ ...draft, directory: { kind: 'path', path: '/elsewhere' } });
        await changed.screen.unmount();
        for (const existing of [false, true]) {
            const configurationDraft = recipe(existing);
            const editing = await mount(configurationDraft);
            await waitForHomeGovernance(() => expect(editing.screen.findAllByType(SessionAuthoringControls).length).toBeGreaterThan(0));
            await act(async () => { editing.screen.findAllByType(SessionAuthoringControls)[0]!.props.onChangeField(
                'sessionConfigOptionOverrides', { v: 1, updatedAt: 12, overrides: { reasoning: { value: 'high', updatedAt: 12 } } },
            ); });
            const emitted = await editing.submit();
            expect(emitted.configuration?.options).toEqual({ reasoning: { value: 'high', updatedAtMs: 12 } });
            if (existing) expect(emitted.configuration?.providerSessionResume).toEqual(configurationDraft.configuration?.providerSessionResume);
            await editing.screen.unmount();
            const reopened = await mount(emitted);
            await waitForHomeGovernance(() => expect(reopened.screen.findAllByType(SessionAuthoringControls).length).toBeGreaterThan(0));
            expect(reopened.screen.findAllByType(SessionAuthoringControls)[0]!.props.values.sessionConfigOptionOverrides.overrides.reasoning.value).toBe('high');
            expect(await reopened.submit()).toEqual(emitted);
            await reopened.screen.unmount();
        }

        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() })], true, { sourceServerId: otherServerId });
        storage.getState().upsertSessionOrganizationFolderOptimistic(otherServerId, {
            folderId: 'intake', folderKey: 'foreign-intake', parentFolderId: null, parentFolderKey: null,
            sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1,
            display: { t: 'plain', v: { name: 'Other Account intake' } },
            displayState: { status: 'available', value: { name: 'Other Account intake' } },
        });
        const otherHome = await mount(draft, { serverId: otherServerId, machineId: 'machine-1' });
        await waitForHomeGovernance(() => expect(otherHome.screen.findAllByType(SessionAuthoringControls).length).toBeGreaterThan(0));
        await waitForHomeGovernance(() => expect(otherHome.screen.findAllByType(DropdownMenu).some(node =>
            node.props.items?.some((item: { id: string }) => item.id === 'intake'))).toBe(true));
        expect(otherHome.submitButton().props.disabled).toBe(true);
        await act(async () => {
            otherHome.screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'server-start-draft-folder')!.props.onSelect('root');
        });
        expect((await otherHome.submit()).organizationPlacement).toEqual({ folderId: null, tagIds: [] });
        await otherHome.screen.unmount();
    });

    it.each(['cold', 'retired folders gate', 'legacy workspace'] as const)(
        'roundtrips an unchanged managed recipe when its Folder projection is %s', async (projectionState) => {
            const draft = SessionServerStartSpawnDraftV1Schema.parse({
                ...recipe(), directory: { kind: 'managed' },
            });
            if (projectionState === 'cold') storage.getState().clearSessionOrganizationForServer(serverId);
            if (projectionState === 'retired folders gate') {
                foldersEnabled = false;
                storage.getState().applySettingsLocal({ featureToggles: { 'sessions.folders': false } });
            }
            // A no-invoke recipe retains its authored placement. Retired workspace
            // eligibility and Folder opt-in cannot narrow the Account's choices.
            const mounted = await mount(draft);
            const emitted = await mounted.submit();
            expect(emitted).toEqual(draft);
            // The retained Folder stays in view and never reads as the workspace root.
            const trigger = mounted.screen.findAllByType(DropdownMenu)
                .find(node => node.props.testID === 'server-start-draft-folder')?.props.itemTrigger;
            if (projectionState === 'cold') {
                expect(trigger?.detailFormatter?.(null)).toBe('common.unavailable');
                expect(trigger?.subtitleFormatter?.(null)).toBe('newSession.recipeComposerFolderRetained');
            } else {
                expect(trigger?.detailFormatter?.(null)).toContain('Intake');
            }
            await mounted.screen.unmount();
            const reopened = await mount(emitted);
            expect(await reopened.submit()).toEqual(draft);
            await reopened.screen.unmount();
        },
    );

    it('applies explicit Folder removal and directory changes to a managed recipe', async () => {
        const draft = SessionServerStartSpawnDraftV1Schema.parse({ ...recipe(), directory: { kind: 'managed' } });
        const editingFolder = await mount(draft);
        await waitForHomeGovernance(() => expect(editingFolder.screen.findAllByType(SessionAuthoringControls).length).toBeGreaterThan(0));
        await act(async () => {
            editingFolder.screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'server-start-draft-folder')!.props.onSelect('root');
        });
        expect(await editingFolder.submit()).toEqual({ ...draft, organizationPlacement: { folderId: null, tagIds: ['mail'] } });
        await editingFolder.screen.unmount();

        const editingDirectory = await mount(draft);
        await chooseRecipeFolder(editingDirectory.screen, '/elsewhere');
        expect(await editingDirectory.submit()).toEqual({
            ...draft, directory: { kind: 'path', path: '/elsewhere' },
        });
        await editingDirectory.screen.unmount();
    });
});
