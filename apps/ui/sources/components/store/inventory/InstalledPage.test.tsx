import * as React from 'react';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { act, createMachineFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { buildDeploymentEnvironmentHref } from '@/components/projects/deployments/deploymentNavigation';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness,
    installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const routeMock = vi.hoisted(() => ({ resetParams: () => {}, push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const boundary = createExpoRouterMock({ pathname: '/plugins', params: { view: 'installed' } });
    routeMock.resetParams = boundary.resetParams;
    routeMock.push = boundary.spies.push;
    return boundary.module;
});
const rpc = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness();
const { InstalledPage } = await import('./InstalledPage');
const { t } = await import('@/text');
const { MachineInventoryBlock } = await import('@/components/machines/page/MachineInventoryBlock');
const { storage } = await import('@/sync/domains/state/storage');
const { useManagedInventory } = await import('./useManagedInventory');
const { renderHook } = await import('@/dev/testkit');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { refreshMcpServerCatalog } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { InboxArtifactSourceBoundary } = await import('@/hooks/inbox/useInboxArtifactSource');
function Boundary({ children }: React.PropsWithChildren) { return <InboxArtifactSourceBoundary>{children}</InboxArtifactSourceBoundary>; }

afterEach(async () => { standardCleanup(); routeMock.resetParams(); await account.reset(); rpc.reset(); });

it('summarizes all-Machine membership once and keeps a subset explicit in the actual Installed rows', async () => {
    const { createSkillsSurfaceHarness } = await import('@/dev/testkit/harness/skillsSurfaceHarness');
    const home = await createSkillsSurfaceHarness('https://store-every-machine.test');
    onTestFinished(() => home.dispose());
    const machines = ['a', 'b'].map(id => createMachineFixture({ id, metadata: { ...createMachineFixture().metadata!,
        displayName: `Machine ${id}`, agentInventory: { checkedAt: 1, installedAgentIds: id === 'a' ? ['codex', 'claude'] : ['codex'] } } }));
    await act(async () => { storage.getState().applyMachines(machines, true,
        { sourceServerId: home.scope.serverId, sourceAccountId: home.scope.accountId }); });
    const screen = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><InstalledPage /></PluginSurfaceFocusEligibilityProvider>);
    const row = (id: string) => screen.findAllByTestId(`store.installed.section.agent.row.${serverAccountScopedResourceKey(home.scope, 'agent', 'machineAgent', id)}`)
        .find(node => 'whereSummary' in node.props);
    await vi.waitFor(() => expect(row('codex')).toBeDefined());
    expect(row('codex')!.props.whereSummary).toBe(t('storeInstalled.everyMachine'));
    expect(row('claude')!.props.whereSummary).toBe('Machine a');
    expect(rpc.state.requests).toHaveLength(0);
});

it('renders recorded Software and watches in the real Installed page and its Machine door without native enumeration', async () => {
    const identity = 'srv_installed_page_software';
    const machine = createMachineFixture({ id: 'software-machine', metadata: {
        ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: [] },
        serviceWatchesV1: { v: 1, watches: [{ v: 1, watchId: 'database-watch', name: 'Database watch',
            adapter: { pluginId: 'example.service', localId: 'native' }, nativeResourceId: 'database', lifecyclePurpose: 'infrastructure' }] },
        setup: { version: 1, revision: 1, exclusions: [], sources: [{ kind: 'direct', setup: { toolchain: { adapterId: 'recorded-toolchain', config: 'node=22' } } }] },
    } });
    await account.restore({ serverIdentityId: identity, machines: [machine] });
    const scope = storage.getState().settingsScope!;
    const inventory = await renderHook(() => useManagedInventory({ scope, machine: null, projectKey: null, presented: true }), { wrapper: Boundary });
    await vi.waitFor(() => expect(inventory.getCurrent().families.software.rows).toHaveLength(1));
    const row = inventory.getCurrent().families.software.rows[0]!;
    const watch = inventory.getCurrent().operationalFamilies.watchedService.rows[0]!;
    const page = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><InstalledPage /></PluginSurfaceFocusEligibilityProvider>);
    await vi.waitFor(() => expect(page.findByTestId(`store.installed.section.software.row.${row.key}`)).not.toBeNull());
    expect(page.findHostByTestId(`store.installed.section.watchedService.row.${watch.key}`)).not.toBeNull();
    expect(rpc.state.requests).toHaveLength(0);
    await page.unmount();
    const embed = await renderScreen(<PluginSurfaceFocusEligibilityProvider active>
        <MachineInventoryBlock serverId={scope.serverId} machineId={machine.id} scope={scope} />
    </PluginSurfaceFocusEligibilityProvider>);
    await vi.waitFor(() => expect(embed.findByTestId(`machine.inventory.section.software.row.${row.key}`)).not.toBeNull());
    expect(embed.findHostByTestId(`machine.inventory.section.watchedService.row.${watch.key}`)).not.toBeNull();
    expect(rpc.state.requests.filter(request => request.method !== 'capabilities.detect')).toHaveLength(0);
});

