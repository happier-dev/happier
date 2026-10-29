import * as React from 'react';
import '@/dev/testkit/harness/syncSingletonLoader';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

const rpc = vi.hoisted(() => ({ requests: [] as Array<Readonly<{ method: string; machineId: string; serverId?: string | null; payload: unknown }>> }));
// Home HTTP, device credentials and Machine RPC are the boundaries; Action admission,
// Account catalog, discovery/cache and picker projection remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    const invoke = async (request: typeof rpc.requests[number]): Promise<unknown> => {
        rpc.requests.push(request);
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE)
            return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
                projection: { v: 2, generation: 1, familiesById: {} } });
        throw new Error(`Unexpected Machine RPC: ${request.method}`);
    };
    // The arbitrary generic wire return is narrowed by real response schemas above this boundary.
    return createServerScopedMachineRpcBoundaryMock(invoke as typeof import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc').machineRpcWithServerScope);
});
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@expo/vector-icons/Ionicons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const icons = createExpoVectorIconsMock();
    return { default: icons.Ionicons, Ionicons: icons.Ionicons };
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);
const { renderSettingsView } = await import('@/dev/testkit/harness/settingsViewHarness');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { ScmDiffSummaryModelPicker } = await import('./ScmDiffSummaryModelPicker');
const { getStorage } = await import('@/sync/domains/state/storage');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { resetDynamicModelProbeCacheForTests } = await import('@/sync/domains/models/dynamicModelProbeCache');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetAcpCatalogEngineForTests } = await import('@/sync/engine/settings/acpCatalogEngine');
const { resetAcpCatalogSnapshotsForTests } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { getAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { readCachedDaemonMergedProjectionCacheEntry } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { standardCleanup } = await import('@/dev/testkit/cleanup/standardCleanup');

describe('Summary model discovery', () => {
    const initialStorage = getStorage().getState();
    beforeEach(async () => { await homes.reset(); rpc.requests = []; resetDynamicModelProbeCacheForTests(); clearDaemonMergedProjectionCacheForTests(); resetAcpCatalogEngineForTests(); resetAcpCatalogSnapshotsForTests(); });
    afterEach(async () => { standardCleanup(); getStorage().setState(initialStorage, true); await homes.reset(); });
    it.each([
        { name: 'Codex', target: { kind: 'backend' as const, backendId: 'codex' }, configured: false },
        { name: 'configured ACP', target: { kind: 'backend' as const, backendId: 'review-bot', configuredBackendId: 'review-bot' }, configured: true },
    ])('discovers $name without saving a fabricated model choice', async ({ target, configured }) => {
        const serverUrl = 'https://summary-discovery.example.test';
        const serverIdentityId = 'srv_summary_discovery';
        const accountId = 'summary-discovery-account';
        const token = `test.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.test`;
        const homeId = await homes.addHome({ name: 'Summary discovery', serverUrl, serverIdentityId,
            accountId, credentials: { token }, accountEncryptionMode: 'plain', currentAccount: true });
        const scope = { serverId: homeId, accountId: 'summary-discovery-account' };
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: configured ? [{ id: target.backendId,
            name: target.backendId, title: 'Review Bot', launch: { kind: 'command' as const, command: 'review-cli', args: ['acp'] }, env: {}, createdAt: 1, updatedAt: 1 }] : [] });
        homes.answer(homeId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 1, content: { t: 'plain', v: record },
        }) });
        homes.answer(homeId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        } });
        const machine = createMachineFixture({ id: 'summary-discovery-machine', activeAt: Date.now() });
        const observations: Array<string | undefined> = [];
        let discoveries = 0;
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId,
            machineId: machine.id, actionId: 'agents.models.list', tokenEpoch: 1,
            execute(input, context) {
                expect(input).toMatchObject({ purpose: 'scm_diff_summary', machineId: machine.id });
                const discoveryTargetKey = input && typeof input === 'object' && 'discoveryTargetKey' in input ? input.discoveryTargetKey : undefined;
                if (discoveryTargetKey) expect(discoveryTargetKey).toBe(buildBackendTargetKeyV2(target));
                expect(context.target).toEqual({ kind: 'machine', machineId: machine.id });
                observations.push(typeof discoveryTargetKey === 'string' ? discoveryTargetKey : undefined);
                if (discoveryTargetKey) discoveries += 1;
                const automaticModels = [{ id: 'initial-model', name: 'Initial model', costTier: 'low' as const,
                    capabilities: { structuredOutput: 'supported' as const } }];
                const models = discoveries === 0 ? automaticModels : [...automaticModels,
                    { id: 'real-model', name: 'Real model', costTier: 'low' as const, capabilities: { structuredOutput: 'supported' as const } },
                    { id: 'rejected-model', name: 'Rejected model', capabilities: { structuredOutput: 'unsupported' as const } },
                    { id: 'unknown-model', name: 'Unknown model', capabilities: { structuredOutput: 'unknown' as const } },
                    ...(discoveries > 1 ? [{ id: 'refreshed-model', name: 'Refreshed model', capabilities: { structuredOutput: 'supported' as const } }] : []),
                ];
                const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(target), models });
                return { items: [], scmDiffSummaryCatalog: { profiles,
                    automaticProfiles: configured ? [] : buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(target), models: automaticModels }),
                    discoveryTargetKeys: [buildBackendTargetKeyV2(target)] } };
            } });
        for (const path of ['/v1/machines', '/v1/machines/read-batch', '/v1/actions/agents.models.list/execution-authorization', '/v1/actions/agents.models.list']) {
            homes.answer(homeId, path, { select: async input => {
                const response = await boundary.handle(new URL(path, serverUrl), input === undefined ? undefined
                    : { method: 'POST', body: JSON.stringify(input) });
                if (!response) throw new Error(`Unexpected catalog boundary path: ${path}`);
                return { body: await response.json() };
            } });
        }
        getStorage().setState({ settingsScope: scope, profileScope: scope,
            machines: { [machine.id]: machine }, machineListByServerId: { [homeId]: [machine] } });
        const change = vi.fn();
        const selection = vi.fn();
        function Picker() {
            const [value, setValue] = React.useState('');
            return <ScmDiffSummaryModelPicker value={value} onChange={next => { change(next); setValue(next); }}
                onSelection={selection} machineId={machine.id} serverId={homeId} defaultBackendTarget={target} />;
        }
        const screen = await renderSettingsView(<Picker />);
        const menu = () => screen.findAll(node => node.type === DropdownMenu)[0];
        await act(async () => { menu().props.onOpenChange(true); });
        const diagnostic = () => JSON.stringify({ paths: homes.requests.map(request => request.path), rpc: rpc.requests,
            catalog: getAcpCatalogSnapshot(scope), projection: readCachedDaemonMergedProjectionCacheEntry({ machineId: machine.id, serverId: homeId }),
            items: menu().props.items.map(({ id, title, disabled, subtitle }: { id: string; title: string; disabled?: boolean; subtitle?: string }) => ({ id, title, disabled, subtitle })) });
        const id = `backend-discovery:${buildBackendTargetKeyV2(target)}`;
        await vi.waitFor(() => expect(menu().props.items.find((item: { id: string }) => item.id === id),
            diagnostic()).toBeDefined());
        const discovery = menu().props.items.find((item: { id: string }) => item.id === id);
        await act(async () => { menu().props.onSelect(discovery.id); });
        expect(change).not.toHaveBeenCalled();
        expect(selection).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(menu().props.items.find((item: { title: string }) => item.title === 'Real model'),
            diagnostic()).toBeDefined());
        expect(discoveries).toBe(1);
        expect(rpc.requests.some(request => request.method === RPC_METHODS.CAPABILITIES_INVOKE)).toBe(false);
        const rows = menu().props.items.filter((item: { title: string }) => item.title === 'Real model');
        // Discovery adds choices without changing the automatic default marker.
        expect(rows).toHaveLength(1);
        const offered = rows[0];
        expect(offered).toMatchObject({ subtitle: 'Low cost' });
        expect(offered.disabled).not.toBe(true);
        // Models that cannot write a walkthrough are not dead rows: the agent's section says once how many it leaves out.
        expect(menu().props.items.some((item: { title: string }) => item.title === 'Rejected model' || item.title === 'Unknown model')).toBe(false);
        expect(menu().props.showCategoryTitles).toBe(true);
        expect(menu().props.categoryDecorations[offered.category]).toMatchObject({ note: '2 models can’t write walkthroughs' });
        expect(menu().props.categoryDecorations[offered.category].icon).toBeTruthy();
        // Discovery is one operation inside that agent's section and does not repeat the agent's name.
        const sectionOperation = menu().props.items.find((item: { id: string }) => item.id === id);
        expect(sectionOperation).toMatchObject({ category: offered.category });
        expect(sectionOperation.subtitle).toBeUndefined();
        expect(menu().props.items.some((item: { id: string }) => item.id === '')).toBe(false);
        const automatic = menu().props.items.find((item: { title: string }) => item.title === 'Initial model');
        expect(automatic).toMatchObject({ subtitle: configured ? 'Low cost' : 'Default · Low cost' });
        expect(menu().props.selectedId).toBe(configured ? '' : automatic.id);
        expect(change).not.toHaveBeenCalled();
        expect(getStorage().getState().settings['scm.diffSummary.modelProfileOverride']).toBe('');
        // Dismissing preserves discovered choices, but reopening must use the Machine's cache.
        await act(async () => { menu().props.onOpenChange(false); });
        const beforeReopen = observations.length;
        await act(async () => { menu().props.onOpenChange(true); });
        await vi.waitFor(() => expect(observations.length).toBeGreaterThan(beforeReopen));
        expect(observations.slice(beforeReopen).every(key => key === undefined)).toBe(true);
        await vi.waitFor(() => expect(menu().props.items.some((item: { title: string }) => item.title === 'Real model')).toBe(true));
        expect(discoveries).toBe(1);
        // A second explicit operation refreshes even though the same target remains selected for discovery.
        await act(async () => { menu().props.onSelect(id); });
        await vi.waitFor(() => expect(menu().props.items.some((item: { title: string }) => item.title === 'Refreshed model')).toBe(true));
        expect(discoveries).toBe(2);
        expect(change).not.toHaveBeenCalled();
        expect(selection).not.toHaveBeenCalled();
        // Choosing the default returns to following it; the catalog's default is never written as a preference.
        await act(async () => { menu().props.onSelect(automatic.id); });
        expect(change).toHaveBeenCalledWith(configured ? automatic.id : '');
        expect(selection).toHaveBeenCalledWith(expect.objectContaining({
            backendTarget: expect.objectContaining(target), modelSelector: expect.objectContaining({ modelId: 'initial-model' }),
        }));
        await act(async () => { menu().props.onOpenChange(true); });
        await vi.waitFor(() => expect(menu().props.items.some((item: { title: string }) => item.title === 'Real model')).toBe(true));
        const explicit = menu().props.items.find((item: { title: string }) => item.title === 'Real model');
        await act(async () => { menu().props.onSelect(explicit.id); });
        expect(menu().props.open).toBe(false);
        expect(menu().props.itemTrigger.detailFormatter()).toBe('Real model');
        await screen.unmount();
    });
    /** One configured Agent on one Machine whose strict catalog observation is whatever `execute` answers. */
    async function mountPickerOver(name: string, execute: (input: unknown) => unknown) {
        const serverUrl = `https://${name}.example.test`;
        const serverIdentityId = `srv_${name.replaceAll('-', '_')}`;
        const accountId = `${name}-account`;
        const token = `test.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.test`;
        const homeId = await homes.addHome({ name, serverUrl, serverIdentityId,
            accountId, credentials: { token }, accountEncryptionMode: 'plain', currentAccount: true });
        const scope = { serverId: homeId, accountId };
        const target = { kind: 'backend' as const, backendId: 'review-bot', configuredBackendId: 'review-bot' };
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot',
            launch: { kind: 'command' as const, command: 'review-cli', args: ['acp'] }, env: {}, createdAt: 1, updatedAt: 1 }] });
        homes.answer(homeId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 1, content: { t: 'plain', v: record } }) });
        homes.answer(homeId, '/v1/account/encryption/currentness', { body: {
            mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
        const machine = createMachineFixture({ id: `${name}-machine`, activeAt: Date.now() });
        const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId, accountId,
            machineId: machine.id, actionId: 'agents.models.list', tokenEpoch: 1, execute });
        for (const path of ['/v1/machines', '/v1/machines/read-batch', '/v1/actions/agents.models.list/execution-authorization', '/v1/actions/agents.models.list']) {
            homes.answer(homeId, path, { select: async input => {
                const response = await boundary.handle(new URL(path, serverUrl), input === undefined ? undefined
                    : { method: 'POST', body: JSON.stringify(input) });
                if (!response) throw new Error(`Unexpected catalog boundary path: ${path}`);
                return { body: await response.json() };
            } });
        }
        getStorage().setState({ settingsScope: scope, profileScope: scope,
            machines: { [machine.id]: machine }, machineListByServerId: { [homeId]: [machine] } });
        const change = vi.fn();
        const selection = vi.fn();
        const availability = vi.fn();
        const picker = (machineId: string) => <ScmDiffSummaryModelPicker value="" onChange={change}
            onSelection={selection} onAvailabilityChange={availability}
            machineId={machineId} serverId={homeId} defaultBackendTarget={target} />;
        const screen = await renderSettingsView(picker(machine.id));
        const menu = () => screen.findAll(node => node.type === DropdownMenu)[0];
        await act(async () => { menu().props.onOpenChange(true); });
        return { screen, menu, target, change, selection, availability,
            switchMachine: (machineId: string) => screen.update(picker(machineId)) };
    }
    const catalogOf = (target: { kind: 'backend'; backendId: string; configuredBackendId: string }, failure?: unknown) => ({ items: [],
        scmDiffSummaryCatalog: { profiles: [], automaticProfiles: [], discoveryTargetKeys: [buildBackendTargetKeyV2(target)],
            ...(failure ? { probeFailures: [{ backendTargetKey: buildBackendTargetKeyV2(target), spawnFailure: failure }] } : {}) } });
    const reviewBot = { kind: 'backend' as const, backendId: 'review-bot', configuredBackendId: 'review-bot' };
    it.each([
        { errno: 'ENOENT', title: 'Not installed on this machine', next: 'Check its command and working directory, then try again.' },
        { errno: 'EACCES', title: 'Can’t run on this machine', next: 'Check its execution permissions, then try again.' },
        { errno: undefined, title: 'Couldn’t start on this machine', next: 'Try again in a moment.' },
    ])('says why an Agent that cannot start is unavailable ($errno) instead of listing nothing', async ({ errno, title, next }) => {
        // The Machine's strict observation: no model could be listed because the Agent's process did not start.
        const { screen, menu } = await mountPickerOver(`summary-probe-failure-${errno ?? 'other'}`.toLowerCase(),
            () => catalogOf(reviewBot, errno ? { reason: 'other', errno } : { reason: 'too_many_open_files' }));
        const items = () => menu().props.items as ReadonlyArray<{ id: string; title: string; subtitle?: string; category: string }>;
        await vi.waitFor(() => expect(items().map(item => item.title)).toEqual([title]));
        // The Agent keeps its section with one row that says what happened and what to check; pressing it asks again.
        // No model row is invented, and neither the errno nor the command's path reaches the person.
        expect(items()[0]).toMatchObject({ id: `backend-discovery:${buildBackendTargetKeyV2(reviewBot)}`, subtitle: next });
        expect(JSON.stringify(items())).not.toMatch(/E[A-Z]{3,}\b|review-cli/u);
        await screen.unmount();
    });
    const modelRow = { id: 'real-model', name: 'Real model', costTier: 'low' as const, capabilities: { structuredOutput: 'supported' as const } };
    const catalogWithModel = (extra: Record<string, unknown> = {}) => ({ items: [], scmDiffSummaryCatalog: {
        profiles: buildScmDiffSummaryModelProfiles({ backendTarget: readBackendTargetRefV2(reviewBot), models: [modelRow] }),
        automaticProfiles: [], discoveryTargetKeys: [buildBackendTargetKeyV2(reviewBot)], ...extra } });
    type MenuItem = Readonly<{ id: string; title: string; subtitle?: string; disabled?: boolean; category?: string }>;
    const discoveryId = `backend-discovery:${buildBackendTargetKeyV2(reviewBot)}`;
    it('keeps the last readable choices when a refresh fails, says so, and recovers on retry', async () => {
        let refusing = false;
        const { screen, menu, change, selection, availability } = await mountPickerOver('summary-refresh-failure', () => {
            if (refusing) throw new Error('machine unreachable');
            return catalogWithModel({ automaticProfiles: catalogWithModel().scmDiffSummaryCatalog.profiles });
        });
        const items = () => menu().props.items as ReadonlyArray<MenuItem>;
        await vi.waitFor(() => expect(items().map(item => item.title)).toContain('Real model'));
        const modelId = items().find(item => item.title === 'Real model')!.id;
        expect(items().find(item => item.id === modelId)?.subtitle).toBe('Default · Low cost');
        expect(menu().props.selectedId).toBe(modelId);
        await vi.waitFor(() => expect(availability).toHaveBeenLastCalledWith(true));
        expect(items().some(item => item.id === 'catalog-refresh')).toBe(false);
        refusing = true;
        await act(async () => { menu().props.onSelect(discoveryId); });
        await vi.waitFor(() => expect(items().find(item => item.id === 'catalog-refresh')).toMatchObject({
            title: 'Couldn’t refresh models', subtitle: 'Showing the last list. Try again.' }));
        // The choices the person already saw stay readable and selectable; the failure is a quiet row, not an empty menu.
        expect(items().find(item => item.title === 'Real model')?.disabled).not.toBe(true);
        expect(items().find(item => item.id === modelId)?.subtitle).toBe('Low cost');
        expect(menu().props.selectedId).toBe('');
        await vi.waitFor(() => expect(availability).toHaveBeenLastCalledWith(false));
        await act(async () => { menu().props.onSelect(modelId); });
        expect(change).toHaveBeenLastCalledWith(modelId);
        expect(selection).toHaveBeenLastCalledWith(expect.objectContaining({
            modelSelector: expect.objectContaining({ modelId: modelRow.id }),
        }));
        expect(menu().props.emptyLabel).toBe('No models found');
        refusing = false;
        await act(async () => { menu().props.onOpenChange(true); menu().props.onSelect('catalog-refresh'); });
        await vi.waitFor(() => expect(items().some(item => item.id === 'catalog-refresh')).toBe(false));
        expect(items().map(item => item.title)).toContain('Real model');
        expect(items().find(item => item.id === modelId)?.subtitle).toBe('Default · Low cost');
        expect(menu().props.selectedId).toBe(modelId);
        await vi.waitFor(() => expect(availability).toHaveBeenLastCalledWith(true));
        await screen.unmount();
    });
    it('retires the retained choices when the Machine changes instead of showing another Machine\u2019s list', async () => {
        let refusing = false;
        const { screen, menu, switchMachine } = await mountPickerOver('summary-refresh-identity', () => {
            if (refusing) throw new Error('machine unreachable');
            return catalogWithModel();
        });
        const titles = () => (menu().props.items as ReadonlyArray<MenuItem>).map(item => item.title);
        await vi.waitFor(() => expect(titles()).toContain('Real model'));
        refusing = true;
        await act(async () => { await switchMachine('another-machine'); });
        await vi.waitFor(() => expect(menu().props.emptyLabel).toBe('Couldn’t load models. Try again.'));
        expect(titles()).not.toContain('Real model');
        await screen.unmount();
    });
    it.each([
        { reason: 'native_sign_in_required', next: 'Not picked automatically until you sign in on this machine.' },
        { reason: 'native_auth_unavailable', next: 'Sign-in couldn’t be checked, so it isn’t picked automatically. Try again.' },
        { reason: 'connected_default_unavailable', next: 'Its connected account isn’t available, so it isn’t picked automatically. Check Connected services.' },
    ])('explains why automatic choice skips an Agent ($reason) while its explicit models stay selectable', async ({ reason, next }) => {
        const { screen, menu } = await mountPickerOver(`summary-unavailable-${reason.replaceAll('_', '-')}`,
            () => catalogWithModel({ unavailableTargets: [{ backendTargetKey: buildBackendTargetKeyV2(reviewBot), reason }] }));
        const items = () => menu().props.items as ReadonlyArray<MenuItem>;
        await vi.waitFor(() => expect(items().find(item => item.id === discoveryId)).toMatchObject({ title: 'Find more models', subtitle: next }));
        // Explicit choices are not labelled by the automatic route's availability.
        const model = items().find(item => item.title === 'Real model');
        expect(model).toBeDefined();
        expect(model?.disabled).not.toBe(true);
        expect(model?.subtitle ?? '').not.toMatch(/sign|auth|unavailable/iu);
        expect(items().some(item => item.id === 'catalog-refresh')).toBe(false);
        await screen.unmount();
    });
    it('groups Agents that offer no models yet under one message with one retry, instead of repeating it per Agent', async () => {
        const agents = [{ kind: 'backend' as const, backendId: 'codex' }, { kind: 'backend' as const, backendId: 'opencode' }, reviewBot];
        const keys = agents.map(agent => buildBackendTargetKeyV2(agent));
        let reads = 0;
        const { screen, menu } = await mountPickerOver('summary-grouped-auth-unknown', () => (reads++, { items: [], scmDiffSummaryCatalog: {
            profiles: [], automaticProfiles: [], discoveryTargetKeys: keys,
            unavailableTargets: keys.map(backendTargetKey => ({ backendTargetKey, reason: 'native_auth_unavailable' })) } }));
        const items = () => menu().props.items as ReadonlyArray<MenuItem>;
        await vi.waitFor(() => expect(items().filter(item => item.id.startsWith('backend-discovery:'))).toHaveLength(3));
        // The shared reason is said once, with its count and the next action; no Agent row repeats it.
        const mentions = items().filter(item => /Sign-in couldn’t be checked/u.test(`${item.title} ${item.subtitle ?? ''}`));
        expect(mentions).toHaveLength(1);
        expect(mentions[0]!.title).toMatch(/3 agents/u);
        // Each Agent stays one row, named for itself, that still asks that Agent for its models.
        const rows = items().filter(item => item.id.startsWith('backend-discovery:'));
        expect(new Set(rows.map(row => row.category)).size).toBe(1);
        expect(rows.every(row => row.subtitle === undefined && row.title !== 'Find more models')).toBe(true);
        expect(rows.map(row => row.id).sort()).toEqual(keys.map(key => `backend-discovery:${key}`).sort());
        // The message row retries the Machine's catalog.
        expect(mentions[0]!.category).toBe(rows[0]!.category);
        const before = reads;
        await act(async () => { menu().props.onSelect(mentions[0]!.id); });
        await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
        await screen.unmount();
    });
    it.each([
        { name: 'summary-account-metadata-catalog', extra: { unavailableReason: 'account_metadata_unavailable' } },
        { name: 'summary-account-metadata-target', extra: { unavailableTargets: [{ backendTargetKey: buildBackendTargetKeyV2(reviewBot), reason: 'account_metadata_unavailable' }] } },
    ])('tells the person connected accounts could not be read, once, with a retry ($name)', async ({ name, extra }) => {
        const { screen, menu } = await mountPickerOver(name, () => catalogWithModel(extra));
        const items = () => menu().props.items as ReadonlyArray<MenuItem>;
        await vi.waitFor(() => expect(items().filter(item => item.id === 'catalog-refresh')).toEqual([
            expect.objectContaining({ title: 'Some models may be missing', subtitle: 'Couldn’t read your connected accounts. Try again.' })]));
        // The reason lives in the catalog notice, not repeated on the Agent's row.
        expect(items().find(item => item.id === discoveryId)?.subtitle).toBeUndefined();
        expect(items().map(item => item.title)).toContain('Real model');
        await screen.unmount();
    });
    it.each([
        { name: 'summary-empty-loading', label: 'Loading models…', execute: () => new Promise(() => {}) },
        { name: 'summary-empty-refused', label: 'Couldn’t load models. Try again.', execute: () => { throw new Error('machine unreachable'); } },
        { name: 'summary-empty-none', label: 'No models found', execute: () => ({ items: [], scmDiffSummaryCatalog: { profiles: [], automaticProfiles: [], discoveryTargetKeys: [] } }) },
    ])('says why the menu is empty rather than "No commands found": $name', async ({ name, label, execute }) => {
        const { screen, menu } = await mountPickerOver(name, execute);
        await vi.waitFor(() => expect(menu().props.emptyLabel).toBe(label));
        await screen.unmount();
    });
    it('says a Machine is needed first, rather than "No models found", when none is chosen', async () => {
        const screen = await renderSettingsView(<ScmDiffSummaryModelPicker value="" onChange={vi.fn()} />);
        const menu = screen.findAll(node => node.type === DropdownMenu)[0];
        expect(menu.props.emptyLabel).toBe('Choose a machine first to see its models.');
        await screen.unmount();
    });
    it('names what an unset choice runs on instead of asking for a choice that is not required', async () => {
        const trigger = async (unsetLabel?: string) => {
            const screen = await renderSettingsView(<ScmDiffSummaryModelPicker presentation="inline" value="" onChange={vi.fn()} unsetLabel={unsetLabel} />);
            const label = String(screen.findAll(node => node.props.testID === 'walkthrough.summaryModel' && typeof node.props.accessibilityLabel === 'string')[0]?.props.accessibilityLabel);
            await screen.unmount();
            return label;
        };
        // No catalog can name a default here: a Session-hosted start still runs on the Session's model.
        expect(await trigger('Session model')).toMatch(/Session model$/);
        expect(await trigger()).toMatch(/Choose a model$/);
    });

    it('offers no Load models operation, and no placeholder model row, when no machine can answer it', async () => {
        const screen = await renderSettingsView(<ScmDiffSummaryModelPicker value="" onChange={vi.fn()} />);
        const items: ReadonlyArray<{ id: string; title: string }> = screen.findAll(node => node.type === DropdownMenu)[0]!.props.items;
        expect(items.some(item => item.id.startsWith('backend-discovery:'))).toBe(false);
        expect(items.some(item => item.id === '')).toBe(false);
        await screen.unmount();
    });
});
