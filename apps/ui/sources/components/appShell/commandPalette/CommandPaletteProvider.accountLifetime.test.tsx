import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildDeferredDaemonProjectionSections, DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonProjectionSectionBodyResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createHydratedPlainMachineFixture, createSessionFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

import type { PluginUiActionProjection } from '@/sync/domains/plugins/ui/projection';

const machineRpc = vi.hoisted(() => vi.fn());
// Only the machine transport leaves this deterministic palette/Action owner.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { clearDaemonMergedProjectionCacheForTests, loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { useCommandPalettePluginActionPresentation } = await import('./CommandPaletteProvider');

it('opens Home Search Actions on their individual selected origins when the catalog spans Machines', async () => {
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
    const { createPluginUiProjectionUnionPublication } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { buildCommandPaletteCommands } = await import('./buildCommandPaletteCommands');
    const serverId = await homes.addHome({ name: 'Flower Home', serverUrl: 'https://palette-flowers.test', accountId: 'flowers', currentAccount: true });
    storage.setState({ profileScope: { serverId, accountId: 'flowers' }, settingsScope: { serverId, accountId: 'flowers' } });
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://palette-flowers.test', generation: 1 });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Flower Home must be current');
    const pluginIds = ['qa.flowers', 'qa.notes', 'qa.flowers'];
    storage.setState({ machineListByServerId: { [serverId]: pluginIds.map((_, index) => createHydratedPlainMachineFixture({
        id: `palette-machine-${index}`, accountId: 'flowers', machine: { isShared: false },
    })) } });
    const members = pluginIds.map((pluginId, index) => {
        const machineId = `palette-machine-${index}`;
        const sourceCustody = { kind: 'development' as const, registeredRootId: `root-${index}` };
        const executionOrigin = { serverIdentityId: 'srv_palette_flowers', sourceRef: { machineId, pluginId, sourceCustody } };
        return { machineId, serverId, serverIdentityId: executionOrigin.serverIdentityId, phase: 'current' as const,
            interactionEnabled: true, projection: normalizePluginUiProjection({ v: 2, generation: 1,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: pluginId, enabled: true, version: '1.0.0',
                    source: { kind: 'localPath', locator: `root-${index}` }, occurrenceId: `occurrence-${index}`, sourceCustody, executionOrigin } },
                agentsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [], familiesById: {},
                actionsById: { [`${pluginId}/change`]: { id: 'change', pluginId, occurrenceId: `occurrence-${index}`, executionOrigin,
                    title: `Change ${index}`, scopes: ['global', 'session'], surfaces: ['ui'], placementBindings: ['commandPalette'],
                    execution: { target: 'daemon' }, dangerLevel: 'safe', available: true,
                    inputHints: { fields: [{ path: 'flower', title: 'Flower', widget: 'text', required: true }] } } },
            }) };
    });
    const publication = createPluginUiProjectionUnionPublication();
    const selectedOrigins = new Map(members.map((member, index) => [pluginIds[index]!,
        member.projection.installedPackagesById[pluginIds[index]!]!.executionOrigin!]));
    let union = publication.publish(members, selectedOrigins).pluginUiProjection;
    if (!union) throw new Error('Action union missing');
    function Wrapper({ children }: React.PropsWithChildren) {
        return React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
            pluginUiProjection: union, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: null, serverId, platform: 'web', accountLifetime: lifetime,
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {}, reloadConnectedAccountProjection() {},
        }, children });
    }
    const mounted = await renderHook(() => useCommandPalettePluginActionPresentation(null, true), { wrapper: Wrapper });
    await flushHookEffects();
    const presentation = mounted.getCurrent();
    expect(presentation).toBeDefined();
    if (!presentation) throw new Error('Home Search must consume the selected Action union');
    const actions = presentation.controller.list({ placement: 'commandPalette', scope: 'global' });
    expect(actions.map(action => action.qualifiedActionId)).toEqual(['qa.flowers/change', 'qa.notes/change']);
    const commands = buildCommandPaletteCommands({ sessionsById: {}, isDev: false, activeSessionId: null,
        features: { executionRunsEnabled: false, voiceEnabled: false },
        nav: { push() {}, openNewSession() {}, navigateToSession() {} }, actions: { execute: async () => ({ ok: true, result: {} }) },
        alert: async () => {}, pluginActionPresentation: presentation });
    expect(commands.filter(command => command.id.startsWith('plugin-action:')).map(command => command.title)).toEqual(['Change 2', 'Change 1']);
    const forms = [];
    for (const [index, action] of actions.entries()) {
        const opened = await presentation.controller.open(action);
        expect(opened.kind).toBe('form');
        if (opened.kind !== 'form') throw new Error('Action form must open');
        expect(opened.form.pickerContext).toMatchObject({ machineId: members[index === 0 ? 2 : 1]!.machineId, serverId });
        forms.push(opened.form);
    }
    // Reading the selected AppShell publication does not fetch a second Machine catalog.
    expect(machineRpc).not.toHaveBeenCalled();
    union = publication.publish(members.map((member, index) => index === 2
        ? { ...member, phase: 'unavailable' as const, interactionEnabled: false } : member), selectedOrigins).pluginUiProjection;
    await mounted.rerender();
    expect(forms[0]!.isRetired()).toBe(true);
    expect(forms[1]!.isRetired()).toBe(false);
    expect(mounted.getCurrent()!.controller.list({ placement: 'commandPalette', scope: 'global' }).map(action => action.qualifiedActionId))
        .toEqual(['qa.notes/change']);
});