it.each([2, 1])('reviews removal of one explicit installed Software Machine (%i installations)', async count => {
    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { ExternalActionRequestEnvelopeV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema,
        ExternalActionExecutionAuthorizationV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } = await import('@happier-dev/protocol/actions/externalActionApi');
    const { PluginProjectedMachineRecipeEntryV1Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const { getMachineSetupDesiredV1, machineSetupItemKeyV1 } = await import('@happier-dev/protocol/machines/setup/machineSetupSourcesV1');
    const { createActionExecutorBoundaryFixture } = await import('@/dev/testkit/fixtures/actionExecutorBoundary');
    const { createCombinedMachineSetupActionDeps } = await import('../../../../../cli/src/machines/setup/composeMachineSetup');
    const { prepareMachineSetupPlanV1 } = await import('../../../../../cli/src/machines/setup/prepareMachineSetupPlan');
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const dispose = await installRealActionExecutorModuleLoader();
    onTestFinished(dispose);
    const { Modal } = await import('@/modal');
    const show = vi.spyOn(Modal, 'show').mockReturnValue('software-removal');
    onTestFinished(() => show.mockRestore());
    const item = { kind: 'softwareRecipe' as const, selection: {
        ref: { pluginId: 'example.software', recipeId: 'owned', revision: '1' }, inputs: {},
    } };
    const { default: sodium } = await import('libsodium-wrappers');
    const { encodeBase64 } = await import('@happier-dev/protocol/crypto/base64');
    await sodium.ready;
    const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(23));
    const sources = [{ kind: 'direct' as const, setup: { items: [item] } }];
    const sourceFacts = { direct: { firstPresence: { [machineSetupItemKeyV1(item)]: 'absent' as const } } };
    const machines = ['software-a', 'software-b'].slice(0, count).map(id => createMachineFixture({ id, activeAt: Date.now(), installationPublicKey: encodeBase64(installationKey.publicKey, 'base64'), metadata: {
        ...createMachineFixture().metadata!, displayName: id,
        agentInventory: { checkedAt: 1, installedAgentIds: [] },
        setup: { version: 1, revision: 1, sources, sourceFacts, exclusions: [] },
    } }));
    const home = await account.restore({ currentAccount: true, serverIdentityId: `srv_installed_software_remove_${count}`, machines: [
        ...machines, createMachineFixture({ id: 'not-installed', metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: [] } } }),
    ] });
    const scope = storage.getState().settingsScope!;
    const recipe = PluginProjectedMachineRecipeEntryV1Schema.parse({ id: 'example.software/owned', pluginId: 'example.software', pluginVersion: '1',
        definition: { id: 'owned', revision: '1', title: 'Owned package', software: true,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            steps: [{ id: 'install', kind: 'command', executable: 'install-owned', args: [], check: { executable: 'test', args: ['-e', 'owned'], unsatisfiedExitCodes: [1] } }],
            removeSteps: [{ id: 'remove', kind: 'command', executable: 'remove-owned', args: [], check: { executable: 'test', args: ['!', '-e', 'owned'], unsatisfiedExitCodes: [1] } }],
        } });
    const current = await getMachineSetupDesiredV1({ read: async () => ({ status: 'ready', metadataVersion: 1,
        metadata: { setup: { version: 1, revision: 1, sources, sourceFacts, exclusions: [] } } }),
        compareAndSwap: async () => { throw new Error('Review must not write desired Software'); } });
    const planned: string[] = [];
    const deps = createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
        if ('targets' in input) throw new Error('The native leaf receives one Machine');
        planned.push(input.machineId);
        return prepareMachineSetupPlanV1({ input, current, readRecipes: async () => [recipe], runNative: async command => {
            if (command.executable !== 'test') throw new Error('Review must not run an effect');
            return { code: command.args.includes('!') ? 1 : 0, stdout: '', stderr: '' };
        } });
    } });
    const combined = createCombinedMachineSetupActionDeps({ readDeps: () => deps, targetPlan: deps.machineSetupPlan!,
        readHostFacts: async () => ({ machines: machines.map(machine => ({ machineId: machine.id, online: true })) }), orchestrationDirectory: '.',
        startCombined: async () => { throw new Error('Review must not start a Run'); }, waitForRun: async () => { throw new Error('Review must not await a Run'); } });
    const executor = createActionExecutor({ ...deps, machineSetupPlan: combined.machineSetupPlan });
    account.home.answer(home.serverId, '/v1/actions/machines.setup.plan', { select: async input => {
        const authorized = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(input);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(authorized.success ? authorized.data.envelope : input);
        return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId,
            execution: await executor.execute('machines.setup.plan', envelope.input, { surface: 'ui', authority: 'present_user' }) } };
    } });
    const { computeExternalActionRequestEnvelopeDigestV1 } = await import('@happier-dev/protocol/actions/externalActionExecutionAuthorization');
    const { readOriginalAccountActionAuthentication } = await import('@/sync/api/externalActionAccountTransport');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const captured = await captureLazyActionAccountContext(home.serverId);
    onTestFinished(() => captured.dispose());
    for (const actionId of ['machines.setup.plan', 'machines.setup.remove'] as const) {
        account.home.answer(home.serverId, bindExternalActionExecutionAuthorizationHttpPathV1(actionId), { select: input => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
            if (envelope.target?.kind !== 'machine') throw new Error('Setup needs one exact Machine');
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'removal-test-authorization', binding: {
                accountId: scope.accountId, authentication: readOriginalAccountActionAuthentication(captured.credentials.token),
                serverIdentityId: captured.serverIdentityId, machineId: envelope.target.machineId, custodianAccountId: scope.accountId,
                installationId: 'test-installation', accountEncryptionMode: 'plain', actionId,
                requestId: envelope.requestId, target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            } }) };
        } });
    }
    const removals: unknown[] = [];
    account.home.answer(home.serverId, '/v1/actions/machines.setup.remove', { select: input => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(input);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.success ? request.data.envelope : input);
        removals.push(envelope.input);
        // Genuine Home transport boundary stops at its ordinary approval receipt; no removal runs.
        return { body: { v: 1, actionId: 'machines.setup.remove', requestId: envelope.requestId,
            execution: { ok: true, result: { kind: 'approval_request_created', actionId: 'machines.setup.remove', artifactId: 'software-removal-approval' } } } };
    } });
    const inventory = await renderHook(() => useManagedInventory({ scope, machine: null, projectKey: null, presented: true }), { wrapper: Boundary });
    await vi.waitFor(() => expect(inventory.getCurrent().families.software.rows).toHaveLength(1));
    const row = inventory.getCurrent().families.software.rows[0]!;
    expect(row.installations.map(installation => installation.machineId)).toEqual(machines.map(machine => machine.id));
    const prefix = count === 1 ? 'machine.inventory' : 'store.installed';
    const page = await renderScreen(<PluginSurfaceFocusEligibilityProvider active>{count === 1
        ? <MachineInventoryBlock serverId={scope.serverId} machineId="software-a" scope={scope} /> : <InstalledPage />}</PluginSurfaceFocusEligibilityProvider>);
    const id = `${prefix}.section.software.row.${row.key}`;
    await vi.waitFor(() => expect(page.findByTestId(id)).not.toBeNull());
    expect(page.findAllHostsByTestId(`${id}.remove`)).toHaveLength(1);
    expect(planned).toEqual([]);
    await page.pressByTestIdAsync(`${id}.remove`);
    const config = show.mock.calls[0]![0];
    const close = vi.fn();
    function PresentedModal() {
        const [chrome, setChrome] = React.useState<import('@/modal/types').CustomModalChromeConfig | null>(null);
        // Match CustomModal's content identity: publishing chrome must not rerender its content.
        const content = React.useMemo(() => <config.component {...config.props} onClose={close} setChrome={setChrome} />, []);
        return <>{content}{chrome?.kind === 'card' ? chrome.footer : null}</>;
    }
    const modal = await renderScreen(<PresentedModal />);
    if (count > 1) {
        const { SelectionListFilterChip } = await import('@/components/ui/selectionList');
        const { filter: picker } = modal.findByType(SelectionListFilterChip).props;
        expect(picker.options.map((entry: { id: string }) => entry.id).sort()).toEqual(['software-a', 'software-b']);
        expect(picker.options.every((entry: { disabled?: boolean }) => !entry.disabled)).toBe(true);
        expect(picker.selectedId).toBeNull();
        expect(picker.muted).toBe(true);
        expect(picker.valueLabel).toBeTruthy();
        expect(planned).toEqual([]);
        await act(async () => { picker.onChange('software-b'); });
    }
    const selected = count === 1 ? 'software-a' : 'software-b';
    const { MachineSetupPlanReview } = await import('@/components/settings/machines/managed/MachineSetupPlanReview');
    await waitForHomeGovernance(async () => { await flushHookEffects(); expect({
        reviews: modal.findAllByType(MachineSetupPlanReview).length,
        error: modal.findByTestId('store.software.review.error')?.props.diagnosticCode,
        planned,
    }, JSON.stringify({ actionPaths: account.home.requests.filter(request => request.path.includes('machines.setup')).map(request => request.path), text: modal.getTextContent() })).toMatchObject({ reviews: 1, error: undefined, planned: expect.arrayContaining([selected]) }); });
    expect(new Set(planned)).toEqual(new Set([selected]));
    expect(modal.findByType(MachineSetupPlanReview).props.prepared.input).toMatchObject({ machineId: selected, removeItemKeys: [], removalPlans: [] });
    const switchId = `store.software.review.remove.${selected}.${machineSetupItemKeyV1(item)}.switch`;
    expect(modal.findByTestId(switchId)?.props.value).toBe(false);
    await act(async () => { modal.findByTestId(switchId)!.props.onValueChange(true); });
    await waitForHomeGovernance(async () => { await flushHookEffects(); expect(modal.findByType(MachineSetupPlanReview).props.prepared.input.removeItemKeys).toEqual([machineSetupItemKeyV1(item)]); });
    expect(new Set(planned)).toEqual(new Set([selected]));
    expect(modal.findByType(MachineSetupPlanReview).props.prepared.input.removalPlans[0].plan.steps[0].executable).toBe('remove-owned');
    const reviewedInput = modal.findByType(MachineSetupPlanReview).props.prepared.input;
    if (count > 1) {
        expect(removals).toEqual([]);
        await modal.pressByTestIdAsync('store.software.review.remove');
        await waitForHomeGovernance(() => expect(removals).toEqual([reviewedInput]));
        expect(removals[0]).toMatchObject({ machineId: 'software-b', removeItemKeys: [machineSetupItemKeyV1(item)] });
        expect(removals[0]).not.toHaveProperty('targets');
        await waitForHomeGovernance(async () => { await flushHookEffects(); expect(modal.findByTestId('store.software.review.waiting')).not.toBeNull(); });
    } else {
        await modal.pressByTestIdAsync('store.software.review.cancel');
        expect(close).toHaveBeenCalledOnce();
        expect(removals).toEqual([]);
    }
});

