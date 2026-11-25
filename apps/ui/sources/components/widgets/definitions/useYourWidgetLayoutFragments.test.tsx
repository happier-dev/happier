import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { buildHomeHubArtifactIdV1 } from '@happier-dev/protocol/home/homeHubArtifactV1';
import { instantiateWidgetLayoutFragmentGroupV1, WidgetLayoutFragmentDraftV1Schema, WidgetSurfaceReadV1Schema, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import * as uuidBoundary from '@/platform/randomUUID';
import { Pressable } from 'react-native';
import { widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { t } from '@/text';

const modalBoundary = vi.hoisted(() => ({ prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: modalBoundary }).module);
// Only window/portal presentation is replaced; Gallery rows, commands, policy and Artifact CAS stay real.
vi.mock('@/components/ui/popover', async (importOriginal) =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useWidgetGroupKeepFlows } = await import('../group/useWidgetGroupKeepFlows');
const { WidgetFlowPanel } = await import('../flow/WidgetFlowPanel');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const { renderScreen } = await import('@/dev/testkit/render/renderScreen');
const { flushHookEffects } = await import('@/dev/testkit/hooks/flushHookEffects');
const { useAccountWidgetAddSections } = await import('../add/accountWidgetAddSections');
const { WidgetAddPanel } = await import('../add/WidgetAddSurface');
const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
const { act } = await import('react-test-renderer');
const { renderHook } = await import('@/dev/testkit');
const { filterWidgetAddSections } = await import('../add/widgetAddModel');

const ACCOUNT_ID = 'account-a';
const DRAFT = WidgetLayoutFragmentDraftV1Schema.parse({ name: 'Release checks', inputs: { fields: [] }, inputSchema: { type: 'object' },
    group: { width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget',
        instance: { v: 1, definition: { kind: 'builtin', id: 'summary' }, bindings: {} } }] } });
const DESTINATION_PERIOD = { relative: '30days' } as const;
const PERIOD_WIDGET_ID = '22222222-2222-4222-8222-222222222231';
const PERIOD_INPUTS = { fields: [{ path: 'location', title: 'Location', widget: 'text' as const },
    { path: 'period', title: 'Period', widget: 'json' as const, required: true }] };
const PERIOD_SCHEMA = { type: 'object' as const,
    properties: { location: { type: 'string' as const }, period: { type: 'object' as const } }, required: ['period'] };
const PERIOD_GROUP = WidgetLayoutFragmentDraftV1Schema.parse({
    name: 'Period from destination', inputs: PERIOD_INPUTS, inputSchema: PERIOD_SCHEMA,
    group: { width: 'full', frameStyle: 'card', dividers: 'hairline',
        context: { location: { kind: 'value', value: '/qa/gallery-location' } },
        children: [{ kind: 'widget', instance: { v: 1, definition: { kind: 'artifact', artifactId: PERIOD_WIDGET_ID },
            bindings: { location: { kind: 'context', slot: 'location' }, period: { kind: 'context', slot: 'period' } } } }],
    },
});
const NO_INSTANCES = Object.freeze([]);
const LABELS = { count: String, submit: 'Add' };
const addInstance = async () => ({ ok: true as const });
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let previousSettings: ReturnType<typeof storage.getState>['settings'] | null = null;
let restoreUuid: (() => void) | null = null;

/** Preserve the real boundary's filtered/unfiltered wire shapes while controlling read timing. */
function answerArtifactInventory(serverId: string, respondAfter?: Promise<void>) {
    harness.answer(serverId, 'GET /v1/artifacts', { select: async (_input, request) => {
        const url = new URL(request.url);
        const inventory = await harness.artifacts(serverId).handle(`${url.pathname}${url.search}`, request.init);
        if (!inventory) throw new Error('Expected the canonical Artifact inventory boundary');
        return { body: await inventory.json(), ...(respondAfter ? { respondAfter } : {}) };
    } });
}