it('reads only Agent declarations for a restored producer model and delivers changed Agent facts', async () => {
    const { useAgentModelChoices } = await import('@/components/settings/pickers/useAgentModelChoices');
    const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
    const serverId = await homes.addHome({ name: 'Model Home', serverUrl: 'https://model-projection.test', accountId: 'model-account', currentAccount: true });
    const machineId = 'model-machine';
    let title = 'Original Agent';
    let packageTitle = 'Original package';
    const sections: string[] = [];
    machineRpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {} };
        if (request.method !== RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) throw new Error('Unexpected model transport');
        const projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: { v: 2, generation: 1,
                installedPackagesById: { 'acme.model': { id: 'acme.model', displayName: packageTitle, enabled: true,
                    source: { kind: 'local', locator: '/plugins/model' } } },
                agentsById: { 'acme.model': {
                id: 'acme.model', title, identity: { pluginId: 'acme.model', localId: 'agent' }, channel: 'plugin', isBuiltIn: false,
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
            } } } });
        const snapshot = buildDeferredDaemonProjectionSections({ ...projection,
            projectionDigest: createHash('sha256').update(JSON.stringify(projection)).digest('hex') });
        const read = request.payload.sectionRead;
        if (!read) return snapshot.manifest;
        const response = snapshot.read(read.digest, read.offset, read.includeDigests);
        // A carrier can deliver several sections in the same physical response.
        const deliveredDigests = new Set([read.digest, ...(DaemonProjectionSectionBodyResponseSchema.parse(response).bodies ?? []).map(body => body.digest)]);
        for (const [section, digest] of Object.entries(snapshot.manifest.sections)) {
            if (deliveredDigests.has(digest)) sections.push(section);
        }
        return response;
    });
    const mounted = await renderHook(() => useAgentModelChoices({ value: '', purpose: 'runner', machineId, serverId, observeSelection: true }));
    await vi.waitFor(() => expect(mounted.getCurrent().groups.some(group => group.entry.title === title)).toBe(true));
    const installedAgent = () => mounted.getCurrent().groups.find(group => group.entry.agentId === 'acme.model');
    expect(installedAgent()?.entry.agentCatalogEntry.installedPackage?.displayName).toBe(packageTitle);
    expect([...sections].sort()).toEqual(['agentsById', 'base', 'installedPackagesById'].sort());
    sections.length = 0;
    title = 'Changed Agent';
    await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId }, 'authority'));
    await vi.waitFor(() => expect(mounted.getCurrent().groups.some(group => group.entry.title === title)).toBe(true));
    expect([...sections].sort()).toEqual(['agentsById', 'base'].sort());
    console.info('RESTORED_MODEL_DEMAND', JSON.stringify({ changedSectionReads: sections, consumedTitle: title }));
    sections.length = 0;
    packageTitle = 'Changed package';
    await act(async () => publishMachineContributionRegistryProjectionInvalidation({ machineId, serverId }, 'authority'));
    await vi.waitFor(() => expect(installedAgent()?.entry.agentCatalogEntry.installedPackage?.displayName).toBe(packageTitle));
    expect(installedAgent()?.entry.title).toBe('Changed Agent');
    expect([...sections].sort()).toEqual(['base', 'installedPackagesById'].sort());
    console.info('RESTORED_MODEL_PACKAGE_DEMAND', JSON.stringify({ changedSectionReads: sections, consumedPackageTitle: packageTitle }));
});