it('labels a Project placement with its admitted Project name', async () => {
    const machine = createMachineFixture({ id: 'project-machine', metadata: { ...createMachineFixture().metadata!,
        agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } } });
    const home = await account.restore({ serverIdentityId: 'srv_inventory_project_label', machines: [machine] });
    const scope = storage.getState().settingsScope!;
    await act(async () => { applyProjectAccountRowsFixture(storage, { workspaceRefs: [{ id: 'atlas-checkout',
        serverId: scope.serverId, machineId: machine.id, rootPath: '/work/atlas', projectKey: 'atlas',
        label: 'Atlas platform', createdAtMs: 1 }] }); });
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { body: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, servers: [{ id: 'atlas-docs', name: 'atlas-docs', transport: 'stdio',
            stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [{ id: 'atlas-on',
            serverId: 'atlas-docs', enabled: true, target: { t: 'project', projectKey: 'atlas' }, createdAt: 1, updatedAt: 1 }] } } } });
    const page = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><InstalledPage projectKey="atlas" /></PluginSurfaceFocusEligibilityProvider>);
    await vi.waitFor(() => expect(page.findByTestId('store.installed.section.mcpServer')).not.toBeNull());
    await page.pressByTestIdAsync('store.installed.group.project');
    expect(page.findAllByTestId('store.installed.section.atlas').find(node => typeof node.props.title === 'string')?.props.title).toBe('Atlas platform');
    expect(rpc.state.requests).toHaveLength(0);
});