async function renderGallery(options: Readonly<{
    waiveManagementApproval?: boolean;
    usage?: Readonly<{ periodAvailable: boolean }>;
    fieldlessHome?: boolean;
}> = {}) {
    const serverId = await harness.addHome({ name: 'Home A', serverUrl: 'https://fragments-home.example', accountId: ACCOUNT_ID });
    const account = { serverId, accountId: ACCOUNT_ID };
    storage.setState({ profileScope: account, settingsScope: account });
    harness.answer(serverId, '/v1/auth/ping', { body: { success: true } });
    harness.answer(serverId, '/v1/account/encryption/currentness', {
        body: { mode: 'plain', version: 0, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 },
    });
    // Match app entry: publish real Sync before restoring the active Account lifetime.
    connection = await restoreServerAccountForTest({ serverUrl: 'https://fragments-home.example', accountId: ACCOUNT_ID, request: harness.request });
    installHomeGovernanceBoundaries(harness);
    storage.setState({ profileScope: account, settingsScope: account });
    previousSettings = storage.getState().settings;
    if (options.waiveManagementApproval !== false) {
        // Persisted Account policy, not an executor bypass: success cases opt out of default Ask.
        const settings = { ...previousSettings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
            v: 1, actions: {}, approvalWaivedSurfaces: {
                'widgets.fragment.update': ['ui'], 'widgets.fragment.delete': ['ui'], 'widgets.group.add': ['ui', 'agent'],
            },
        }) };
        storage.setState({ settings });
        harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    }
    expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual(account);
    const executor = createDefaultActionExecutor();
    const context = { serverId, surface: 'ui', authority: 'present_user' } as const;
    if (options.usage) {
        expect(await executor.execute('widgets.definition.create', { account, artifactId: PERIOD_WIDGET_ID,
            definition: { name: 'Period witness', inputs: PERIOD_INPUTS, inputSchema: PERIOD_SCHEMA,
                sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
                body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Period preview rendered' } } } },
        }, context)).toMatchObject({ ok: true });
    }
    const fragment = options.usage ? PERIOD_GROUP : options.fieldlessHome
        ? { ...DRAFT, group: { ...DRAFT.group, children: [{ kind: 'widget' as const,
            instance: { v: 1 as const, definition: { kind: 'builtin' as const, id: 'your_home' }, bindings: {} } }] } }
        : DRAFT;
    expect(await executor.execute('widgets.fragment.create', { account, artifactId: 'saved', fragment }, context)).toMatchObject({ ok: true });
    const scope: WidgetSurfaceRefV1 = { ...account, owner: options.usage
        ? { kind: 'corePage', pageId: 'usage', area: 'main', layoutId: 'overview' }
        : { kind: 'home' } };
    const destinationContext: WidgetSurfaceContext = options.usage?.periodAvailable
        ? { slots: { period: { label: 'This page', value: { value: DESTINATION_PERIOD, label: 'Last 30 days' } } } }
        : {};
    function Gallery() {
        const { sections, pendingSections } = useAccountWidgetAddSections({ scope, context: destinationContext,
            instances: NO_INSTANCES, labels: LABELS, addInstance, testID: 'gallery' });
        return <WidgetAddPanel title="Add" searchPlaceholder="Search" addLabel="Add" composition="split"
            sections={sections} pendingSections={pendingSections} onRequestClose={() => {}} testID="gallery" />;
    }
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{
        pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current', interactionEnabled: false, machineId: null,
        serverId, platform: 'web', reloadConnectedAccountProjection: () => {}, accountLifetime: captureActiveServerAccountScopeLifetime(),
        clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
    }}><Gallery /></AppShellPluginUiProjectionValueProvider>);
    await act(async () => { await flushHookEffects({ cycles: 2 }); });
    await vi.waitFor(() => expect(screen.findByTestId('gallery.entry.group-saved')).not.toBeNull());
    async function choose(action: string) {
        await screen.pressByTestIdAsync('gallery.entry.group-saved.actions');
        await screen.pressByTestIdAsync(action);
        await flushHookEffects({ cycles: 2 });
    }
    return { screen, choose, account, executor, context, serverId, scope, destinationContext };
}