it('lists an Account release Action in Home Search without a Machine origin and retires its removed form', async () => {
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { normalizePluginUiProjection } = await import('@/sync/domains/plugins/ui/projection');
    const { buildCommandPaletteCommands } = await import('./buildCommandPaletteCommands');
    const serverId = await homes.addHome({ name: 'Account Search', serverUrl: 'https://palette-account.test', accountId: 'search-account', currentAccount: true });
    storage.setState({ profileScope: { serverId, accountId: 'search-account' }, settingsScope: { serverId, accountId: 'search-account' } });
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: 'https://palette-account.test', generation: 1 });
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Search Account must be current');
    const pluginId = 'qa.account-search';
    const sourceCustody = { kind: 'account_release' as const, pluginId, version: '1.0.0', archiveDigestSha256: `sha256:${'a'.repeat(64)}` };
    const hostAccountOrigin = { serverId, accountId: lifetime.scope.accountId, custodyId: 'account-search-release', sourceCustody };
    const action = { id: 'echo', pluginId, occurrenceId: hostAccountOrigin.custodyId,
        hostAccountOrigin, title: 'Account Search Echo', scopes: ['global'], surfaces: ['ui'], placementBindings: ['commandPalette'],
        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'echo' }, invokingUi: true },
        dangerLevel: 'safe', available: true,
        inputHints: { fields: [{ path: 'message', title: 'Message', widget: 'text', required: true }] },
    } satisfies PluginUiActionProjection;
    let projection = normalizePluginUiProjection({ v: 2, generation: 1,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Account Search', enabled: true, version: '1.0.0',
            source: { kind: 'archive', locator: 'account-search.tgz' }, occurrenceId: hostAccountOrigin.custodyId, sourceCustody } },
        agentsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [], familiesById: {},
        actionsById: { [`${pluginId}/echo`]: action },
    });
    function Wrapper({ children }: React.PropsWithChildren) {
        return React.createElement(AppShellPluginUiProjectionValueProvider, { value: {
            pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true,
            machineId: null, serverId, platform: 'web', accountLifetime: lifetime,
            clientExecutableActivation: { status: 'ready' }, reloadClientExecutables() {}, reloadConnectedAccountProjection() {},
        }, children });
    }
    const mounted = await renderHook(() => useCommandPalettePluginActionPresentation(null, true), { wrapper: Wrapper });
    await flushHookEffects();
    const presentation = mounted.getCurrent();
    if (!presentation) throw new Error('Home Search must consume the Account publication');
    const actions = presentation.controller.list({ placement: 'commandPalette', scope: 'global' });
    expect(actions.map(action => action.qualifiedActionId)).toEqual([`${pluginId}/echo`]);
    const commands = buildCommandPaletteCommands({ sessionsById: {}, isDev: false, activeSessionId: null,
        features: { executionRunsEnabled: false, voiceEnabled: false },
        nav: { push() {}, openNewSession() {}, navigateToSession() {} }, actions: { execute: async () => ({ ok: true, result: {} }) },
        alert: async () => {}, pluginActionPresentation: presentation });
    expect(commands.filter(command => command.id.startsWith('plugin-action:')).map(command => command.title)).toEqual(['Account Search Echo']);
    const opened = await presentation.controller.open(actions[0]!);
    expect(opened.kind).toBe('form');
    if (opened.kind !== 'form') throw new Error('Account Action form must open');
    expect(opened.form.pickerContext).toMatchObject({ machineId: null, serverId });
    expect(machineRpc).not.toHaveBeenCalled();
    projection = { ...projection, actionsById: {} };
    await mounted.rerender();
    expect(opened.form.isRetired()).toBe(true);
    expect(mounted.getCurrent()!.controller.list({ placement: 'commandPalette', scope: 'global' })).toHaveLength(0);
});

beforeEach(async () => {
    await homes.reset();
    clearDaemonMergedProjectionCacheForTests();
    machineRpc.mockReset();
});