it('keeps a native failed-family reason and recovery beside retained rows and no matches through every grouping', async () => {
    const home = await account.restore({ serverIdentityId: 'srv_installed_page_coverage', machines: [] });
    const scope = storage.getState().settingsScope!;
    const available = { body: { status: 'present', revision: 1,
        content: { t: 'plain', v: { v: 1, servers: [{ id: 'retained', name: 'retained', title: 'Retained docs', transport: 'stdio',
            stdio: { command: 'docs', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] } } } };
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, available);
    const page = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><InstalledPage /></PluginSurfaceFocusEligibilityProvider>);
    await vi.waitFor(() => expect(page.findByTestId('store.installed.section.mcpServer')).not.toBeNull());
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, { status: 503, body: { error: 'unreachable' } });
    await act(async () => { await refreshMcpServerCatalog(scope); });
    for (const group of ['kind', 'machine', 'project']) {
        if (group !== 'kind') await page.pressByTestIdAsync(`store.installed.group.${group}`);
        const failure = page.findAllByTestId('store.installed.coverage.unavailable').find(node => node.props.diagnosticCode);
        expect(failure).toBeDefined();
        expect(failure?.props.diagnosticCode.split(', ')).toContain('unreachable');
        const section = group === 'kind' ? 'mcpServer' : group === 'machine' ? 'account' : 'unassigned';
        expect(page.findByTestId(`store.installed.section.${section}.row.${serverAccountScopedResourceKey(scope, 'mcpServer', 'retained')}`)).not.toBeNull();
    }
    await act(async () => { page.changeTextByTestId('store.installed.search', 'no matching resource'); });
    expect(page.findByTestId('store.installed.noMatch')).not.toBeNull();
    expect(page.findByTestId('store.installed.coverage.unavailable')).not.toBeNull();
    account.home.answer(home.serverId, `GET ${MCP_SERVER_CATALOG_ROWS_ROUTE_V1}`, available);
    const failure = page.findAllByTestId('store.installed.coverage.unavailable').find(node => node.props.diagnosticCode);
    await act(async () => { await failure?.props.action.onPress(); });
    // The one unavailable line stops naming MCP servers; other kinds this harness never answers may still be named.
    const mcp = t('capabilities.store.kinds.mcpServer.title');
    await vi.waitFor(() => expect(page.findAllByTestId('store.installed.coverage.unavailable')
        .some(node => String(node.props.title ?? '').includes(mcp))).toBe(false));
    expect(rpc.state.requests).toHaveLength(0);
});