describe('saved-group Gallery management', () => {
    beforeEach(async () => { await harness.reset(); modalBoundary.prompt.mockReset(); modalBoundary.confirm.mockReset(); modalBoundary.alert.mockReset(); });
    afterEach(async () => {
        standardCleanup();
        retirePresentationNotice();
        restoreUuid?.();
        restoreUuid = null;
        if (connection) { await connection.dispose(); connection = null; installHomeGovernanceBoundaries(harness); }
        if (previousSettings) { storage.setState({ settings: previousSettings }); previousSettings = null; }
    });

    it.each([503, null])('can add a fieldless Home group after its review read returns %s', async (failureStatus) => {
        const { screen, account, scope, executor, context } = await renderGallery({ fieldlessHome: true });
        const layoutPath = '/v1/artifacts/' + buildHomeHubArtifactIdV1(account.accountId);
        let failRead = failureStatus !== null;
        let readFailed = false;
        if (failureStatus !== null) {
            harness.answer(account.serverId, `GET ${layoutPath}`, { select: async (_input, request) => {
                if (failRead) {
                    readFailed = true;
                    return { status: failureStatus, body: {} };
                }
                const response = await harness.artifacts(account.serverId).handle(layoutPath, request.init);
                if (!response) throw new Error('Expected the Home layout Artifact read');
                return { status: response.status, body: await response.json() };
            } });
        }
        await screen.pressByTestIdAsync('gallery.entry.group-saved');
        await waitForHomeGovernance(() => {
            if (failureStatus !== null) expect(readFailed).toBe(true);
            const note = screen.findByTestId('gallery.detail.why');
            expect(note).not.toBeNull();
            expect(note?.props.children).not.toBe(t('common.loading'));
        });
        expect(screen.findByTestId('gallery.detail.submit')?.props.disabled).toBe(false);
        expect(screen.getTextContent()).not.toContain(t('widgetAdd.addFailed'));
        failRead = false;
        await screen.pressByTestIdAsync('gallery.detail.submit');
        await waitForHomeGovernance(async () => expect(await executor.execute('widgets.item.list', { surface: scope }, context)).toMatchObject({
            ok: true, result: { items: expect.arrayContaining([expect.objectContaining({ kind: 'group', title: DRAFT.name })]) },
        }));
    });

    it('adds the saved group that previews a required Period supplied by the Usage destination', async () => {
        const { screen, scope, executor, context, destinationContext } = await renderGallery({ usage: { periodAvailable: true } });
        await screen.pressByTestIdAsync('gallery.entry.group-saved');
        await vi.waitFor(() => expect(screen.findByTestId('gallery.detail.submit')?.props.disabled).toBe(false));
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Period preview rendered'));
        const before = await executor.execute('widgets.item.list', { surface: scope }, context);
        expect(before.ok).toBe(true);
        expect(before.ok && WidgetSurfaceReadV1Schema.parse(before.result).items?.some(item =>
            item.kind === 'group' && item.title === PERIOD_GROUP.name)).toBe(false);
        await screen.pressByTestIdAsync('gallery.detail.submit');

        await vi.waitFor(async () => {
            expect(await executor.execute('widgets.item.list', { surface: scope }, context), screen.getTextContent()).toMatchObject({
                ok: true, result: { items: expect.arrayContaining([expect.objectContaining({
                    kind: 'group', title: PERIOD_GROUP.name, context: PERIOD_GROUP.group.context,
                    children: [expect.objectContaining({ instance: expect.objectContaining({
                        bindings: PERIOD_GROUP.group.children[0]!.instance.bindings,
                    }) })],
                })]) },
            });
        });
        const listed = await executor.execute('widgets.item.list', { surface: scope }, context);
        expect(listed.ok).toBe(true);
        const placed = listed.ok && WidgetSurfaceReadV1Schema.parse(listed.result).items?.find(item => item.kind === 'group' && item.title === PERIOD_GROUP.name);
        if (!placed || placed.kind !== 'group') throw new Error('Expected the placed group in the typed inventory');
        const { instance } = placed.children[0]!;
        expect(await executor.execute('widgets.item.inputs.validate', {
            ref: { surface: scope, instanceId: instance.id }, bindings: instance.bindings,
        }, { ...context, widgetAreaContext: { surface: scope, values: widgetProvidedContext(destinationContext) } })).toMatchObject({
            ok: true, result: { status: 'ready', input: { period: DESTINATION_PERIOD } },
        });
    });

    it.each([true, false])('agrees with agent placement when the destination Period is available: %s', async periodAvailable => {
        const { screen, scope, executor, context, destinationContext } = await renderGallery({ usage: { periodAvailable } });
        await screen.pressByTestIdAsync('gallery.entry.group-saved');
        if (periodAvailable) {
            await vi.waitFor(() => expect(screen.findByTestId('gallery.detail.submit')?.props.disabled).toBe(false));
        } else {
            await vi.waitFor(() => expect(screen.getTextContent()).toContain('Period is still needed'));
            expect(screen.findByTestId('gallery.detail.submit')?.props.disabled).toBe(true);
            expect(screen.getTextContent()).not.toContain('Period preview rendered');
        }

        const group = instantiateWidgetLayoutFragmentGroupV1(PERIOD_GROUP.group, { groupId: 'agent-group', childIds: ['agent-child'] });
        const result = await executor.execute('widgets.group.add', { surface: scope, group }, {
            ...context, surface: 'agent', authority: 'account_automation',
            widgetAreaContext: { surface: scope, values: widgetProvidedContext(destinationContext) },
        });
        if (periodAvailable) {
            expect(result).toMatchObject({ ok: true, result: { item: { kind: 'group', id: 'agent-group' } } });
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'widget_inputs_invalid', details: {
                status: 'selection_required', fields: [expect.objectContaining({ path: 'period' })],
            } });
        }
        const listed = await executor.execute('widgets.item.list', { surface: scope }, context);
        expect(listed.ok).toBe(true);
        expect(listed.ok && WidgetSurfaceReadV1Schema.parse(listed.result).items?.some(item => item.kind === 'group' && item.id === group.id)).toBe(periodAvailable);
    });

    it('publishes local search results independently of pending saved widgets and groups', async () => {
        const { account, screen, serverId } = await renderGallery();
        await screen.unmount();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        answerArtifactInventory(serverId, held);
        const scope = { ...account, owner: { kind: 'home' } } as const;
        const hook = await renderHook(() => useAccountWidgetAddSections({ scope, instances: NO_INSTANCES,
            labels: LABELS, addInstance, testID: 'pending-gallery' }));
        try {
            expect(hook.getCurrent().sections.some(section => section.id.startsWith('builtins') && section.entries.length > 0)).toBe(true);
            expect(filterWidgetAddSections(hook.getCurrent().sections, 'no-widget-matches-this')).toEqual([]);
            expect(hook.getCurrent().pendingSections).toEqual([{ id: 'yours', title: expect.any(String) }]);
            await act(async () => { release(); await flushHookEffects({ cycles: 2 }); });
            await vi.waitFor(() => expect(hook.getCurrent().pendingSections).toEqual([]));
        } finally {
            release();
            await hook.unmount();
        }
    });

    it('settles a refused Account inventory as a retryable section and reads again, never staying on Loading', async () => {
        const { account, screen, serverId } = await renderGallery();
        await screen.unmount();
        harness.answer(serverId, 'GET /v1/artifacts', { status: 403, body: { error: 'forbidden' } });
        const scope = { ...account, owner: { kind: 'home' } } as const;
        const hook = await renderHook(() => useAccountWidgetAddSections({ scope, instances: NO_INSTANCES,
            labels: LABELS, addInstance, testID: 'refused-gallery' }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().pendingSections).toEqual([{ id: 'yours', title: expect.any(String), retry: expect.any(Function) }]));
            // Everything that is not the Account's own read stays searchable meanwhile.
            expect(hook.getCurrent().sections.some(section => section.id.startsWith('builtins') && section.entries.length > 0)).toBe(true);
            answerArtifactInventory(serverId);
            await act(async () => { hook.getCurrent().pendingSections[0]!.retry!(); await flushHookEffects({ cycles: 2 }); });
            await vi.waitFor(() => expect(hook.getCurrent().pendingSections).toEqual([]));
        } finally { await hook.unmount(); }
    });

    it('ends Save group on a failed platform operation and lets Retry save through the real Artifact Action without a daemon', async () => {
        const { account, serverId } = await renderGallery();
        const group = instantiateWidgetLayoutFragmentGroupV1(DRAFT.group, { groupId: 'source-group', childIds: ['source-widget'] });
        function KeepGroup() {
            const flow = useWidgetGroupKeepFlows({ group, name: 'L3 terminal save',
                scope: { ...account, owner: { kind: 'home' } }, candidates: [], anchorRef: React.useRef(null), testID: 'terminal-save' });
            return <><Pressable testID="terminal-save.open" onPress={flow.onSave} />{flow.overlay}</>;
        }
        const screen = await renderScreen(<KeepGroup />);
        await screen.pressByTestIdAsync('terminal-save.open');
        // UUID allocation is an OS/platform boundary; the command, Action policy and Artifact writer stay real.
        const uuid = vi.spyOn(uuidBoundary, 'randomUUID').mockImplementationOnce(() => { throw new Error('Platform UUID unavailable'); });
        restoreUuid = () => uuid.mockRestore();
        await screen.pressByTestIdAsync('terminal-save.saveGroup.panel.submit');
        await flushHookEffects({ cycles: 2 });
        expect(screen.tree.root.findByType(WidgetFlowPanel).props.primary).toMatchObject({ busy: false, label: 'Retry' });
        expect(screen.findByTestId('terminal-save.saveGroup.panel')).not.toBeNull();
        await screen.pressByTestIdAsync('terminal-save.saveGroup.panel.submit');
        await vi.waitFor(() => expect(screen.findByTestId('terminal-save.saveGroup.panel')).toBeNull());
        expect(harness.artifacts(serverId).list().some(row => harness.artifacts(serverId).readPlainBody(row.id)?.includes('L3 terminal save'))).toBe(true);
    });

    it('reports a failed Duplicate preparation and lets the same Gallery action retry', async () => {
        const { choose, serverId } = await renderGallery();
        const uuid = vi.spyOn(uuidBoundary, 'randomUUID').mockImplementationOnce(() => { throw new Error('Platform UUID unavailable'); });
        restoreUuid = () => uuid.mockRestore();
        await choose('duplicate');
        await vi.waitFor(() => expect(modalBoundary.alert).toHaveBeenCalled());
        expect(modalBoundary.alert.mock.calls.at(-1)?.[0]).toBe('Error');
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
        await choose('duplicate');
        await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
    });

    it('retries Save group after a lost acknowledgement without creating another saved group', async () => {
        const { account, serverId } = await renderGallery();
        const group = instantiateWidgetLayoutFragmentGroupV1(DRAFT.group, { groupId: 'source-group', childIds: ['source-widget'] });
        function KeepGroup() {
            const flow = useWidgetGroupKeepFlows({ group, name: 'Release checks',
                scope: { ...account, owner: { kind: 'home' } }, candidates: [], anchorRef: React.useRef(null), testID: 'lost-save' });
            return <><Pressable testID="lost-save.open" onPress={flow.onSave} />{flow.overlay}</>;
        }
        const screen = await renderScreen(<KeepGroup />);
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        let readsUnavailable = false;
        setRuntimeFetch((input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            return readsUnavailable && new URL(url).pathname.startsWith('/v1/artifacts/')
                ? Promise.resolve(new Response('{}', { status: 503 })) : harness.request(input, init);
        });
        harness.artifacts(serverId).afterNextCreate(async () => {
            readsUnavailable = true;
            throw new TypeError('Connection lost after fragment commit');
        });
        await screen.pressByTestIdAsync('lost-save.open');
        await screen.pressByTestIdAsync('lost-save.saveGroup.panel.submit');
        await vi.waitFor(() => expect(screen.tree.root.findByType(WidgetFlowPanel).props.primary,
            JSON.stringify({ artifacts: harness.artifacts(serverId).list().map(row => row.id), requests: harness.requests.map(row => row.path) }))
            .toMatchObject({ busy: false, label: 'Retry' }), { timeout: 8000 });
        expect(harness.artifacts(serverId).list()).toHaveLength(2);
        const savedId = harness.artifacts(serverId).list().find(row => row.id !== 'saved')!.id;
        readsUnavailable = false;
        await screen.pressByTestIdAsync('lost-save.saveGroup.panel.submit');
        await vi.waitFor(() => expect(screen.findByTestId('lost-save.saveGroup.panel')).toBeNull());
        expect(harness.artifacts(serverId).list().map(row => row.id)).toEqual(['saved', savedId]);
        await screen.pressByTestIdAsync('lost-save.open');
        await screen.pressByTestIdAsync('lost-save.saveGroup.panel.submit');
        await vi.waitFor(() => expect(screen.findByTestId('lost-save.saveGroup.panel')).toBeNull());
        expect(harness.artifacts(serverId).list()).toHaveLength(3);
    });

    it('retries Duplicate after a lost acknowledgement and starts a new copy only after success', async () => {
        const { choose, screen, serverId } = await renderGallery();
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        let readsUnavailable = false;
        setRuntimeFetch((input, init) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            return readsUnavailable && new URL(url).pathname.startsWith('/v1/artifacts/')
                ? Promise.resolve(new Response('{}', { status: 503 })) : harness.request(input, init);
        });
        harness.artifacts(serverId).afterNextCreate(async () => {
            readsUnavailable = true;
            throw new TypeError('Connection lost after fragment duplicate commit');
        });
        await choose('duplicate');
        await vi.waitFor(() => expect(modalBoundary.alert,
            JSON.stringify({ artifacts: harness.artifacts(serverId).list().map(row => row.id), requests: harness.requests.map(row => row.path) }))
            .toHaveBeenCalled(), { timeout: 8000 });
        expect(harness.artifacts(serverId).list()).toHaveLength(2);
        const copiedId = harness.artifacts(serverId).list().find(row => row.id !== 'saved')!.id;
        readsUnavailable = false;
        await choose('duplicate');
        await vi.waitFor(() => expect(screen.findByTestId(`gallery.entry.group-${copiedId}`)).not.toBeNull());
        expect(harness.artifacts(serverId).list().map(row => row.id)).toEqual(['saved', copiedId]);
        await choose('duplicate');
        await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(3));
    });

    it('reports a failed Add-to preparation after closing the chooser and lets a reopened chooser retry', async () => {
        const { account, serverId } = await renderGallery();
        const group = instantiateWidgetLayoutFragmentGroupV1({ ...DRAFT.group, children: [{ kind: 'widget',
            instance: { v: 1, definition: { kind: 'builtin', id: 'your_home' }, bindings: {} } }] },
        { groupId: 'source-group', childIds: ['source-widget'] });
        function CopyGroup() {
            const flow = useWidgetGroupKeepFlows({ group, name: DRAFT.name,
                scope: { ...account, owner: { kind: 'project', projectId: 'source-project' } }, candidates: [],
                anchorRef: React.useRef(null), testID: 'terminal-copy' });
            return <><Pressable testID="terminal-copy.open" onPress={flow.onAddTo} />{flow.overlay}</>;
        }
        const screen = await renderScreen(<CopyGroup />);
        await screen.pressByTestIdAsync('terminal-copy.open');
        const uuid = vi.spyOn(uuidBoundary, 'randomUUID').mockImplementationOnce(() => { throw new Error('Platform UUID unavailable'); });
        restoreUuid = () => uuid.mockRestore();
        await screen.pressByTestIdAsync('terminal-copy.addTo.home');
        await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ key: 'widget-group-copy:source-group', severity: 'error' }));
        expect(screen.findByTestId('terminal-copy.addTo.home')).toBeNull();
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
        await screen.pressByTestIdAsync('terminal-copy.open');
        await screen.pressByTestIdAsync('terminal-copy.addTo.home');
        await vi.waitFor(() => expect(readPresentationNotice()).toMatchObject({ key: 'widget-group-copy:source-group', severity: 'info' }));
        const layout = await createDefaultActionExecutor().execute('home.hub.layout.get', {}, { serverId, surface: 'ui', authority: 'present_user' });
        expect(layout).toMatchObject({ ok: true, result: { layout: { items: expect.arrayContaining([
            expect.objectContaining({ kind: 'group', children: [expect.objectContaining({ instance: expect.objectContaining({ definition: group.children[0]!.instance.definition }) })] }),
        ]) } } });
    });

    it('opens Rename from the listed name even when the Artifact read has not answered', async () => {
        const { choose, serverId } = await renderGallery();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        harness.answer(serverId, 'GET /v1/artifacts/saved', { respondAfter: held, body: {} });
        modalBoundary.prompt.mockResolvedValue(null);
        try {
            await choose('rename');
            expect(modalBoundary.prompt).toHaveBeenCalledWith(expect.any(String), undefined,
                expect.objectContaining({ defaultValue: DRAFT.name }));
        } finally { release(); }
    });

    it('shows the submitted name while saving and restores the row with an error on refusal', async () => {
        const { screen, choose, serverId } = await renderGallery();
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        harness.answer(serverId, 'POST /v1/artifacts/saved', { respondAfter: held, status: 403, body: { error: 'forbidden' } });
        modalBoundary.prompt.mockResolvedValue('Release room');
        try {
            await choose('rename');
            await vi.waitFor(() => expect(harness.requestsFor('/v1/artifacts/saved').some(request =>
                !!request.input && typeof request.input === 'object' && 'body' in request.input)).toBe(true));
            expect(screen.getTextContent()).toContain('Release room');
        } finally { release(); }
        await vi.waitFor(() => expect(modalBoundary.alert).toHaveBeenCalled());
        expect(screen.getTextContent()).toContain(DRAFT.name);
        expect(screen.getTextContent()).not.toContain('Release room');
    });

    it('explains a Home that cannot be reached before Rename can save', async () => {
        const { screen, choose, serverId } = await renderGallery();
        const scope = { serverId, accountId: ACCOUNT_ID };
        const { getPersistenceStorage } = await import('@/sync/domains/state/persistenceStorage');
        const { accountSettingsScopeKeySuffix } = await import('@/sync/domains/settings/scope/accountSettingsScope');
        const { loadAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        getPersistenceStorage().delete(`account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`);
        storage.setState({ settingsScope: null });
        expect(loadAccountSettings(scope).version).toBeNull();
        harness.answer(serverId, '/v2/account/settings', { dispatchThenFail: true });
        modalBoundary.prompt.mockResolvedValue('Release room');
        await choose('rename');
        const { t } = await import('@/text');
        await vi.waitFor(() => expect(modalBoundary.alert).toHaveBeenCalledWith(t('common.error'),
            t('settingsPlugins.targetSelection.unreachableThisHome')));
        expect(screen.getTextContent()).toContain(DRAFT.name);
        expect(screen.getTextContent()).not.toContain('Release room');
    });
    it('renames the saved group through current Artifact revisions, duplicates independently, and refreshes after delete', async () => {
        const { screen, choose, account, executor, context, serverId } = await renderGallery();
        expect(screen.findByTestId('gallery.detail.submit')?.props.disabled).toBe(true);
        modalBoundary.prompt.mockResolvedValue('  Release room  ');
        // Another writer changes an unrelated field at the real CAS boundary before Rename commits.
        harness.artifacts(serverId).beforeNextUpdate(async () => {
            expect(await executor.execute('widgets.fragment.update', { account, artifactId: 'saved', patch: { description: 'Kept by another client' } }, context)).toMatchObject({ ok: true });
        });
        await choose('rename');
        await vi.waitFor(async () => {
            const renamed = await executor.execute('widgets.fragment.get', { account, artifactId: 'saved' }, context);
            expect(renamed).toMatchObject({ ok: true, result: { fragment: { name: 'Release room', description: 'Kept by another client', group: DRAFT.group } } });
        });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Release room'));
        // The prompt shows the name once, as the field's value; its message line does not repeat it.
        expect(modalBoundary.prompt).toHaveBeenCalledWith(expect.any(String), undefined, expect.objectContaining({ defaultValue: expect.any(String) }));
        expect(screen.findByTestId('gallery.detail.submit')?.props.disabled).toBe(true);
        await choose('duplicate');
        await vi.waitFor(() => expect(harness.artifacts(serverId).list()).toHaveLength(2));
        const copyId = harness.artifacts(serverId).list().find(row => row.id !== 'saved')!.id;
        await vi.waitFor(() => expect(screen.findByTestId(`gallery.entry.group-${copyId}`)).not.toBeNull());
        expect(await executor.execute('widgets.fragment.get', { account, artifactId: copyId }, context)).toMatchObject({ ok: true, result: { fragment: { id: copyId, group: DRAFT.group } } });
        await choose('delete');
        await vi.waitFor(() => expect(screen.findByTestId('gallery.entry.group-saved')).toBeNull());
        expect(harness.artifacts(serverId).read('saved')).toBeNull();
        expect(harness.artifacts(serverId).read(copyId)).not.toBeNull();
    });

    it('cancels naming without a write and retains management controls after refusal', async () => {
        const { screen, choose, serverId } = await renderGallery();
        const original = harness.artifacts(serverId).readPlainBody('saved');
        modalBoundary.prompt.mockResolvedValue(null);
        await choose('rename');
        await vi.waitFor(() => expect(modalBoundary.prompt).toHaveBeenCalled());
        await flushHookEffects({ cycles: 2 });
        expect(harness.artifacts(serverId).readPlainBody('saved')).toBe(original);
        modalBoundary.prompt.mockResolvedValue('Release room');
        // A terminal Home refusal, not a transient 503 serviced by the transport's retry owner.
        harness.answer(serverId, 'POST /v1/artifacts/saved', { status: 403, body: { error: 'forbidden' } });
        await choose('rename');
        await vi.waitFor(() => expect(modalBoundary.alert).toHaveBeenCalled());
        expect(modalBoundary.alert.mock.calls.at(-1)?.[0]).toBe('Error');
        expect(harness.artifacts(serverId).readPlainBody('saved')).toBe(original);
        expect(screen.findByTestId('gallery.entry.group-saved.actions')).not.toBeNull();
    });

    it('does not finish a pending rename after its Account lifetime retires', async () => {
        const { choose, serverId } = await renderGallery();
        const original = harness.artifacts(serverId).readPlainBody('saved');
        modalBoundary.prompt.mockImplementation(async () => {
            const nextAccount = { serverId, accountId: 'account-b' };
            storage.setState({ profileScope: nextAccount, settingsScope: nextAccount });
            return 'Wrong Account';
        });
        await choose('rename');
        await vi.waitFor(() => expect(modalBoundary.prompt).toHaveBeenCalled());
        await flushHookEffects({ cycles: 2 });
        expect(harness.artifacts(serverId).readPlainBody('saved')).toBe(original);
    });
});