afterEach(async () => {
    standardCleanup();
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(storage.getInitialState(), true);
    await homes.reset();
});

it('keeps a routed Session Action form on its Home through focused Account rotation, then retires it with its own credentials', async () => {
    const focusedHome = await homes.addHome({ name: 'Focused A', serverUrl: 'https://palette-focused.test', accountId: 'account-a' });
    const routedHome = await homes.addHome({ name: 'Session B', serverUrl: 'https://palette-routed.test', accountId: 'account-b', active: false });
    storage.setState({ profileScope: { serverId: focusedHome, accountId: 'account-a' } });
    publishAppliedActiveServerSnapshot({ serverId: focusedHome, serverUrl: 'https://palette-focused.test', generation: 1 });
    const focusedLifetime = captureActiveServerAccountScopeLifetime();
    expect(focusedLifetime?.scope.accountId).toBe('account-a');
    const machine = createHydratedPlainMachineFixture({ id: 'palette-machine-b', accountId: 'account-b',
        machine: { active: true, activeAt: Date.now(), isShared: false } });
    const session = createSessionFixture({ id: 'palette-session-b', serverId: routedHome, active: true,
        metadata: { machineId: machine.id, path: '/workspace/b', host: 'machine-b' } });
    storage.setState({ sessions: { [session.id]: session },
        machineListByServerId: { [routedHome]: [machine] }, machineListStatusByServerId: { [routedHome]: 'idle' } });
    let projection = DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
        projection: { v: 2, generation: 13,
            installedPackagesById: { 'acme.palette': { id: 'acme.palette', displayName: 'Palette', enabled: true,
                source: { kind: 'local', locator: '/plugins/palette' } } },
            actionsById: { 'acme.palette/review': { id: 'review', pluginId: 'acme.palette', occurrenceId: 'review-b',
                title: 'Review B', scopes: ['session'], surfaces: ['ui'], placementBindings: ['commandPalette'],
                dangerLevel: 'safe', execution: { target: 'daemon' }, available: true,
                inputHints: { title: 'Review B', submitLabel: 'Review', fields: [{ path: 'reason', title: 'Reason', widget: 'textarea', required: true }] } } },
        } });
    const demandedSections = ['actionsById', 'familiesById.pluginUi', 'familiesById.inputTypes', 'resourcesById'];
    const sectionReads: string[] = [];
    let manifests = 0;
    machineRpc.mockImplementation(async request => {
        if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
            const snapshot = buildDeferredDaemonProjectionSections({ ...projection,
                projectionDigest: createHash('sha256').update(JSON.stringify(projection)).digest('hex') });
            const read = request.payload.sectionRead;
            if (read) {
                const response = snapshot.read(read.digest, read.offset, read.includeDigests);
                const deliveredDigests = new Set([read.digest, ...(DaemonProjectionSectionBodyResponseSchema.parse(response).bodies ?? []).map(body => body.digest)]);
                for (const [section, digest] of Object.entries(snapshot.manifest.sections)) {
                    if (deliveredDigests.has(digest)) sectionReads.push(section);
                }
                return response;
            }
            manifests += 1;
            return snapshot.manifest;
        }
        throw new Error(`Unexpected palette machine method: ${request.method}`);
    });
    const rendered = await renderHook(({ presented }) => useCommandPalettePluginActionPresentation(session.id, presented),
        { initialProps: { presented: false } });
    await flushHookEffects();
    expect(machineRpc).not.toHaveBeenCalled();
    await rendered.rerender({ presented: true });
    await vi.waitFor(() => expect(rendered.getCurrent()?.controller.list({ placement: 'commandPalette', scope: 'session' })).toHaveLength(1));
    expect([...sectionReads].sort()).toEqual(['base', 'installedPackagesById', 'actionsById', 'resourcesById'].sort());
    expect(manifests).toBe(1);
    console.info('PALETTE_COLD_SECTIONS', JSON.stringify({ manifests, sectionReads }));
    expect(machineRpc).toHaveBeenCalledWith(expect.objectContaining({
        machineId: machine.id, serverId: routedHome, accountId: 'account-b',
        method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
    }));
    const bindings = await renderHook(() => useServerCredentialAccountScopeBindings([routedHome]));
    await flushHookEffects();
    const lifetime = bindings.getCurrent().values().next().value;
    if (!lifetime) throw new Error('Routed credentials must have a live Account binding');
    const publish = async (next: typeof projection) => {
        projection = next;
        await act(async () => { await loadDaemonMergedProjectionInputs({ machineId: machine.id,
            serverId: routedHome, accountLifetime: lifetime, staleMs: 0, sections: demandedSections }); });
        await flushHookEffects();
    };
    const noise = (arrival: number) => DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
        ...projection, projection: { ...projection.projection, generation: 13 + arrival,
            agentsById: { review: { id: 'review', title: `Unrelated Agent ${arrival}`,
                identity: { pluginId: 'acme.agent', localId: 'review' },
                capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } },
        },
    });
    const presentation = rendered.getCurrent()!;
    const action = presentation.controller.list({ placement: 'commandPalette', scope: 'session' })[0]!;
    const opened = await presentation.controller.open(action);
    expect(opened.kind).toBe('form');
    if (opened.kind !== 'form') throw new Error('Expected the routed Action form');
    let form = opened.form;
    form.replaceInput({ reason: 'Private draft for B' });
    for (let arrival = 1; arrival <= 20; arrival++) await publish(noise(arrival));
    expect(form.isRetired()).toBe(false);
    expect(form.getInput()).toEqual({ reason: 'Private draft for B' });
    expect(form.pickerContext).toMatchObject({ serverId: routedHome, machineId: machine.id, sessionId: session.id });
    const openCurrent = async () => {
        const current = rendered.getCurrent()!;
        const action = current.controller.list({ placement: 'commandPalette', scope: 'session' })[0]!;
        const next = await current.controller.open(action);
        if (next.kind !== 'form') throw new Error('Current Action must open its form');
        next.form.replaceInput({ reason: 'Private draft for B' });
        return next.form;
    };
    sectionReads.length = 0;
    await publish(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projection,
        projection: { ...projection.projection, actionsById: { 'acme.palette/review': {
            ...projection.projection.actionsById['acme.palette/review']!, title: 'Edited review',
        } } },
    }));
    expect([...sectionReads].sort()).toEqual(['base', 'actionsById'].sort());
    expect(rendered.getCurrent()!.controller.list({ placement: 'commandPalette', scope: 'session' })[0]?.title).toBe('Edited review');
    console.info('PALETTE_CHANGED_SECTIONS', JSON.stringify({ sectionReads, title: 'Edited review' }));
    expect(form.isRetired()).toBe(true);
    form = await openCurrent();
    await publish(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projection,
        projection: { ...projection.projection, installedPackagesById: { 'acme.palette': {
            ...projection.projection.installedPackagesById['acme.palette']!, enabled: false,
        } } },
    }));
    expect(form.isRetired()).toBe(true);
    expect(rendered.getCurrent()!.controller.list({ placement: 'commandPalette', scope: 'session' })).toHaveLength(0);
    await publish(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projection,
        projection: { ...projection.projection, installedPackagesById: { 'acme.palette': {
            ...projection.projection.installedPackagesById['acme.palette']!, enabled: true,
        } } },
    }));
    form = await openCurrent();
    await publish(DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ ...projection,
        projection: { ...projection.projection, actionsById: { 'acme.palette/review': {
            ...projection.projection.actionsById['acme.palette/review']!, occurrenceId: 'review-replacement',
        } } },
    }));
    expect(form.isRetired()).toBe(true);
    form = await openCurrent();

    // Focus observation retirement is part of A's rotation, not B's credential lifetime.
    await act(async () => {
        publishAppliedActiveServerRuntimeAvailability(false);
        await homes.switchAccount(focusedHome, 'account-a-next');
    });
    expect(focusedLifetime?.isCurrent()).toBe(false);
    await rendered.rerender();
    await flushHookEffects();
    expect(form.isRetired()).toBe(false);
    expect(form.getInput()).toEqual({ reason: 'Private draft for B' });
    expect(presentation.signal.aborted).toBe(false);

    await act(async () => { await homes.switchAccount(routedHome, 'account-b-next'); });
    await flushHookEffects();
    expect(form.isRetired()).toBe(true);
    expect(form.getInput()).toEqual({});
    expect(presentation.signal.aborted).toBe(true);
});