it('moves the App family by its native pages and keeps each Environment home reachable', async () => {
    const { createDeploymentEnvironmentHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1} = await import('@happier-dev/protocol/deployments/deploymentActionsV1');
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const identity = 'srv_installed_page_app_pages';
    const home = await account.restore({ serverIdentityId: identity, machines: [createMachineFixture({ id: 'controller' })] });
    const scope = { ...storage.getState().settingsScope!, serverId: identity };
    const context = await captureLazyActionAccountContext(scope.serverId);
    onTestFinished(() => context.dispose());
    const env = (id: string) => createDeploymentEnvironmentHeaderV1({ id, contentArtifactId: `${id}-label`, projectSourceId: `${id}-source`,
        serverId: identity, controllerMachineId: 'controller', buildMachineId: 'controller' });
    const first = env('first-app');
    const second = env('second-app');
    // Page 1 holds more rows than the preview: the native page rail stays out of the closed preview.
    const firstPage = [first, ...['a', 'b', 'c', 'd'].map((suffix) => env(`first-app-${suffix}`))];
    for (const environment of [...firstPage, second]) await context.createArtifactDocument({ artifactId: environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: environment.id }, body: '{}' });
    account.home.answer(home.serverId, '/v1/deployments/environments', { select: (_input, request) => {
        const later = new URL(request.url).searchParams.get('cursor') === 'page-2';
        return { body: { ok: true, items: later ? [second] : firstPage, runtimeTargetLinks: [], coverage: 'complete',
            nextCursor: later ? null : 'page-2' } };
    } });
    const page = await renderScreen(<PluginSurfaceFocusEligibilityProvider active><Boundary><InstalledPage /></Boundary></PluginSurfaceFocusEligibilityProvider>);
    const row = (environment: typeof first) => `store.installed.section.app.row.${serverAccountScopedResourceKey(scope, 'app', environment.id)}`;
    await vi.waitFor(() => expect(page.findByTestId(row(first))).not.toBeNull());
    const shown = page.findAllByTestId(row(first)).find(node => 'description' in node.props);
    expect(shown?.props.description).toBeNull();
    expect(shown?.props.onPress).toBeTypeOf('function');
    await page.pressByTestIdAsync(row(first));
    expect(routeMock.push).toHaveBeenLastCalledWith(buildDeploymentEnvironmentHref({ serverId: identity,
        projectSourceId: first.projectSourceId, environmentId: first.id }));
    // Under the preview there is no page rail: Next would skip this page's unseen rows.
    expect(page.findByTestId('store.installed.section.app.next')).toBeNull();
    await page.pressByTestIdAsync('store.installed.section.app.all');
    // After All, the rail sits at the end with Fewer beside it, so a long page closes where it ends.
    expect(page.findByTestId('store.installed.section.app.paging.fewer')).not.toBeNull();
    await page.pressByTestIdAsync('store.installed.section.app.next');
    await vi.waitFor(() => expect(page.findByTestId(row(second))).not.toBeNull());
    expect(page.findAllByTestId(row(second)).find(node => 'onPress' in node.props)?.props.onPress).toBeTypeOf('function');
    await page.pressByTestIdAsync(row(second));
    expect(routeMock.push).toHaveBeenLastCalledWith(buildDeploymentEnvironmentHref({ serverId: identity,
        projectSourceId: second.projectSourceId, environmentId: second.id }));
    expect(page.findByTestId('store.installed.section.app.previous')).not.toBeNull();
    expect(page.findByTestId('store.installed.section.app.next')).toBeNull();
});
