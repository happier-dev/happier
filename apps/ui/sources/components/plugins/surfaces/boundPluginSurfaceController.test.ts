import {
    createActionExecutor,
    DaemonPluginActionSchemasReadResponseSchema,
    type PluginContributionIdentityV1,
    type PluginProjectedActionV2,
    type PluginResourceContextV1,
} from '@happier-dev/protocol';
import { createWidgetAreaActionPortV1, createWidgetSurfaceArtifactPortV1, createWidgetActionInputResolverV1, readBuiltinWidgetDescriptorV1 } from '@happier-dev/protocol/widgets';
import type { HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createPluginActionInputSelectionFactsPublication } from './pluginActionInputSelectionFacts';
import { createWorkBoardArtifactBoundary } from '@/dev/testkit/harness/workBoardArtifactBoundary';
import { EMPTY_PLUGIN_UI_PROJECTION, normalizePluginInstalledUiDeclarations, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { widgetInstalledPackage, widgetProjectionOf } from '@/dev/testkit/fixtures/pluginWidgetProjectionFixtures';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import {
    PluginUiSelectActionInputResultV1Schema,
    type PluginUiJsonValueV1,
    type PluginUiTargetedContributionsV1,
} from '@happier-dev/protocol/plugins/ui';
import { Linking } from 'react-native';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDeferred, createMachineFixture, renderHook, renderScreen } from '@/dev/testkit';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { log } from '@/log';
import { t } from '@/text';
import { settlePluginSurfaceHostApiRequest } from './createPluginSurfaceHostApi';
import { WidgetFrameBodyNoticeContext, type WidgetFrameBodyNoticeSource } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { storage } from '@/sync/domains/state/storageStore';
import {
    createBoundPluginSurfaceController,
    useBoundPluginSurfaceController,
    usePluginSurfaceDaemonInteraction,
    type BoundPluginSurfaceBinding,
    type BoundPluginSurfaceFacts,
    type BoundPluginSurfaceMountedHostApiHandlersFactory,
} from './boundPluginSurfaceController';
import type { PluginSurfaceResourceReadTransport } from './pluginSurfaceResourceRead';
import type { PluginSurfaceResourceWatchTransport } from './pluginSurfaceResourceWatch';

const clipboard = vi.hoisted(() => ({
    getStringAsync: vi.fn(),
    setStringAsync: vi.fn(),
}));

vi.mock('expo-clipboard', () => clipboard);

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const CURRENT_ACCOUNT_LIFETIME = Object.freeze({
    scope: { serverId: 'server-1', accountId: 'account-a' },
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

function resolveDaemonTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return {
        id: identity.localId,
        pluginId: identity.pluginId,
        occurrenceId: 'daemon-action-occurrence-a',
        title: identity.localId,
        scopes: ['session'],
        surfaces: ['ui'],
        execution: { target: 'daemon' },
        dangerLevel: 'safe',
        // The canonical daemon writer stamps `available` on every projected
        // Action (apps/cli/src/plugins/projection/registry/projection/v2.ts),
        // so an ordinary reachable fixture must carry it too. The deliberate
        // unavailable case lives in its own negative control below.
        available: true,
    };
}

function resolveClientTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return {
        id: identity.localId,
        pluginId: identity.pluginId,
        occurrenceId: 'client-action-occurrence-a',
        title: identity.localId,
        scopes: ['session'],
        surfaces: ['ui'],
        execution: {
            target: 'client',
            client: {
                artifactId: 'client-action-bundle',
                exportName: 'execute',
            },
            platforms: ['web'],
        },
        dangerLevel: 'safe',
        available: true,
    };
}

/**
 * The exact same client target the daemon reports as not currently
 * registered. This is the negative control for the one fail-closed
 * executability rule (`isPluginProjectedActionExecutable`).
 */
function resolveUnavailableClientTargetAction(
    identity: PluginContributionIdentityV1,
): PluginProjectedActionV2 {
    return { ...resolveClientTargetAction(identity), available: false };
}

const FACTS = {
    actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publish({ targetPluginId: 'acme.browser' }),
    pluginId: 'acme.browser',
    contributionId: 'panel',
    surfaceId: 'surfacePlacement:acme.browser:panel',
    placement: 'browserSurface',
    platform: 'web',
    channel: 'internal',
    machineId: 'machine_1',
    serverId: 'server-1',
    occurrenceId: 'acme.browser:12',
    executionOrigin: {
        serverIdentityId: 'srv_browser_fixture',
        materializationRef: {
            machineId: 'machine_1',
            materializationId: 'materialization-browser-current',
            pluginId: 'acme.browser',
        },
    },
    resourceCapability: { readable: true, dynamic: true },
    resolveContributedAction: resolveDaemonTargetAction,
    accountLifetime: CURRENT_ACCOUNT_LIFETIME,
    interactionEnabled: true,
    daemonInteractionEnabled: true,
} as const;

const TARGETED_RESOURCE_MOUNT_INSTANCE_KEY = 'targeted-surface:v1:review:mount-a';

describe('mounted host Resource admission', () => {
    it('withdraws a pending host preparation when the mounted Machine binding changes', async () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
        const binding = { executeHostAction: executor.execute };
        let machineId = 'machine_1';
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, readActionInputFacts: () => ({ machineId }) }, binding,
        });
        const events: import('@happier-dev/protocol/plugins/ui').PluginUiActionControlEventV1[] = [];
        let pending: Promise<void> | undefined;
        try {
            await controller.hostApi.handleRequest(request('actionControl', { kind: 'bind', subscriptionId: 'run',
                action: 'projects.compute.exec', presentation: { title: 'Run' } }), { actionControlSubscription: {
                retain: () => {}, publish: event => { events.push(event); },
            } });
            pending = controller.actionControls!.press('run');
            expect(events[0]).toMatchObject({ kind: 'prepare' });
            machineId = 'machine_2';
            expect(controller.updateMountedBindings?.({})).toBe(true);
            await vi.waitFor(() => expect(events.at(-1)).toMatchObject({ kind: 'settled',
                execution: { ok: false, errorCode: 'stale_surface' } }));
            await pending;
            expect(controller.actionControls!.getSnapshot()).toMatchObject([{ id: 'run', busy: false }]);
        } finally { controller.dispose(); await pending; }
    });
    it('prepares one person invocation from a mounted host control while raw requests retain approval', async () => {
        let launches = 0;
        const setupHold = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'reviewed-setup' } as const;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            projectAction: async () => { launches += 1; return setupHold; },
        }));
        const controller = createBoundPluginSurfaceController({ facts: FACTS,
            binding: { executeHostAction: executor.execute } });
        try {
            expect(controller.installedMethods).toContain('actionControl');
            const input = { workspace: { serverId: 'server-1', machineId: 'machine_1', workspaceId: 'workspace-a', rootPath: '/work' },
                executable: 'act', argv: ['--rm=true', '--reuse=false'], cwd: '/work' };
            const events: import('@happier-dev/protocol/plugins/ui').PluginUiActionControlEventV1[] = [];
            let prepared = 0;
            const release: (() => void)[] = [];
            await controller.hostApi.handleRequest(request('actionControl', { kind: 'bind', subscriptionId: 'run',
                action: 'projects.compute.exec', presentation: { title: 'Run' } }), { actionControlSubscription: {
                retain: cleanup => release.push(cleanup),
                publish: event => {
                    events.push(event);
                    if (event.kind === 'prepare') {
                        prepared += 1;
                        void controller.hostApi.handleRequest(request('actionControl', { kind: 'prepared', subscriptionId: 'run',
                            requestId: event.requestId, preparation: { input } }));
                    }
                },
            } });
            expect(launches).toBe(0);
            expect(prepared).toBe(0);
            const snapshot = controller.actionControls!.getSnapshot();
            const publication = vi.fn();
            const unsubscribe = controller.actionControls!.subscribe(publication);
            await controller.hostApi.handleRequest(request('actionControl', { kind: 'update', subscriptionId: 'run', presentation: { title: 'Run' } }));
            expect(controller.actionControls!.getSnapshot()).toBe(snapshot);
            expect(publication).not.toHaveBeenCalled();
            unsubscribe();
            await controller.hostApi.handleRequest(request('actionControl', { kind: 'prepared', subscriptionId: 'run',
                requestId: 'forged', preparation: { input } }));
            expect(launches).toBe(0);
            await expect(controller.hostApi.handleRequest(request('executeAction', { action: 'projects.compute.exec', input })))
                .resolves.toMatchObject({ code: 'unavailable', diagnostics: ['approvals_not_supported'] });
            await controller.actionControls!.press('run');
            expect(prepared).toBe(1);
            expect(launches).toBe(1);
            expect(events.at(-1)).toMatchObject({ kind: 'settled', execution: { ok: true, result: setupHold } });
            release.forEach(cleanup => cleanup());
            expect(controller.actionControls!.getSnapshot()).toHaveLength(0);
        } finally { controller.dispose(); }
    });
    it.each(['cancel', 'misbound', 'retire'] as const)('never executes a withdrawn or mis-bound host preparation (%s)', async disposition => {
        let effects = 0;
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            projectAction: async () => { effects += 1; return { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'setup' }; },
        }));
        const controller = createBoundPluginSurfaceController({ facts: FACTS, binding: { executeHostAction: executor.execute } });
        const events: import('@happier-dev/protocol/plugins/ui').PluginUiActionControlEventV1[] = [];
        try {
            await controller.hostApi.handleRequest(request('actionControl', { kind: 'bind', subscriptionId: 'run',
                action: 'projects.compute.exec', presentation: { title: 'Run' } }), { actionControlSubscription: {
                retain: () => {}, publish: event => { events.push(event); },
            } });
            const pending = controller.actionControls!.press('run');
            const event = events[0]!;
            if (event.kind !== 'prepare') throw new Error('Host did not request preparation');
            const reply = { kind: 'prepared', subscriptionId: 'run', requestId: event.requestId,
                preparation: { input: { workspace: { serverId: 'server-1', machineId: 'machine_1', workspaceId: 'workspace-a', rootPath: '/work' },
                    executable: 'act', argv: [], cwd: '/work' } } };
            if (disposition === 'retire') {
                controller.retire();
                expect(await controller.hostApi.handleRequest(request('actionControl', reply))).toMatchObject({ code: 'stale_surface' });
                controller.dispose();
            } else {
                if (disposition === 'misbound') {
                    expect(await controller.hostApi.handleRequest(request('actionControl', { ...reply, requestId: 'other-gesture' })))
                        .toMatchObject({ code: 'invalid_payload' });
                    expect(effects).toBe(0);
                }
                await controller.hostApi.handleRequest(request('actionControl', { ...reply, preparation: null }));
            }
            await pending;
            expect(effects).toBe(0);
            expect(events.filter(event => event.kind === 'settled')).toEqual([]);
        } finally { controller.dispose(); }
    });
    it('distinguishes complete current full-describe Resource sets from absent, partial and retired sources', async () => {
        const installed = { ...widgetInstalledPackage('acme.browser', 'Browser'), occurrenceId: FACTS.occurrenceId };
        const orphanRows = { 'acme.browser/stale': {
            id: 'stale', pluginId: 'acme.browser', resourceKind: 'config' as const, scope: 'global' as const,
        } };
        const cases = [
            { name: 'current full describe, known empty', complete: true,
                projection: widgetProjectionOf([], { 'acme.browser': installed }) },
            { name: 'plugin absent from the describe', complete: false,
                projection: { ...EMPTY_PLUGIN_UI_PROJECTION, resourcesById: orphanRows } },
            { name: 'partial installed UI declarations', complete: false,
                projection: normalizePluginInstalledUiDeclarations({}, 'web', installed) },
            { name: 'full describe from a retired occurrence', complete: false,
                projection: widgetProjectionOf([], { 'acme.browser': { ...installed, occurrenceId: 'retired-occurrence' } }, orphanRows) },
        ];
        for (const fixture of cases) {
            const readResource = vi.fn<PluginSurfaceResourceReadTransport>(async (_machineId, input) => ({
                supported: true, result: { ok: true, resource: input.resource, kind: 'asset', contentType: 'application/json',
                    digest: `sha256:${'a'.repeat(64)}`, bytesBase64: 'e30=' },
            }));
            const controller = createBoundPluginSurfaceController({ facts: { ...FACTS,
                pluginUiProjection: fixture.projection,
            }, binding: { readResource } });
            try {
                const result = await controller.hostApi.handleRequest(request('readResource', { resource: 'state' }));
                expect(readResource.mock.calls.length, fixture.name).toBe(fixture.complete ? 0 : 1);
                expect(result, fixture.name).toMatchObject(fixture.complete
                    ? { code: 'unavailable', diagnostics: ['plugin_resource_not_found'] }
                    : { contentType: 'application/json', bytesBase64: 'e30=' });
            } finally { controller.dispose(); }
        }
    });

    it('uses a complete targeted empty Resource set instead of a stale full-describe declaration', async () => {
        const readResource = vi.fn<PluginSurfaceResourceReadTransport>(async (_machineId, input) => ({
            supported: true, result: { ok: true, resource: input.resource, kind: 'asset', contentType: 'application/json',
                digest: `sha256:${'a'.repeat(64)}`, bytesBase64: 'e30=' },
        }));
        const controller = createBoundPluginSurfaceController({ facts: { ...FACTS,
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, resourcesById: { 'acme.browser/state': {
                id: 'state', pluginId: 'acme.browser', resourceKind: 'config', scope: 'global',
            } } },
            resourceDeclarations: {},
        }, binding: { readResource } });
        try {
            await expect(controller.hostApi.handleRequest(request('readResource', { resource: 'state' }))).resolves.toMatchObject({
                code: 'unavailable', diagnostics: ['plugin_resource_not_found'],
            });
            expect(readResource).not.toHaveBeenCalled();
        } finally { controller.dispose(); }
    });

    it('separates ordinary Resource subscriptions for two mounts of the same surface', async () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ isActionEnabled: () => false }));
        const opened: string[] = [];
        const watch: PluginSurfaceResourceWatchTransport = {
            open: async (_machineId, request) => {
                opened.push(request.subscriptionId);
                return { supported: true, result: { ok: true, subscriptionId: request.subscriptionId,
                    digest: `sha256:${'a'.repeat(64)}` } };
            },
            next: async () => await new Promise<never>(() => {}),
            close: async () => {},
        };
        const controllers = [0, 1].map(() => createBoundPluginSurfaceController({ facts: FACTS, binding: {
            executeHostAction: Object.assign(executor.execute, { prepare: executor.prepare }),
            readResource: async (_machineId, request) => ({ supported: true, result: { ok: true,
                resource: request.resource, kind: 'asset', contentType: 'application/json',
                digest: `sha256:${'a'.repeat(64)}`, bytesBase64: 'e30=' } }),
            watchResource: watch,
        } }));
        const retire: (() => void)[] = [];
        try {
            for (const controller of controllers) {
                if (!controller.resourceStore) throw new Error('Expected mounted Resource store');
                retire.push(controller.resourceStore.getEntry('status').subscribe(() => {}, true));
            }
            await vi.waitFor(() => expect(opened).toHaveLength(2));
            expect(new Set(opened).size).toBe(2);
        } finally {
            retire.forEach(unsubscribe => unsubscribe());
            controllers.forEach(controller => controller.dispose());
        }
    });
    it('revalidates the selected execution origin without retiring machine-free context', async () => {
        let exactTargetCurrent = true;
        const executeContributedAction = vi.fn(async () => ({ supported: true as const, result: { ok: true as const, result: { accepted: true } } }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction, isExecutionOriginCurrent: () => exactTargetCurrent },
        });
        exactTargetCurrent = false;
        await expect(controller.dispatchAction({ pluginId: FACTS.pluginId, localId: 'refresh' })).resolves.toMatchObject({ code: 'unavailable' });
        expect(executeContributedAction).not.toHaveBeenCalled();
        expect(controller.isCurrent()).toBe(true);
        expect(controller.installedMethods).toContain('context');
        controller.dispose();
    });
    it('offers host reads without a daemon Resource declaration and exposes no unadmitted bytes', () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            isActionEnabled: () => false,
        }));
        const execute = Object.assign(executor.execute, { prepare: executor.prepare });
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false, resourceCapability: undefined },
            binding: { executeHostAction: execute },
        });
        expect(controller.installedMethods).toContain('readResource');
        expect(controller.installedMethods).toContain('watchResource');
        expect(controller.resourceStore).toBeDefined();
        const entry = controller.resourceStore!.getEntry({ hostRead: 'usage.query', input: { queries: [{}] } });
        const snapshot = entry.getSnapshot();
        expect(snapshot.value).toBeUndefined();
        controller.dispose();
    });

    it('does not borrow an Account entry when the Action target names another Home', () => {
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, serverId: 'another-home', daemonInteractionEnabled: false, resourceCapability: undefined },
            binding: { executeHostAction: Object.assign(executor.execute, { prepare: executor.prepare }) },
        });
        expect(controller.resourceStore).toBeUndefined();
        controller.dispose();
    });
});

function createTargetedSurfaceResourceContext(
    launchInput: PluginUiJsonValueV1,
): PluginResourceContextV1 {
    return Object.freeze({
        kind: 'surface' as const,
        mountInstanceKey: TARGETED_RESOURCE_MOUNT_INSTANCE_KEY,
        launchInput,
    });
}

function request(method: string, payload?: unknown) {
    return {
        version: 1,
        requestId: `req:${method}`,
        surface: {
            pluginId: FACTS.pluginId,
            contributionId: FACTS.contributionId,
            surfaceId: FACTS.surfaceId,
            placement: FACTS.placement,
            platform: FACTS.platform,
            channel: FACTS.channel,
            resourceScope: [],
            diagnostics: [],
        },
        method,
        ...(payload === undefined ? {} : { payload }),
    } as never;
}

describe('BoundPluginSurfaceController (§3.1)', () => {
    it('answers an external plugin call entered while connecting after the committed connection settles', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true as const, result: { ok: true as const, result: { refreshed: true } },
        }));
        const hook = await renderHook((connecting: boolean) => useBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: !connecting, isDaemonConnectionPending: () => connecting },
            binding: { executeContributedAction },
        }), { initialProps: true });
        try {
            const controller = hook.getCurrent();
            let settled = false;
            const result = controller.dispatchAction({ pluginId: FACTS.pluginId, localId: 'refresh-index' }, {})
                .then(value => { settled = true; return value; });
            await act(async () => {});
            expect(settled).toBe(false);
            expect(executeContributedAction).not.toHaveBeenCalled();
            expect(await hook.rerender(false)).toBe(controller);
            await expect(result).resolves.toEqual({ refreshed: true });
            expect(executeContributedAction).toHaveBeenCalledTimes(1);
        } finally { await hook.unmount(); }
    });

    it('holds host readiness without changing settled caller refusals or Account activity', async () => {
        for (const occurrenceId of [null, FACTS.occurrenceId]) {
            let connecting = true;
            const facts = { ...FACTS, occurrenceId, executionOrigin: null, daemonInteractionEnabled: false,
                isDaemonConnectionPending: () => connecting };
            const controller = createBoundPluginSurfaceController({ facts });
            try {
                const invocation = request('executeAction', { action: 'refresh-index', input: {} });
                const read = () => settlePluginSurfaceHostApiRequest(invocation, () => controller.hostApi.handleRequest(invocation));
                const original = occurrenceId ? 'plugin_surface_contributed_action_unavailable' : 'plugin_mounted_caller_unavailable';
                const waiting = read();
                expect(controller.interactive).toBe(true);
                expect(controller.hostApi.handleRequest(request('context'))).toMatchObject({ pluginId: FACTS.pluginId });
                const localInvocation = request('executeAction', { action: 'plugins.reload', input: {} });
                const localResult = await settlePluginSurfaceHostApiRequest(localInvocation,
                    () => controller.hostApi.handleRequest(localInvocation));
                if (localResult.kind === 'error') {
                    expect(localResult.payload.diagnostics).not.toContain('plugin_surface_connection_pending');
                }
                // The same refusal during an actual outage is terminal. A code
                // allowlist alone cannot infer that a host is still connecting.
                connecting = false;
                controller.hostApi.notifyConnectionSettled?.();
                expect(await waiting).toMatchObject({ kind: 'error', payload: { code: 'unavailable', diagnostics: [original] } });
                expect(await read()).toMatchObject({ kind: 'error', payload: { code: 'unavailable', diagnostics: [original] } });
            } finally { controller.dispose(); }
        }
    });

    it('keeps supported Machine methods structurally admitted without an execution target', async () => {
        const controller = createBoundPluginSurfaceController({ facts: {
            ...FACTS, machineId: null, occurrenceId: null, executionOrigin: null, daemonInteractionEnabled: false,
            executionOriginSelectionKind: 'selectionRequired',
        } });
        try {
            for (const method of ['readStoredImage', 'watchLiveStream', 'selectActionInput', 'readResource', 'watchResource'] as const) {
                expect(controller.admissionMethods).toContain(method);
                expect(controller.installedMethods).not.toContain(method);
                const invocation = request(method);
                await expect(settlePluginSurfaceHostApiRequest(invocation, () => controller.hostApi.handleRequest(invocation)))
                    .resolves.toMatchObject({ kind: 'error', payload: {
                        code: 'unavailable', diagnostics: [`host_api_method_unavailable:${method}`],
                        message: t('settingsPlugins.targetSelection.selectionRequired'),
                    } });
            }
            expect(controller.admissionMethods).not.toContain('readOpenableContent');
            expect(controller.admissionMethods).not.toContain('statOpenableContent');
            expect(controller.interactive).toBe(true);
            const withoutResources = createBoundPluginSurfaceController({ facts: {
                ...FACTS, machineId: null, occurrenceId: null, executionOrigin: null,
                resourceCapability: undefined, daemonInteractionEnabled: false,
            } });
            expect(withoutResources.admissionMethods).not.toContain('readResource');
            expect(withoutResources.admissionMethods).not.toContain('watchResource');
            withoutResources.dispose();
        } finally { controller.dispose(); }
    });

    it.each([
        { occurrenceId: FACTS.occurrenceId, machineDisplayName: 'Studio Mac' },
        { occurrenceId: null, machineDisplayName: 'Studio Mac' },
        { occurrenceId: null, machineDisplayName: null },
    ])('names the unavailable target in real Action and Resource refusals while keeping Account content interactive (%j)', async ({ occurrenceId, machineDisplayName }) => {
        const controller = createBoundPluginSurfaceController({ facts: {
            ...FACTS, occurrenceId, executionOrigin: null, machineDisplayName, daemonInteractionEnabled: false,
        } });
        try {
            for (const [method, payload, diagnostic] of [
                ['executeAction', { action: 'refresh-index', input: {} }, occurrenceId ? 'plugin_surface_contributed_action_unavailable' : 'plugin_mounted_caller_unavailable'],
                ['readResource', { resource: 'status' }, occurrenceId ? 'plugin_resource_transport_unavailable' : 'host_api_method_unavailable:readResource'],
            ] as const) {
                const invocation = request(method, payload);
                const result = await settlePluginSurfaceHostApiRequest(invocation, () => controller.hostApi.handleRequest(invocation));
                expect(result).toMatchObject({ kind: 'error', payload: {
                    code: 'unavailable', diagnostics: [diagnostic], message: expect.stringContaining(machineDisplayName ?? t('machine.thisMachineInSentence')),
                } });
                // A Machine whose name has not loaded is "this machine" in a sentence, never its raw id.
                expect((result as { payload: { message: string } }).payload.message).not.toContain(FACTS.machineId);
            }
            expect(controller.interactive).toBe(true);
            expect(controller.isCurrent()).toBe(true);
            expect(controller.hostApi.handleRequest(request('context'))).toMatchObject({ pluginId: FACTS.pluginId });
        } finally { controller.dispose(); }
    });

    it('names the unavailable Run-on Machine supplied by the surface host without a bound execution origin', async () => {
        const controller = createBoundPluginSurfaceController({ facts: {
            ...FACTS, machineId: 'machine_pinned_offline', machineDisplayName: 'Old laptop',
            occurrenceId: null, executionOrigin: null, daemonInteractionEnabled: false,
            executionOriginSelectionKind: 'unavailable',
        } });
        try {
            const invocation = request('executeAction', { action: 'refresh-index', input: {} });
            const result = await settlePluginSurfaceHostApiRequest(invocation, () => controller.hostApi.handleRequest(invocation));
            expect(result).toMatchObject({ kind: 'error', payload: { code: 'unavailable',
                message: t('settingsPlugins.surfaces.machineCapabilityUnavailable', { machine: 'Old laptop' }) } });
        } finally {
            controller.dispose();
        }
    });

    it('preserves a failed target read through Action and Resource refusals instead of claiming Machine incapability', async () => {
        let failed = true;
        let pending = true;
        const facts = {
            ...FACTS,
            machineDisplayName: 'Studio Mac',
            isDaemonConnectionPending: () => pending,
            get daemonInteractionEnabled() { return !failed; },
            get daemonConnectionFailure() {
                return failed ? { code: 'timeout' as const, reasonCode: 'targeted_contributions_timeout' } : undefined;
            },
        };
        const executeContributedAction = vi.fn(async () => ({ supported: true as const, result: { ok: true as const, result: { refreshed: true } } }));
        const controller = createBoundPluginSurfaceController({ facts, binding: { executeContributedAction } });
        try {
            const waiting = request('executeAction', { action: 'refresh-index', input: {} });
            const waitingResult = settlePluginSurfaceHostApiRequest(waiting, () => controller.hostApi.handleRequest(waiting));
            pending = false;
            controller.hostApi.notifyConnectionSettled?.();
            await expect(waitingResult).resolves.toMatchObject({ kind: 'error', payload: { code: 'timeout',
                diagnostics: expect.arrayContaining(['targeted_contributions_timeout']) } });
            for (const [method, payload] of [
                ['executeAction', { action: 'refresh-index', input: {} }],
                ['readResource', { resource: 'status' }],
            ] as const) {
                const invocation = request(method, payload);
                const result = await settlePluginSurfaceHostApiRequest(invocation, () => controller.hostApi.handleRequest(invocation));
                expect(result).toMatchObject({ kind: 'error', payload: {
                    code: 'timeout', diagnostics: expect.arrayContaining(['targeted_contributions_timeout']),
                    message: t('pluginRuntime.transportUnavailable'),
                } });
            }
            expect(executeContributedAction).not.toHaveBeenCalled();
            expect(controller.isCurrent()).toBe(true);
            failed = false;
            await expect(controller.dispatchAction({ pluginId: FACTS.pluginId, localId: 'refresh-index' }, {}))
                .resolves.toEqual({ refreshed: true });
        } finally { controller.dispose(); }
    });

    it('says once what to do when no Machine exists at all, instead of naming a Machine that is not there', async () => {
        const controller = createBoundPluginSurfaceController({ facts: {
            ...FACTS, machineId: null, machineDisplayName: null, occurrenceId: null, executionOrigin: null,
            daemonInteractionEnabled: false, executionOriginSelectionKind: 'unavailable',
        } });
        try {
            await expect(controller.dispatchAction({ pluginId: FACTS.pluginId, localId: 'refresh-index' })).resolves.toMatchObject({
                code: 'unavailable', message: t('settingsPlugins.targetSelection.noMachine'),
            });
        } finally { controller.dispose(); }
    });

    it('lends the Machine sentence it gave a refusal to the enclosing widget frame, and withdraws it when the mount ends', async () => {
        const lend = vi.fn();
        const hook = await renderHook(() => useBoundPluginSurfaceController({ facts: {
            ...FACTS, occurrenceId: null, executionOrigin: null, machineDisplayName: 'Studio Mac', daemonInteractionEnabled: false,
        } }), { wrapper: ({ children }) => React.createElement(WidgetFrameBodyNoticeContext.Provider, { value: lend }, children) });
        const controller = hook.getCurrent();
        // Account-owned content is not a Machine refusal: nothing to say.
        controller.hostApi.handleRequest(request('context'));
        expect(lend).not.toHaveBeenCalled();
        const invocation = request('executeAction', { action: 'refresh-index', input: {} });
        await settlePluginSurfaceHostApiRequest(invocation, () => controller.hostApi.handleRequest(invocation));
        // Lent once, as a way to word it that follows the Machine's state.
        await settlePluginSurfaceHostApiRequest(invocation, () => controller.hostApi.handleRequest(invocation));
        expect(lend).toHaveBeenCalledTimes(1);
        const describe = lend.mock.calls[0]![0] as WidgetFrameBodyNoticeSource;
        expect(describe()).toEqual({ sentence: t('settingsPlugins.surfaces.machineCapabilityUnavailable', { machine: 'Studio Mac' }) });
        await hook.unmount();
        expect(lend).toHaveBeenLastCalledWith(null);
    });

    it('tells the widget frame that no Machine exists, so it leads to adding one instead of retrying', async () => {
        const lend = vi.fn();
        const hook = await renderHook(() => useBoundPluginSurfaceController({ facts: {
            ...FACTS, machineId: null, machineDisplayName: null, occurrenceId: null, executionOrigin: null,
            daemonInteractionEnabled: false, executionOriginSelectionKind: 'unavailable',
        } }), { wrapper: ({ children }) => React.createElement(WidgetFrameBodyNoticeContext.Provider, { value: lend }, children) });
        const invocation = request('executeAction', { action: 'refresh-index', input: {} });
        await settlePluginSurfaceHostApiRequest(invocation, () => hook.getCurrent().hostApi.handleRequest(invocation));
        const describe = lend.mock.calls[0]![0] as WidgetFrameBodyNoticeSource;
        expect(describe()).toEqual({ sentence: t('settingsPlugins.targetSelection.noMachine'), addMachine: true });
        await hook.unmount();
    });

    it('says none of the Home’s machines runs the plugin, and leads to the plugin, when machines exist but none can', async () => {
        const lend = vi.fn();
        const hook = await renderHook(() => useBoundPluginSurfaceController({ facts: {
            ...FACTS, machineId: null, machineDisplayName: null, occurrenceId: null, executionOrigin: null,
            daemonInteractionEnabled: false, executionOriginSelectionKind: 'unavailable',
            homeHasMachines: true, pluginDisplayName: 'PRs & Issues',
        } }), { wrapper: ({ children }) => React.createElement(WidgetFrameBodyNoticeContext.Provider, { value: lend }, children) });
        const invocation = request('executeAction', { action: 'refresh-index', input: {} });
        await settlePluginSurfaceHostApiRequest(invocation, () => hook.getCurrent().hostApi.handleRequest(invocation));
        const describe = lend.mock.calls[0]![0] as WidgetFrameBodyNoticeSource;
        expect(describe()).toEqual({ sentence: t('settingsPlugins.surfaces.noMachineRunsPlugin', { plugin: 'PRs & Issues' }), managePluginId: FACTS.pluginId });
        await hook.unmount();
    });

    it('names the plugin and Machine behind a refused Collection write, and leads to the plugin to update it', async () => {
        const lend = vi.fn();
        const executeContributedAction = vi.fn(async () => ({ supported: true as const,
            result: { ok: false as const, code: 'collection_writer_contract_unavailable' } }));
        const hook = await renderHook(() => useBoundPluginSurfaceController({
            facts: { ...FACTS, machineDisplayName: 'Studio Mac', pluginDisplayName: 'PRs & Issues' },
            binding: { executeContributedAction },
        }), { wrapper: ({ children }) => React.createElement(WidgetFrameBodyNoticeContext.Provider, { value: lend }, children) });
        const sentence = t('settingsPlugins.surfaces.pluginNeedsUpdate', { plugin: 'PRs & Issues', machine: 'Studio Mac' });
        try {
            const invocation = request('executeAction', { action: 'refresh-index', input: {} });
            await expect(settlePluginSurfaceHostApiRequest(invocation, () => hook.getCurrent().hostApi.handleRequest(invocation)))
                .resolves.toMatchObject({ kind: 'error', payload: { code: 'unavailable',
                    diagnostics: expect.arrayContaining(['collection_writer_contract_unavailable']), message: sentence } });
            expect(executeContributedAction).toHaveBeenCalledTimes(1);
            expect(lend).toHaveBeenCalledTimes(1);
            expect((lend.mock.calls[0]![0] as WidgetFrameBodyNoticeSource)()).toEqual({ sentence, managePluginId: FACTS.pluginId });
        } finally { await hook.unmount(); }
        expect(lend).toHaveBeenLastCalledWith(null);
    });

    describe('a Machine that has the plugin but cannot run it', () => {
        const refused = (executionOriginRefusal: NonNullable<BoundPluginSurfaceFacts['executionOriginRefusal']>) => {
            const lend = vi.fn();
            const mounted = renderHook(() => useBoundPluginSurfaceController({ facts: {
                ...FACTS, machineId: null, machineDisplayName: null, occurrenceId: null, executionOrigin: null,
                daemonInteractionEnabled: false, executionOriginSelectionKind: 'unavailable',
                homeHasMachines: true, pluginDisplayName: 'PRs & Issues', executionOriginRefusal,
            } }), { wrapper: ({ children }) => React.createElement(WidgetFrameBodyNoticeContext.Provider, { value: lend }, children) });
            return { lend, mounted };
        };
        const noticeFor = async (executionOriginRefusal: NonNullable<BoundPluginSurfaceFacts['executionOriginRefusal']>) => {
            const { lend, mounted } = refused(executionOriginRefusal);
            const hook = await mounted;
            const invocation = request('executeAction', { action: 'refresh-index', input: {} });
            await settlePluginSurfaceHostApiRequest(invocation, () => hook.getCurrent().hostApi.handleRequest(invocation));
            const notice = (lend.mock.calls[0]![0] as WidgetFrameBodyNoticeSource)();
            await hook.unmount();
            return notice;
        };

        it.each([
            [['activation_refused'], 'pluginCouldNotStart', undefined],
            [['offline'], 'pluginMachineUnreachable', undefined],
            [['untrusted'], 'pluginNotReady', FACTS.pluginId],
            [['activation_refused', 'offline'], 'pluginNotReady', FACTS.pluginId],
        ] as const)('words %j for the Machine it names, never as "install it"', async (reasons, key, managePluginId) => {
            const notice = await noticeFor({ reasons, machineDisplayName: 'QA Machine' });
            expect(notice).toEqual({
                sentence: t(`settingsPlugins.surfaces.${key}`, { plugin: 'PRs & Issues', machine: 'QA Machine' }),
                ...(managePluginId ? { managePluginId } : {}),
            });
            expect(notice?.sentence).not.toBe(t('settingsPlugins.surfaces.noMachineRunsPlugin', { plugin: 'PRs & Issues' }));
        });

        it('says the plugin could not start on the Machine, in words, with the way forward', async () => {
            const notice = await noticeFor({ reasons: ['activation_refused'], machineDisplayName: 'QA Machine' });
            expect(notice?.sentence).toBe('PRs & Issues couldn’t start on QA Machine. Restart Happier there, or choose another machine with Run on.');
        });

        it('does not name one Machine when several refused', async () => {
            const notice = await noticeFor({ reasons: ['activation_refused', 'offline'] });
            expect(notice).toEqual({
                sentence: t('settingsPlugins.surfaces.pluginNotReadyAnywhere', { plugin: 'PRs & Issues' }),
                managePluginId: FACTS.pluginId,
            });
        });

        it('still leads to installing when no Machine has it', async () => {
            const notice = await noticeFor({ reasons: ['no_materialization'] });
            expect(notice).toEqual({ sentence: t('settingsPlugins.surfaces.noMachineRunsPlugin', { plugin: 'PRs & Issues' }), managePluginId: FACTS.pluginId });
        });
    });

    it.each(['selectionRequired', 'conflict'] as const)('asks for a target only when Administration reports %s', async executionOriginSelectionKind => {
        const controller = createBoundPluginSurfaceController({ facts: {
            ...FACTS, machineId: null, executionOrigin: null, daemonInteractionEnabled: false,
            executionOriginSelectionKind,
        } });
        try {
            await expect(controller.dispatchAction({ pluginId: FACTS.pluginId, localId: 'refresh-index' })).resolves.toMatchObject({
                code: 'unavailable', diagnostics: ['plugin_mounted_caller_unavailable'],
                message: t('settingsPlugins.targetSelection.selectionRequired'),
            });
            expect(controller.isCurrent()).toBe(true);
        } finally { controller.dispose(); }
    });

    it('does not reinterpret a local host Action custody refusal as Machine unavailability', async () => {
        const controller = createBoundPluginSurfaceController({ facts: {
            ...FACTS, occurrenceId: null, executionOrigin: null, machineDisplayName: 'Studio Mac', daemonInteractionEnabled: false,
        } });
        try {
            await expect(controller.hostApi.handleRequest(request('executeAction', { action: 'plugins.reload', input: {} }))).resolves.toEqual({
                code: 'unavailable', diagnostics: ['plugin_mounted_caller_unavailable'],
            });
        } finally { controller.dispose(); }
    });

    it('hydrates the unavailable target label without replacing its mounted controller', async () => {
        const hook = await renderHook((machineDisplayName: string | null) => useBoundPluginSurfaceController({ facts: {
            ...FACTS, occurrenceId: null, executionOrigin: null, machineDisplayName, daemonInteractionEnabled: false,
        } }), { initialProps: null as string | null });
        try {
            const first = hook.getCurrent();
            const action = { pluginId: FACTS.pluginId, localId: 'refresh-index' };
            await expect(first.dispatchAction(action)).resolves.toMatchObject({ message: t('settingsPlugins.surfaces.machineCapabilityUnavailable', { machine: t('machine.thisMachineInSentence') }) });
            const updated = await hook.rerender('Studio Mac');
            expect(updated).toBe(first);
            expect(first.isCurrent()).toBe(true);
            await expect(first.dispatchAction(action)).resolves.toMatchObject({ message: expect.stringContaining('Studio Mac') });
        } finally { await hook.unmount(); }
    });

    it('refuses an existing mounted Host API when its containing document admission is withdrawn', () => {
        let documentCurrent = true;
        const controller = createBoundPluginSurfaceController({ facts: { ...FACTS, isHostCurrent: () => documentCurrent } });
        expect(controller.isCurrent()).toBe(true);
        expect(controller.hostApi.handleRequest(request('context'))).not.toMatchObject({ code: 'stale_surface' });
        documentCurrent = false;
        expect(controller.hostApi.handleRequest(request('context'))).toEqual({ code: 'stale_surface', diagnostics: ['plugin_surface_retired'] });
        expect(controller.isCurrent()).toBe(false);
        const renewed = createBoundPluginSurfaceController({ facts: { ...FACTS, isHostCurrent: () => true } });
        expect(renewed.hostApi.handleRequest(request('context'))).not.toMatchObject({ code: 'stale_surface' });
        controller.dispose();
        renewed.dispose();
    });
    it.each([false, true])('keeps human area edits distinct from plugin and agent requests, honoring explicit Ask (%s)', async ask => {
        const scope = CURRENT_ACCOUNT_LIFETIME.scope;
        const boundary = createWorkBoardArtifactBoundary({ v: 1, boards: [] });
        const surface = { ...scope, owner: { kind: 'pluginArea', pluginId: FACTS.pluginId, pageId: FACTS.contributionId, area: 'pinned' } } as const;
        const store = createWidgetSurfaceArtifactPortV1(boundary.forAccount(scope.accountId), { surface, isCurrent: () => true });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope,
            widgetSurfaceActions: { pluginArea: createWidgetAreaActionPortV1(() => store) },
            widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async request => readBuiltinWidgetDescriptorV1(request.instance.definition),
                readContext: async () => ({}), readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }),
                resolveOptions: async () => [{ value: { serverId: scope.serverId, sessionId: 'readable-session' } }] }),
        }));
        const destination = normalizePluginUiDestinationBindingV1({ pluginId: FACTS.pluginId, destinationId: FACTS.contributionId,
            container: 'appPage', target: { kind: 'app' }, rendererId: 'native', instancePolicy: 'singleton' });
        if (!destination) throw new Error('Destination admission failed');
        const settings = normalizeActionsSettingsV1(ask ? { v: 1, actions: {
            'widgets.item.add': { approvalRequiredSurfaces: ['ui'] }, 'widgets.item.remove': { approvalRequiredSurfaces: ['ui'] },
        } } : { v: 1 });
        const controller = createBoundPluginSurfaceController({ facts: { ...FACTS,
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, surfacePlacementsById: {
                [FACTS.surfaceId]: { id: FACTS.surfaceId, pluginId: FACTS.pluginId, occurrenceId: FACTS.occurrenceId,
                    contributionKind: 'surfacePlacement', descriptorId: FACTS.contributionId, binding: destination,
                    target: {}, renderer: {}, display: {}, headerActions: [], availability: { state: 'available', reason: 'available', diagnostics: [] },
                    widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object', additionalProperties: false } }],
                },
            } },
        }, binding: { executeHostAction: (id, input, context) => executor.execute(id, input, { ...context, actionsSettings: settings }) } });
        const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {
            session: { kind: 'value', value: { serverId: scope.serverId, sessionId: 'readable-session' } },
        } } as const;
        const add = { area: 'pinned', operation: { actionId: 'widgets.item.add', instance } } as const;
        const remove = { area: 'pinned', operation: { actionId: 'widgets.item.remove', instanceId: instance.id } } as const;
        try {
            // The public plugin transport cannot inherit the person's UI authority.
            expect(await controller.hostApi.handleRequest(request('widgetArea', add)))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(await controller.hostApi.handleRequest(request('executeAction', { action: 'widgets.item.add', input: { surface, instance } })))
                .toMatchObject({ code: 'unavailable', diagnostics: ['approvals_not_supported'] });
            expect(await executor.execute('widgets.item.add', { surface, instance }, { surface: 'agent', authority: 'account_automation' }))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(boundary.rows.size).toBe(0);
            const added = await controller.widgetArea!(add);
            if (ask) {
                expect(added).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
                expect(boundary.rows.size).toBe(0);
                await store.apply({ kind: 'add', instance });
            } else {
                expect(added).toMatchObject({ ok: true, result: { instance } });
            }
            expect((await store.read()).items).toHaveLength(1);
            expect(await controller.hostApi.handleRequest(request('widgetArea', remove)))
                .toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            expect(await controller.hostApi.handleRequest(request('executeAction', { action: 'widgets.item.remove', input: { ref: { surface, instanceId: instance.id } } })))
                .toMatchObject({ code: 'unavailable', diagnostics: ['approvals_not_supported'] });
            expect(await executor.execute('widgets.item.remove', { ref: { surface, instanceId: instance.id } },
                { surface: 'agent', authority: 'account_automation' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
            const removed = await controller.widgetArea!(remove);
            expect(removed).toMatchObject(ask ? { ok: false, errorCode: 'approvals_not_supported' } : { ok: true, result: { instance: null } });
            expect((await store.read()).items).toHaveLength(ask ? 1 : 0);
            controller.retire();
            expect(await controller.widgetArea!(add)).toMatchObject({ code: 'stale_surface' });
        } finally { controller.dispose(); }
    });
    it.each(['available', 'pending', 'unavailable'] as const)('installs a declared page area independently of Machine availability and preserves Action custody (target: %s)', async (targetState) => {
        const scope = CURRENT_ACCOUNT_LIFETIME.scope;
        let row: Awaited<ReturnType<HomeHubArtifactTransportV1['read']>> = null;
        let onRead: (() => void) | undefined;
        const transport: HomeHubArtifactTransportV1 = {
            read: async () => { onRead?.(); return row; },
            create: async input => { row = { artifactId: input.artifactId, ownerAccountId: scope.accountId, access: 'owner', header: input.header,
                body: input.body, revision: { headerVersion: 1, bodyVersion: 1 } }; return row; },
            update: async input => { const revision = { headerVersion: 2, bodyVersion: 2 }; row = { artifactId: input.artifactId,
                ownerAccountId: scope.accountId, access: 'owner', header: input.header!, body: input.body!, revision }; return { ok: true, revision }; },
        };
        const area = createWidgetAreaActionPortV1(surface => createWidgetSurfaceArtifactPortV1(transport, { surface, isCurrent: () => true }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope, widgetSurfaceActions: { pluginArea: area },
            widgetInputs: createWidgetActionInputResolverV1({ readDescriptor: async request => readBuiltinWidgetDescriptorV1(request.instance.definition),
                readContext: async () => ({}), readViewerValues: async () => ({ values: {} }), validateValue: async () => ({ status: 'valid' }),
                resolveOptions: async () => [{ value: { serverId: scope.serverId, sessionId: 'readable-session' } }] }) }));
        const destination = normalizePluginUiDestinationBindingV1({ pluginId: FACTS.pluginId, destinationId: FACTS.contributionId,
            container: 'appPage', target: { kind: 'app' }, rendererId: 'native', instancePolicy: 'singleton' });
        if (!destination) throw new Error('Destination admission failed');
        const facts = { ...FACTS,
            ...(targetState !== 'available' ? { occurrenceId: null, executionOrigin: null, daemonInteractionEnabled: false } : {}),
            isDaemonConnectionPending: () => targetState === 'pending',
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, surfacePlacementsById: {
            [FACTS.surfaceId]: { id: FACTS.surfaceId, pluginId: FACTS.pluginId, occurrenceId: FACTS.occurrenceId,
                contributionKind: 'surfacePlacement' as const, descriptorId: FACTS.contributionId, binding: destination,
                target: {}, renderer: {}, display: {}, headerActions: [], availability: { state: 'available' as const, reason: 'available', diagnostics: [] },
                widgetAreas: [{ name: 'pinned', contextSchema: { type: 'object' as const, additionalProperties: false as const } }],
            },
        } } };
        const controller = createBoundPluginSurfaceController({ facts, binding: { executeHostAction: (id, input, context) =>
            executor.execute(id, input, { ...context, bypassApprovals: true }) } });
        expect(controller.admissionMethods).toContain('widgetArea');
        expect(controller.installedMethods).toContain('widgetArea');
        const instance = { v: 1, id: 'copy', definition: { kind: 'builtin', id: 'session_summary' }, bindings: {
            session: { kind: 'value', value: { serverId: scope.serverId, sessionId: 'readable-session' } },
        } };
        const added = await controller.hostApi.handleRequest(request('widgetArea', { area: 'pinned', operation: { actionId: 'widgets.item.add', instance } }));
        if (targetState !== 'available') {
            const errorCode = targetState === 'pending' ? 'plugin_surface_connection_pending' : 'plugin_mounted_caller_unavailable';
            expect(await controller.hostApi.handleRequest(request('widgetArea', { area: 'pinned', operation: { actionId: 'widgets.item.list' } })))
                .toMatchObject({ ok: false, errorCode });
            expect(added).toMatchObject({ ok: false, errorCode });
            expect(row).toBeNull();
            expect(controller.interactive).toBe(true);
            controller.dispose();
            return;
        }
        if (added && typeof added === 'object' && !Array.isArray(added) && 'ok' in added && added.ok === false) throw new Error(JSON.stringify(added));
        expect(added)
            .toMatchObject({ ok: true, result: { instance, ref: { surface: { ...scope, owner: { kind: 'pluginArea', pluginId: FACTS.pluginId, pageId: FACTS.contributionId, area: 'pinned' } } } } });
        expect((await transport.read('singleton'))?.body).toContain('copy');
        const before = row;
        // Retirement during the real Artifact read must prevent the subsequent write.
        onRead = () => controller.dispose();
        await controller.hostApi.handleRequest(request('widgetArea', { area: 'pinned', operation: { actionId: 'widgets.item.remove', instanceId: 'copy' } }));
        expect(row).toBe(before);
        expect(await controller.hostApi.handleRequest(request('widgetArea', { area: 'pinned', operation: { actionId: 'widgets.item.remove', instanceId: 'copy' } })))
            .toMatchObject({ code: 'stale_surface' });
        expect(row).toBe(before);
        expect(createBoundPluginSurfaceController({ facts: FACTS }).installedMethods).not.toContain('widgetArea');
    });
    it('passes the raw client target to the canonical dispatcher before daemon availability', async () => {
        const executeContributedAction = vi.fn();
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                daemonInteractionEnabled: false,
                resolveContributedAction: resolveClientTargetAction,
            },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'refresh-index',
            input: {},
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_client_action_unavailable'],
        });
        expect(executeContributedAction).not.toHaveBeenCalled();
    });

    it('refuses an Action the daemon projection reports as not currently available', async () => {
        const executeContributedAction = vi.fn();
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                daemonInteractionEnabled: false,
                resolveContributedAction: resolveUnavailableClientTargetAction,
            },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        // Same identity, same target, same transport state as the positive
        // twin above — only `available` differs, so this discriminates the
        // fail-closed executability rule from every other refusal.
        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'refresh-index',
            input: {},
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_action_projection_unavailable'],
        });
        expect(executeContributedAction).not.toHaveBeenCalled();
    });

    it('keeps raw daemon reachability factual when projection admission disables actions', async () => {
        const { restoreServerAccountForTest, installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        const { createHomeHubArtifactHttpBoundary } = await import('@/dev/testkit/harness/homeHubArtifactHttpBoundary');
        installDisconnectedServerSocketBoundary();
        const http = createHomeHubArtifactHttpBoundary('account-a');
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://bound-controller-home',
            accountId: 'account-a', request: http.request });
        const previousState = storage.getState();
        try {
            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    endpointStatus: 'online',
                    machines: {
                        ...state.machines,
                        'machine_1': createMachineFixture({
                            id: 'machine_1',
                            active: true,
                            activeAt: Date.now(),
                            daemonStateVersion: 13,
                        }),
                    },
                    machineListByServerId: { ...state.machineListByServerId,
                        [connection.home.id]: [createMachineFixture({ id: 'machine_1', active: true,
                            activeAt: Date.now(), daemonStateVersion: 13 })] },
                    machineListStatusByServerId: { ...state.machineListStatusByServerId, [connection.home.id]: 'idle' },
                }));
            });
            const hook = await renderHook(() => usePluginSurfaceDaemonInteraction({
                machineId: 'machine_1',
                projectionInteractionEnabled: false,
            }));

            // A projection can withhold Action/Resource admission while the
            // exact daemon remains reachable for its separately-owned Settings
            // target. Collapsing these facts would suppress that read.
            expect(hook.getCurrent()).toEqual({
                endpointOnline: true,
                hasAddressedMachine: true,
                daemonReachable: true,
                enabled: false,
                daemonStateVersion: 13,
            });
            await hook.unmount();
        } finally {
            await act(async () => {
                storage.setState(previousState);
            });
            await connection.dispose();
        }
    });

    it('fails closed when the mount has no captured active Account lifetime', () => {
        const executeContributedAction = vi.fn();
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, accountLifetime: null },
            binding: { executeContributedAction: executeContributedAction as never,
                executeHostAction: Object.assign(executor.execute, { prepare: executor.prepare }) },
        });

        // An absent Account scope is not an implicit global lifetime. The facade
        // must neither advertise handlers nor answer even its local context.
        expect(controller.isCurrent()).toBe(false);
        expect(controller.installedMethods).toEqual([]);
        expect(controller.resourceStore).toBeUndefined();
        expect(controller.interactive).toBe(false);
        expect(controller.hostApi.handleRequest(request('context'))).toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(executeContributedAction).not.toHaveBeenCalled();
    });

    it('publishes qualified data through the exact mounted Host API and distinguishes null from an absent payload', async () => {
        const publication = {
            publish: vi.fn(() => true),
            clear: vi.fn(),
            restore: vi.fn(),
            dispose: vi.fn(),
        };
        const createMountedHostApiHandlers = vi.fn(() => ({
            handlers: {},
            currentUiContext: publication,
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { createMountedHostApiHandlers } as never,
        });
        const enrichment = {
            entity: {
                kind: 'issue',
                label: 'Issue A',
                reference: { number: 1 },
            },
            detail: { state: 'open' },
            commands: [{
                title: 'Open issue B',
                description: 'Navigate to the related issue',
                command: {
                    kind: 'openSurface',
                    destination: 'issues',
                    input: { issueNumber: 2 },
                },
            }],
        };

        expect(controller.installedMethods).toContain('publishCurrentUiContext');
        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment,
        })))).resolves.toBeNull();
        expect(publication.publish).toHaveBeenCalledWith({
            entity: enrichment.entity,
            detail: enrichment.detail,
            commands: [{
                title: 'Open issue B',
                description: 'Navigate to the related issue',
                command: {
                    kind: 'openSurface',
                    destination: { pluginId: FACTS.pluginId, localId: 'issues' },
                    input: { issueNumber: 2 },
                },
            }],
        });

        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: null,
        })))).resolves.toBeNull();
        expect(publication.publish).toHaveBeenLastCalledWith(null);

        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {})))).resolves.toEqual({
            code: 'invalid_payload',
            diagnostics: ['plugin_current_ui_context_payload_invalid'],
        });
        expect(publication.publish).toHaveBeenCalledTimes(2);

        controller.clearCurrentUiContext();
        expect(publication.clear).toHaveBeenCalledTimes(1);
        controller.dispose();
        expect(publication.dispose).toHaveBeenCalledTimes(1);
    });

    it('does not admit a competing mounted publish handler without the controller-bound publication capability', async () => {
        const forbiddenPublish = vi.fn(() => ({ accepted: true }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                mountedHostApiHandlers: {
                    publishCurrentUiContext: forbiddenPublish,
                },
            },
        });

        expect(controller.installedMethods).not.toContain('publishCurrentUiContext');
        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Bypass' } },
        })))).resolves.toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:publishCurrentUiContext'],
        });
        expect(forbiddenPublish).not.toHaveBeenCalled();
    });

    it('retires an A publication before B can publish and fences late A work', async () => {
        const publications: Array<{
            publish: ReturnType<typeof vi.fn>;
            clear: ReturnType<typeof vi.fn>;
            restore: ReturnType<typeof vi.fn>;
            dispose: ReturnType<typeof vi.fn>;
        }> = [];
        const createMountedHostApiHandlers = vi.fn(() => {
            const publication = {
                publish: vi.fn(() => true),
                clear: vi.fn(),
                restore: vi.fn(),
                dispose: vi.fn(),
            };
            publications.push(publication);
            return {
                handlers: {},
                currentUiContext: publication,
            };
        });
        const binding = { createMountedHostApiHandlers } as never;
        const hook = await renderHook(
            (sessionId: string) => useBoundPluginSurfaceController({
                facts: { ...FACTS, sessionId },
                binding,
            }),
            { initialProps: 'session-a' },
        );
        const first = hook.getCurrent();

        await expect(Promise.resolve(first.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Issue A' } },
        })))).resolves.toBeNull();
        expect(publications[0]?.publish).toHaveBeenCalledTimes(1);

        const second = await hook.rerender('session-b');
        expect(first.isCurrent()).toBe(false);
        expect(publications[0]?.dispose).toHaveBeenCalledTimes(1);
        await expect(Promise.resolve(first.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Late A' } },
        })))).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(publications[0]?.publish).toHaveBeenCalledTimes(1);

        await expect(Promise.resolve(second.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Issue B' } },
        })))).resolves.toBeNull();
        expect(publications[1]?.publish).toHaveBeenCalledTimes(1);
        await hook.unmount();
        expect(publications[1]?.dispose).toHaveBeenCalledTimes(1);
    });

    it('keeps the facade while interaction and the current Action resolver change, and refuses withdrawn Actions', async () => {
        const execute = vi.fn<NonNullable<BoundPluginSurfaceBinding['executeContributedAction']>>();
        const hook = await renderHook((input: Readonly<{ enabled: boolean; available: boolean }>) => (
            useBoundPluginSurfaceController({
                facts: { ...FACTS, interactionEnabled: input.enabled, daemonInteractionEnabled: false,
                    resolveContributedAction: input.available ? resolveClientTargetAction : resolveUnavailableClientTargetAction },
                binding: { executeContributedAction: execute },
            })
        ), { initialProps: { enabled: true, available: true } });
        const first = hook.getCurrent();
        await hook.rerender({ enabled: false, available: true });
        expect(hook.getCurrent()).toBe(first);
        expect(await first.hostApi.handleRequest(request('executeAction', { action: 'refresh-index', input: {} })))
            .toMatchObject({ code: 'unavailable' });
        await hook.rerender({ enabled: true, available: false });
        expect(hook.getCurrent()).toBe(first);
        expect(await first.hostApi.handleRequest(request('executeAction', { action: 'refresh-index', input: {} })))
            .toEqual({ code: 'unavailable', diagnostics: ['plugin_surface_action_projection_unavailable'] });
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([false, true])('keeps a cold mount current through projection admission without freezing selection facts (operations: %s)', async (hasOperations) => {
        const contributor = { pluginId: 'acme.provider', contributionId: 'setup', occurrenceId: 'provider-a',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'provider-root' } };
        const operation = { point: { pointId: 'providers', protocol: { id: 'providers', version: 1 } },
            contributor, role: 'setup' as const, action: { pluginId: contributor.pluginId, localId: 'configure' } };
        const target: PluginUiTargetedContributionsV1 = {
            target: { pluginId: FACTS.pluginId, occurrenceId: FACTS.occurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'browser-root' } },
            points: hasOperations ? [{ pointId: operation.point.pointId, protocols: [{
                protocol: operation.point.protocol, contributions: [{ contributor,
                    protocol: operation.point.protocol, operations: [operation], surfaces: [] }],
            }] }] : [],
        };
        const publication = createPluginActionInputSelectionFactsPublication();
        const hook = await renderHook((admitted: boolean) => useBoundPluginSurfaceController({ facts: {
            ...FACTS, targetedContributions: target, pluginProjectionById: admitted ? {} : null,
            actionInputSelectionFactsKey: publication.publish({ targetPluginId: FACTS.pluginId,
                targetedContributions: target, pluginProjectionById: admitted ? {} : null }),
        } }), { initialProps: false });
        const first = hook.getCurrent();
        expect(await first.hostApi.handleRequest(request('selectActionInput', { operation })))
            .toMatchObject({ code: 'unavailable', diagnostics: ['host_unavailable'] });

        const admitted = await hook.rerender(true);
        expect(admitted).toBe(first);
        expect(first.isCurrent()).toBe(true);
        expect(await first.hostApi.handleRequest(request('selectActionInput', { operation })))
            .toMatchObject(hasOperations
                ? { code: 'stale_surface', diagnostics: ['action_retired'] }
                : { code: 'unavailable', diagnostics: ['action_not_found'] });
        const withdrawn = await hook.rerender(false);
        if (hasOperations) {
            expect(withdrawn).not.toBe(first);
            expect(first.isCurrent()).toBe(false);
        } else {
            expect(withdrawn).toBe(first);
            expect(await first.hostApi.handleRequest(request('selectActionInput', { operation })))
                .toMatchObject({ code: 'unavailable', diagnostics: ['host_unavailable'] });
        }
        await hook.unmount();
    });

    it('keeps a replacement Session controller through its own first projection admission', async () => {
        const contributor = { pluginId: 'acme.provider', contributionId: 'setup', occurrenceId: 'provider-a',
            sourceCustody: { kind: 'development' as const, registeredRootId: 'provider-root' } };
        const operation = { point: { pointId: 'providers', protocol: { id: 'providers', version: 1 } },
            contributor, role: 'setup' as const, action: { pluginId: contributor.pluginId, localId: 'configure' } };
        const target: PluginUiTargetedContributionsV1 = {
            target: { pluginId: FACTS.pluginId, occurrenceId: FACTS.occurrenceId,
                sourceCustody: { kind: 'development', registeredRootId: 'browser-root' } },
            points: [{ pointId: operation.point.pointId, protocols: [{
                protocol: operation.point.protocol, contributions: [{ contributor,
                    protocol: operation.point.protocol, operations: [operation], surfaces: [] }],
            }] }],
        };
        const publication = createPluginActionInputSelectionFactsPublication();
        const hook = await renderHook((props: { sessionId: string; admitted: boolean }) => useBoundPluginSurfaceController({ facts: {
            ...FACTS, sessionId: props.sessionId, targetedContributions: target,
            pluginProjectionById: props.admitted ? {} : null,
            actionInputSelectionFactsKey: publication.publish({ targetPluginId: FACTS.pluginId,
                targetedContributions: target, pluginProjectionById: props.admitted ? {} : null }),
        } }), { initialProps: { sessionId: 'session-a', admitted: true } });
        const first = hook.getCurrent();

        const coldReplacement = await hook.rerender({ sessionId: 'session-b', admitted: false });
        expect(coldReplacement).not.toBe(first);
        expect(first.isCurrent()).toBe(false);
        expect(await coldReplacement.hostApi.handleRequest(request('selectActionInput', { operation })))
            .toMatchObject({ code: 'unavailable', diagnostics: ['host_unavailable'] });

        const admittedReplacement = await hook.rerender({ sessionId: 'session-b', admitted: true });
        expect(admittedReplacement).toBe(coldReplacement);
        expect(coldReplacement.isCurrent()).toBe(true);
        expect(await coldReplacement.hostApi.handleRequest(request('selectActionInput', { operation })))
            .toMatchObject({ code: 'stale_surface', diagnostics: ['action_retired'] });
        await hook.unmount();
    });

    it('replaces and retires the controller when its exact Session identity changes', async () => {
        const hook = await renderHook(
            (sessionId: string) => useBoundPluginSurfaceController({
                facts: { ...FACTS, sessionId },
            }),
            { initialProps: 'session-1' },
        );
        const first = hook.getCurrent();

        const second = await hook.rerender('session-2');

        expect(second).not.toBe(first);
        expect(first.isCurrent()).toBe(false);
        expect(second.surfaceContext.sessionId).toBe('session-2');
    });

    it('replaces and retires the controller when its private target authority changes under one Session', async () => {
        const hook = await renderHook(
            (targetAuthorityKey: string) => useBoundPluginSurfaceController({
                facts: {
                    ...FACTS,
                    sessionId: 'session-1',
                    targetAuthorityKey,
                },
            }),
            { initialProps: '["browser","target-a",null]' },
        );
        const first = hook.getCurrent();

        const second = await hook.rerender('["browser","target-b",null]');

        expect(second).not.toBe(first);
        expect(first.isCurrent()).toBe(false);
        // The private key fences the facade only; it must not mutate the
        // controller's public Protocol surface identity into a second target
        // representation.
        expect(second.surfaceContext.sessionId).toBe('session-1');
    });

    it('keeps one controller for equivalent daemon target snapshots and retires it for semantic projection or target-generation replacement', async () => {
        let projectionTraversals = 0;
        const selectedBundleInput = { en: { 'action.title': 'Configure browser' } };
        const objectKeys = vi.spyOn(Object, 'keys');
        const objectDescriptors = vi.spyOn(Object, 'getOwnPropertyDescriptors');
        onTestFinished(() => { objectKeys.mockRestore(); objectDescriptors.mockRestore(); });
        const selectedBundles = projectNativeJsonValueForTransport(selectedBundleInput) as typeof selectedBundleInput;
        const unrelatedBundleInput = { en: Object.fromEntries(
            Array.from({ length: 1024 }, (_, index) => [`unrelated.${index}`, 'Unrelated catalog text '.repeat(8)]),
        ) };
        const unrelatedBundles = projectNativeJsonValueForTransport(unrelatedBundleInput) as typeof unrelatedBundleInput;
        const pluginUiProjection: PluginUiProjectionModel = Object.freeze({
            ...EMPTY_PLUGIN_UI_PROJECTION,
            translationsByPluginId: Object.freeze({
                'acme.browser': { id: 'translations:acme.browser', pluginId: 'acme.browser',
                    contributionKind: 'translations' as const, locales: ['en'], bundles: selectedBundles },
                'acme.unrelated': { id: 'translations:acme.unrelated', pluginId: 'acme.unrelated',
                    contributionKind: 'translations' as const, locales: ['en'], bundles: unrelatedBundles },
            }),
            // Observe real materialization of an immutable public input, not
            // the serializer implementation or an incidental invocation count.
            unknownEntriesById: new Proxy(EMPTY_PLUGIN_UI_PROJECTION.unknownEntriesById, {
                ownKeys(target) {
                    projectionTraversals += 1;
                    return Reflect.ownKeys(target);
                },
            }),
        });
        // One real boundary preparation is necessary; no renderer/selector
        // may rewalk that prepared bundle. Both spies delegate unchanged.
        const selectedTranslationTraversals = () => objectKeys.mock.calls.filter(([value]) => value === selectedBundles).length
            + objectDescriptors.mock.calls.filter(([value]) => value === selectedBundleInput).length;
        const unrelatedTranslationTraversals = () => objectKeys.mock.calls.filter(([value]) => value === unrelatedBundles).length;
        const sourcePublication = createPluginActionInputSelectionFactsPublication();
        const publishFacts = (facts: Readonly<{
            targetedContributions: PluginUiTargetedContributionsV1;
            pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>>;
            pluginUiProjection: PluginUiProjectionModel;
        }>) => ({ ...facts, actionInputSelectionFactsKey: sourcePublication.publish({
            targetPluginId: FACTS.pluginId, targetedContributions: facts.targetedContributions,
            pluginProjectionById: facts.pluginProjectionById,
            translationsByPluginId: facts.pluginUiProjection.translationsByPluginId,
        }) });
        const daemonFactsFor = (input: Readonly<{
            targetGeneration: string;
            actionTitle: string;
            unrelatedTitle: string;
        }>) => {
            const operation = {
                point: { pointId: 'review', protocol: { id: 'review', version: 1 } },
                contributor: {
                    pluginId: FACTS.pluginId,
                    contributionId: 'review',
                    occurrenceId: 'review-contributor-generation-a',
                    sourceCustody: { kind: 'development' as const, registeredRootId: 'browser-root' },
                },
                role: 'setup' as const,
                action: { pluginId: FACTS.pluginId, localId: 'configure' },
            };
            const targetedContributions = {
                target: {
                    pluginId: FACTS.pluginId,
                    occurrenceId: input.targetGeneration,
                    sourceCustody: { kind: 'development', registeredRootId: 'browser-root' },
                },
                points: [{
                    pointId: operation.point.pointId,
                    protocols: [{
                        protocol: operation.point.protocol,
                        contributions: [{
                            contributor: operation.contributor,
                            protocol: operation.point.protocol,
                            operations: [operation],
                            surfaces: [],
                        }],
                    }],
                }],
            } satisfies PluginUiTargetedContributionsV1;
            const pluginProjectionById = {
                [FACTS.pluginId]: {
                    pluginId: FACTS.pluginId,
                    immutableGenerationId: input.targetGeneration,
                    title: 'Browser',
                    description: null,
                    version: '1.0.0',
                    enabled: true,
                    generation: 12,
                    generationLabel: '12',
                    status: null,
                    provenance: null,
                    diagnostics: [],
                    actions: [{
                        id: operation.action.localId,
                        occurrenceId: 'review-contributor-generation-a',
                        title: input.actionTitle,
                        description: null,
                        icon: null,
                        scopes: [],
                        surfaces: ['plugin'],
                        placementBindings: [],
                        inputHints: null,
                        slash: null,
                        priority: null,
                        dangerLevel: 'safe',
                        confirmation: null,
                        available: true,
                    }],
                    resources: [],
                    editableSettingsGroups: [],
                },
                'acme.unrelated': {
                    pluginId: 'acme.unrelated',
                    immutableGenerationId: 'unrelated-generation-a',
                    title: input.unrelatedTitle,
                    description: null,
                    version: '1.0.0',
                    enabled: true,
                    generation: 12,
                    generationLabel: '12',
                    status: null,
                    provenance: null,
                    diagnostics: [],
                    actions: [],
                    resources: [],
                    editableSettingsGroups: [],
                },
            } satisfies Readonly<Record<string, PluginProjectionEntry>>;
            return publishFacts({
                targetedContributions: projectNativeJsonValueForTransport(targetedContributions) as typeof targetedContributions,
                pluginProjectionById: projectNativeJsonValueForTransport(pluginProjectionById) as typeof pluginProjectionById,
                pluginUiProjection,
            });
        };
        const initialDaemonFacts = daemonFactsFor({
            targetGeneration: 'browser-generation-a',
            actionTitle: 'Configure browser',
            unrelatedTitle: 'Unrelated initial',
        });
        const hook = await renderHook(
            (daemonFacts: ReturnType<typeof daemonFactsFor>) => useBoundPluginSurfaceController({
                facts: { ...FACTS, ...daemonFacts },
            }),
            { initialProps: initialDaemonFacts },
        );
        const first = hook.getCurrent();
        const firstRetirement = vi.fn();
        first.onRetire(firstRetirement);

        const initialTraversals = projectionTraversals;
        expect(initialTraversals).toBe(0);
        // A mounted selector cannot consume another plugin's translations.
        // Catalog growth must not grow its render-time serialization work.
        expect(unrelatedTranslationTraversals()).toBe(0);
        expect(selectedTranslationTraversals()).toBe(1);
        const unchanged = await hook.rerender(initialDaemonFacts);
        // Settled parent refreshes must not repeatedly walk an unchanged
        // projection, and must preserve its mounted interaction lifetime.
        expect(projectionTraversals).toBe(initialTraversals);
        expect(unchanged).toBe(first);
        expect(first.isCurrent()).toBe(true);
        expect(firstRetirement).not.toHaveBeenCalled();

        for (let index = 0; index < 12; index += 1) {
            const refreshed = await hook.rerender(publishFacts({
                ...initialDaemonFacts,
                pluginUiProjection: { ...pluginUiProjection, generation: index },
            }));
            expect(refreshed).toBe(first);
        }
        // Producer delivery changes retain the same consumed immutable inputs.
        expect(selectedTranslationTraversals()).toBe(1);
        expect(unrelatedTranslationTraversals()).toBe(0);

        for (let index = 0; index < 100; index += 1) {
            const refreshed = await hook.rerender(publishFacts({
                ...initialDaemonFacts,
                pluginProjectionById: {
                    ...initialDaemonFacts.pluginProjectionById,
                    'acme.unrelated': { ...initialDaemonFacts.pluginProjectionById['acme.unrelated'], title: `Unrelated ${index}` },
                },
            }));
            expect(refreshed).toBe(first);
        }
        // A publication for an unrelated contributor does not change this
        // selector's immutable target, Action declarations or text bundles.
        expect(selectedTranslationTraversals()).toBe(1);
        expect(unrelatedTranslationTraversals()).toBe(0);

        const equivalentDaemonFacts = daemonFactsFor({
            targetGeneration: 'browser-generation-a',
            actionTitle: 'Configure browser',
            unrelatedTitle: 'Unrelated initial',
        });
        expect(equivalentDaemonFacts.targetedContributions).not.toBe(initialDaemonFacts.targetedContributions);
        expect(equivalentDaemonFacts.pluginProjectionById).not.toBe(initialDaemonFacts.pluginProjectionById);
        const equivalent = await hook.rerender(equivalentDaemonFacts);

        // Daemon responses reconstruct maps and target snapshots. Object identity
        // is not a currentness fact: the mount, facade, and subscriptions remain.
        expect(equivalent).toBe(first);
        expect(equivalent.hostApi).toBe(first.hostApi);
        expect(first.isCurrent()).toBe(true);
        expect(firstRetirement).not.toHaveBeenCalled();

        const unrelatedDaemonFacts = daemonFactsFor({
            targetGeneration: 'browser-generation-a',
            actionTitle: 'Configure browser',
            unrelatedTitle: 'Unrelated revised',
        });
        const unrelatedProjectionRefresh = await hook.rerender(unrelatedDaemonFacts);
        // The target snapshot cannot select this plugin, so its independent
        // projection update must not retire the mount or its subscriptions.
        expect(unrelatedProjectionRefresh).toBe(first);
        expect(first.isCurrent()).toBe(true);
        expect(firstRetirement).not.toHaveBeenCalled();

        const projectionReplacementFacts = publishFacts({
            ...unrelatedDaemonFacts,
            pluginProjectionById: daemonFactsFor({
                targetGeneration: 'browser-generation-a',
                actionTitle: 'Configure revised browser',
                unrelatedTitle: 'Unrelated revised',
            }).pluginProjectionById,
        });
        const projectionReplacement = await hook.rerender(projectionReplacementFacts);
        expect(projectionReplacement).not.toBe(first);
        expect(first.isCurrent()).toBe(false);
        expect(firstRetirement).toHaveBeenCalledTimes(1);

        const targetReplacementFacts = publishFacts({
            ...projectionReplacementFacts,
            targetedContributions: daemonFactsFor({
                targetGeneration: 'browser-generation-b',
                actionTitle: 'Configure revised browser',
                unrelatedTitle: 'Unrelated revised',
            }).targetedContributions,
        });
        const targetReplacement = await hook.rerender(targetReplacementFacts);
        expect(targetReplacement).not.toBe(projectionReplacement);
        expect(projectionReplacement.isCurrent()).toBe(false);
        expect(targetReplacement.isCurrent()).toBe(true);

        const uiProjectionReplacement = await hook.rerender(publishFacts({
            ...targetReplacementFacts,
            pluginUiProjection: Object.freeze({
                ...pluginUiProjection,
                unknownEntriesById: Object.freeze({ 'future-entry': Object.freeze({ title: 'New projection fact' }) }),
            }),
        }));
        // Unknown future entries are not Action-input presentation facts and
        // must not retire the surface. Its consumed translation bundle is.
        expect(uiProjectionReplacement).toBe(targetReplacement);
        expect(targetReplacement.isCurrent()).toBe(true);
        expect(uiProjectionReplacement.isCurrent()).toBe(true);
        const translatedFacts = publishFacts({
            ...targetReplacementFacts,
            pluginUiProjection: { ...pluginUiProjection, translationsByPluginId: {
                'acme.browser': { id: 'translations:acme.browser', pluginId: 'acme.browser',
                    contributionKind: 'translations', locales: ['en'], bundles: { en: { 'action.title': 'Configure revised browser' } } },
            } },
        });
        const translatedProjection = await hook.rerender(translatedFacts);
        expect(translatedProjection).not.toBe(targetReplacement);
        expect(targetReplacement.isCurrent()).toBe(false);
        const selectedPlugin = translatedFacts.pluginProjectionById[FACTS.pluginId]!;
        const changedHints = await hook.rerender(publishFacts({ ...translatedFacts, pluginProjectionById: {
            ...translatedFacts.pluginProjectionById,
            [FACTS.pluginId]: { ...selectedPlugin, actions: selectedPlugin.actions.map(action => ({ ...action,
                inputHints: { fields: [{ path: 'repository', title: 'Repository', widget: 'text', required: true }] },
            })) },
        } }));
        expect(changedHints).not.toBe(translatedProjection);
        expect(translatedProjection.isCurrent()).toBe(false);
        expect(changedHints.isCurrent()).toBe(true);
        await hook.unmount();
    });

    it('retires a no-operation controller when caller custody changes under the same origin and occurrence', async () => {
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'caller-root-a' };
        const targetedContributions = { target: { pluginId: FACTS.pluginId, occurrenceId: FACTS.occurrenceId,
            sourceCustody }, points: [] };
        const source = { ...FACTS, targetedContributions, targetSourceCustody: sourceCustody,
            actionInputSelectionFactsKey: createPluginActionInputSelectionFactsPublication().publishEmpty({
                hasPluginProjection: true, hasTargetedContributions: true,
            }) };
        const hook = await renderHook((facts: typeof source) => useBoundPluginSurfaceController({ facts }), { initialProps: source });
        const initial = hook.getCurrent();
        const unchanged = await hook.rerender({ ...source });
        expect(unchanged).toBe(initial);
        const replacementCustody = { kind: 'development' as const, registeredRootId: 'caller-root-b' };
        const changed = await hook.rerender({ ...source, targetSourceCustody: replacementCustody,
            targetedContributions: { ...targetedContributions, target: { ...targetedContributions.target, sourceCustody: replacementCustody } } });
        expect(changed).not.toBe(initial);
        expect(initial.isCurrent()).toBe(false);
        expect(changed.isCurrent()).toBe(true);
        expect(changed.surfaceContext).toEqual(initial.surfaceContext);
        await hook.unmount();
    });

    it('keeps the physical caller while replacing only the targeted Resource view for changed launch input', async () => {
        const hook = await renderHook(
            (launchInput: PluginUiJsonValueV1) => {
                const facts = {
                    ...FACTS,
                    resourceContext: createTargetedSurfaceResourceContext(launchInput),
                };
                return useBoundPluginSurfaceController({ facts });
            },
            { initialProps: { reviewId: 'review-a' } },
        );
        const first = hook.getCurrent();
        const firstStore = first.resourceStore;

        const same = await hook.rerender({ reviewId: 'review-a' });

        // A parent refresh must not replace the existing Resource watch just
        // because it reconstructed equivalent JSON input.
        expect(same).toBe(first);
        expect(same.resourceStore).toBe(firstStore);

        const replacement = await hook.rerender({ reviewId: 'review-b' });

        expect(replacement).toBe(first);
        expect(replacement.resourceStore).not.toBe(firstStore);
        expect(first.isCurrent()).toBe(true);
        await hook.unmount();
    });

    it('forwards the exact host-stamped targeted Resource context through a mounted snapshot read', async () => {
        const requests: unknown[] = [];
        const context = createTargetedSurfaceResourceContext({ reviewId: 'review-a' });
        const read: PluginSurfaceResourceReadTransport = async (machineId, options) => {
            requests.push({ machineId, ...options });
            return {
                supported: true,
                result: {
                    ok: true,
                    resource: options.resource,
                    kind: 'asset',
                    contentType: 'text/plain',
                    digest: `sha256:${'a'.repeat(64)}`,
                    bytesBase64: 'b2s=',
                },
            };
        };
        const facts = { ...FACTS, resourceContext: context };
        const controller = createBoundPluginSurfaceController({
            facts,
            binding: { readResource: read },
        });

        await expect(controller.hostApi.handleRequest(request('readResource', {
            resource: 'review-summary',
        }))).resolves.toMatchObject({ contentType: 'text/plain' });
        expect(requests).toEqual([expect.objectContaining({
            machineId: 'machine_1',
            callerPluginId: FACTS.pluginId,
            expectedCallerOccurrenceId: FACTS.occurrenceId,
            resource: { pluginId: FACTS.pluginId, localId: 'review-summary' },
            context,
        })]);
        controller.dispose();
    });

    it('refreshes repeated legacy contextual protocol reads while retaining the existing Resource entry', async () => {
        const initialBytes = 'e30=';
        const refreshedBytes = 'eyJyZXZpc2lvbiI6Mn0=';
        const read = vi.fn<PluginSurfaceResourceReadTransport>(async (_machineId, options) => ({ supported: true,
            result: { ok: true, resource: options.resource, kind: 'asset', contentType: 'application/json',
                digest: `sha256:${'a'.repeat(64)}`, bytesBase64: initialBytes } }));
        const controller = createBoundPluginSurfaceController({ facts: { ...FACTS,
            resourceContext: createTargetedSurfaceResourceContext({ reviewId: 'review-a' }),
        }, binding: { readResource: read } });
        const entry = controller.resourceStore!.getEntry('review-summary');
        const release = entry.subscribe(() => {}, false);
        try {
            await vi.waitFor(() => expect(entry.getSnapshot().value).toBeDefined());
            await expect(controller.hostApi.handleRequest(request('readResource', { resource: 'review-summary' })))
                .resolves.toMatchObject({ bytesBase64: initialBytes });
            read.mockClear();
            read.mockImplementation(async (_machineId, options) => ({ supported: true,
                result: { ok: true, resource: options.resource, kind: 'asset', contentType: 'application/json',
                    digest: `sha256:${'b'.repeat(64)}`, bytesBase64: refreshedBytes } }));
            await expect(controller.hostApi.handleRequest(request('readResource', { resource: 'review-summary' })))
                .resolves.toMatchObject({ bytesBase64: refreshedBytes });
            expect(read).toHaveBeenCalledTimes(1);
            expect(controller.resourceStore!.getEntry('review-summary')).toBe(entry);
            expect(new TextDecoder().decode(entry.getSnapshot().value!.bytes)).toBe('{"revision":2}');
        } finally { release(); controller.dispose(); }
    });

    it('fences a targeted Resource read that settles after same-mount launch input replacement', async () => {
        let settle: ((value: unknown) => void) | undefined;
        const read = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
        const hook = await renderHook(
            (launchInput: PluginUiJsonValueV1) => {
                const facts = {
                    ...FACTS,
                    resourceContext: createTargetedSurfaceResourceContext(launchInput),
                };
                return useBoundPluginSurfaceController({
                    facts,
                    binding: { readResource: read as never },
                });
            },
            { initialProps: { reviewId: 'review-a' } },
        );
        const original = hook.getCurrent();
        const pending = original.hostApi.handleRequest(request('readResource', {
            resource: 'review-summary',
        }));
        expect(read).toHaveBeenCalledTimes(1);

        await hook.rerender({ reviewId: 'review-b' });
        expect(hook.getCurrent()).toBe(original);
        expect(original.isCurrent()).toBe(true);
        settle!({
            supported: true,
            result: {
                ok: true,
                contentType: 'text/plain',
                digest: `sha256:${'b'.repeat(64)}`,
                bytesBase64: 'b2s=',
            },
        });

        await expect(pending).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_retired'],
        });
        await hook.unmount();
    });

    it('aborts an in-flight unscoped contextual Resource read when input changes without retiring its controller', async () => {
        let resourceSignal: AbortSignal | undefined;
        const read: PluginSurfaceResourceReadTransport = async (_machineId, options) => {
            resourceSignal = options.signal;
            return await new Promise((resolve) => {
                options.signal?.addEventListener('abort', () => {
                    resolve({ supported: false, reason: 'aborted' });
                }, { once: true });
            });
        };
        const hook = await renderHook(
            (launchInput: PluginUiJsonValueV1) => {
                const facts = {
                    ...FACTS,
                    resourceContext: createTargetedSurfaceResourceContext(launchInput),
                };
                return useBoundPluginSurfaceController({
                    facts,
                    binding: { readResource: read },
                });
            },
            { initialProps: { reviewId: 'review-a' } },
        );
        const original = hook.getCurrent();
        const pending = original.hostApi.handleRequest(request('readResource', {
            resource: 'review-summary',
        }));
        await vi.waitFor(() => { expect(resourceSignal).toBeDefined(); });

        await hook.rerender({ reviewId: 'review-b' });

        expect(hook.getCurrent()).toBe(original);
        expect(original.isCurrent()).toBe(true);
        expect(resourceSignal?.aborted).toBe(true);
        await expect(pending).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_retired'],
        });
        await hook.unmount();
    });

    it('composes caller cancellation into an otherwise-current targeted Resource read', async () => {
        let resourceSignal: AbortSignal | undefined;
        const read: PluginSurfaceResourceReadTransport = async (_machineId, options) => {
            resourceSignal = options.signal;
            return await new Promise((resolve) => {
                options.signal?.addEventListener('abort', () => {
                    resolve({ supported: false, reason: 'aborted' });
                }, { once: true });
            });
        };
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                resourceContext: createTargetedSurfaceResourceContext({ reviewId: 'review-a' }),
            },
            binding: { readResource: read },
        });
        const caller = new AbortController();
        const pending = controller.hostApi.handleRequest(
            request('readResource', { resource: 'review-summary' }),
            { signal: caller.signal },
        );
        await vi.waitFor(() => { expect(resourceSignal).toBeDefined(); });
        expect(controller.isCurrent()).toBe(true);

        caller.abort();

        expect(resourceSignal?.aborted).toBe(true);
        await expect(pending).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_resource_aborted'],
        });
        expect(controller.isCurrent()).toBe(true);
        controller.dispose();
    });

    it.each([false, true])('host-stamps the currently admitted exact machine for detached execution.run Actions (initially ready: %s)', async initiallyReady => {
        let daemonReady = initiallyReady;
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { runId: 'run_1' } }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, isDaemonInteractionEnabled: () => daemonReady },
            binding: { executeHostAction },
        });

        daemonReady = true;
        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'execution.run.start',
            input: {
                sessionId: null,
                intent: 'delegate',
                backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
                permissionMode: 'read_only',
                retentionPolicy: 'ephemeral',
                runClass: 'bounded',
                ioMode: 'request_response',
            },
        }))).resolves.toEqual({ runId: 'run_1' });

        expect(executeHostAction).toHaveBeenCalledWith(
            'execution.run.start',
            expect.objectContaining({ sessionId: null }),
            expect.objectContaining({
                serverId: 'server-1',
                executionRunTargetMachineId: 'machine_1',
                surface: 'plugin',
                actionCaller: {
                    kind: 'plugin',
                    pluginId: FACTS.pluginId,
                    contributionLocalId: FACTS.contributionId,
                    occurrenceId: FACTS.occurrenceId,
                    materialization: FACTS.executionOrigin.materializationRef,
                },
            }),
        );
        daemonReady = false;
        await controller.dispatchAction('session.board.get', {});
        expect(executeHostAction).toHaveBeenLastCalledWith('session.board.get', {},
            expect.not.objectContaining({ executionRunTargetMachineId: 'machine_1' }));
        controller.dispose();
    });

    it('preserves exact source custody in mounted host Action provenance', async () => {
        const sourceCustody = { kind: 'development' as const, registeredRootId: 'source-root' };
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { items: [] } }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, sessionId: 'session-mounted', executionOrigin: { serverIdentityId: 'server-1', sourceRef: {
                machineId: 'machine_1', pluginId: FACTS.pluginId, sourceCustody,
            } } },
            binding: { executeHostAction },
        });
        await expect(controller.dispatchAction('session.board.get', {})).resolves.toEqual({ items: [] });
        expect(executeHostAction).toHaveBeenCalledWith('session.board.get', {}, expect.objectContaining({
            actionCaller: { kind: 'plugin', pluginId: FACTS.pluginId, contributionLocalId: FACTS.contributionId,
                occurrenceId: FACTS.occurrenceId, sourceCustody },
        }));
        controller.dispose();
    });

    it('dispatches an originless bundled self-check by its exact mounted occurrence', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { ok: true } },
        }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, executionOrigin: null },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: { pluginId: FACTS.pluginId, localId: 'self-check' },
            input: {},
        }))).resolves.toEqual({ ok: true });

        expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: 'daemon-action-occurrence-a',
            qualifiedActionId: `${FACTS.pluginId}/self-check`,
            signal: expect.any(AbortSignal),
            isCurrent: expect.any(Function),
            input: {},
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    pluginId: FACTS.pluginId,
                    contributionLocalId: FACTS.contributionId,
                    occurrenceId: FACTS.occurrenceId,
                },
            },
        });
    });

    it('host-stamps the mounted exact Session for contextual Board Actions', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { items: [] } }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, sessionId: 'session-mounted' },
            binding: { executeHostAction },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'session.board.get',
            input: {},
        }))).resolves.toEqual({ items: [] });

        expect(executeHostAction).toHaveBeenCalledWith(
            'session.board.get',
            {},
            expect.objectContaining({
                serverId: 'server-1',
                defaultSessionId: 'session-mounted',
                surface: 'plugin',
                actionCaller: {
                    kind: 'plugin',
                    pluginId: FACTS.pluginId,
                    contributionLocalId: FACTS.contributionId,
                    occurrenceId: FACTS.occurrenceId,
                    materialization: FACTS.executionOrigin.materializationRef,
                },
            }),
        );
    });

    it('keeps the exact mounted caller for a local host Action when daemon transport is unavailable', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { reloaded: true } }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false },
            binding: { executeHostAction },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'plugins.reload',
            input: {},
        }))).resolves.toEqual({ reloaded: true });

        expect(executeHostAction).toHaveBeenCalledWith('plugins.reload', {}, {
            signal: expect.any(AbortSignal),
            actionRequestId: 'req:executeAction',
            serverId: 'server-1',
            surface: 'plugin',
            authority: 'account_automation',
            actionCaller: {
                kind: 'plugin',
                pluginId: FACTS.pluginId,
                contributionLocalId: FACTS.contributionId,
                occurrenceId: FACTS.occurrenceId,
                materialization: FACTS.executionOrigin.materializationRef,
            },
        });
    });

    it('refuses a mounted Action when its origin no longer matches the mounted plugin', async () => {
        const executeHostAction = vi.fn(async () => ({ ok: true as const, result: { shouldNotRun: true } }));
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                executionOrigin: {
                    ...FACTS.executionOrigin,
                    materializationRef: {
                        ...FACTS.executionOrigin.materializationRef,
                        pluginId: 'acme.replaced',
                    },
                },
            },
            binding: { executeHostAction },
        });

        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'plugins.reload',
            input: {},
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_mounted_caller_unavailable'],
        });
        expect(executeHostAction).not.toHaveBeenCalled();
    });

    it('fences an in-flight daemon read behind the mount lifetime it owns', async () => {
        let settle: ((value: unknown) => void) | undefined;
        const read = vi.fn(() => new Promise((resolve) => {
            settle = resolve;
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { readResource: read as never },
        });

        const pending = controller.hostApi.handleRequest(request('readResource', { resource: 'index' }));
        expect(read).toHaveBeenCalledTimes(1);

        // The surface retires while the daemon is still reading. The bytes it
        // eventually returns must not be disclosed to a mount that no longer
        // exists — a controller that installed the handlers without its own
        // lifetime would resolve them.
        controller.dispose();
        settle!({
            supported: true,
            result: {
                ok: true,
                contentType: 'application/json',
                digest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                bytesBase64: 'e30=',
            },
        });

        await expect(pending).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_retired'],
        });
    });

    it('installs openSurface only where the placement owns a destination selector', () => {
        const withoutDestination = createBoundPluginSurfaceController({ facts: FACTS });
        expect(withoutDestination.installedMethods).not.toContain('openSurface');

        const withDestination = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { openSurface: () => ({ ok: true }) },
        });
        expect(withDestination.installedMethods).toContain('openSurface');
    });

    it('installs the closed Session draft selector for every exact daemon mount while retaining target scope for contributed selection', () => {
        const pluginProjectionById = {
            'acme.provider': {
                pluginId: 'acme.provider',
                title: 'Provider',
                description: null,
                version: '1.0.0',
                enabled: true,
                generation: 12,
                generationLabel: '12',
                status: null,
                provenance: null,
                diagnostics: [],
                actions: [{
                    id: 'connection/prepare-v1',
                    occurrenceId: 'provider-generation-a',
                    title: 'Prepare',
                    description: null,
                    icon: null,
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    placementBindings: [],
                    inputSchema: null,
                    inputHints: null,
                    slash: null,
                    priority: null,
                    dangerLevel: 'safe',
                    confirmation: null,
                    available: true,
                }],
                resources: [],
                editableSettingsGroups: [],
            },
        } as const;
        const targetedContributions: PluginUiTargetedContributionsV1 = {
            target: {
                pluginId: FACTS.pluginId,
                occurrenceId: 'browser-generation-a',
                sourceCustody: { kind: 'development', registeredRootId: 'browser-root' },
            },
            points: [{
                pointId: 'connection',
                protocols: [{
                    protocol: { id: 'provider', version: 1 },
                    contributions: [{
                        contributor: {
                            pluginId: 'acme.provider',
                            contributionId: 'provider',
                            occurrenceId: 'provider-generation-a',
                            sourceCustody: { kind: 'development', registeredRootId: 'provider-root' },
                        },
                        protocol: { id: 'provider', version: 1 },
                        operations: [{
                            point: { pointId: 'connection', protocol: { id: 'provider', version: 1 } },
                            contributor: {
                                pluginId: 'acme.provider',
                                contributionId: 'provider',
                                occurrenceId: 'provider-generation-a',
                                sourceCustody: { kind: 'development', registeredRootId: 'provider-root' },
                            },
                            role: 'setup',
                            action: { pluginId: 'acme.provider', localId: 'connection/prepare-v1' },
                        }],
                        surfaces: [],
                    }],
                }],
            }],
        };

        const withoutSnapshot = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                pluginProjectionById,
            },
        });
        expect(withoutSnapshot.installedMethods).toContain('selectActionInput');

        const withMountedSnapshot = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                pluginProjectionById,
                targetedContributions,
            },
        });
        expect(withMountedSnapshot.installedMethods).toContain('selectActionInput');

        const wrongTarget = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                pluginProjectionById,
                targetedContributions: {
                    ...targetedContributions,
                    target: { ...targetedContributions.target, pluginId: 'acme.other-target' },
                },
            },
        });
        expect(wrongTarget.installedMethods).toContain('selectActionInput');
    });

    it('keeps the mounted Channels caller binding while its selected provider form consumes only host-resolved Connected Account options', async () => {
        const account = {
            service: { pluginId: 'happier.channel.discord', localId: 'discord-bot' },
            accountId: 'account-discord-a',
        } as const;
        const operation = {
            point: { pointId: 'providers', protocol: { id: 'happier.channels/providers', version: 1 } },
            contributor: {
                pluginId: 'happier.channel.discord',
                contributionId: 'discord-provider',
                occurrenceId: 'discord-generation-a',
                sourceCustody: { kind: 'development' as const, registeredRootId: 'discord-root' },
            },
            role: 'setup',
            action: { pluginId: 'happier.channel.discord', localId: 'channels/setup-v1' },
        } as const;
        const channelsFacts = {
            ...FACTS,
            pluginId: 'happier.channels',
            contributionId: 'settings',
            surfaceId: 'surfacePlacement:happier.channels:settings',
            executionOrigin: {
                ...FACTS.executionOrigin,
                materializationRef: {
                    ...FACTS.executionOrigin.materializationRef,
                    materializationId: 'channels-materialization-a',
                    pluginId: 'happier.channels',
                },
            },
        } as const;
        const pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>> = {
            'happier.channel.discord': {
                pluginId: 'happier.channel.discord',
                immutableGenerationId: 'discord-generation-a',
                title: 'Discord Channels',
                description: null,
                version: '1.0.0',
                enabled: true,
                generation: 12,
                generationLabel: '12',
                status: null,
                provenance: null,
                diagnostics: [],
                actions: [{
                    id: 'channels/setup-v1',
                    occurrenceId: 'discord-generation-a',
                    title: 'Set up Discord Channels',
                    description: null,
                    icon: null,
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    placementBindings: [],
                    inputHints: {
                        fields: [{
                            path: 'credentialRef',
                            title: 'Discord bot account',
                            widget: 'select',
                            connectedAccountOptions: true,
                            required: true,
                        }],
                    },
                    slash: null,
                    priority: null,
                    dangerLevel: 'safe',
                    confirmation: null,
                    available: true,
                }],
                resources: [],
                editableSettingsGroups: [],
            },
        };
        const targetedContributions: PluginUiTargetedContributionsV1 = {
            target: {
                pluginId: channelsFacts.pluginId,
                occurrenceId: 'channels-generation-a',
                sourceCustody: { kind: 'development', registeredRootId: 'channels-root' },
            },
            points: [{
                pointId: operation.point.pointId,
                protocols: [{
                    protocol: operation.point.protocol,
                    contributions: [{
                        contributor: operation.contributor,
                        protocol: operation.point.protocol,
                        operations: [operation],
                        surfaces: [],
                    }],
                }],
            }],
        };
        const executeContributedAction = vi.fn(async () => ({
            supported: true as const,
            result: { ok: true as const, result: { prepared: true } },
        }));
        const optionsTransport = await import('@/sync/ops/machineContributionRegistryProjection');
        // The daemon owns exact Action schemas; selection and validation remain real.
        const readSchemas = vi.spyOn(optionsTransport, 'machinePluginActionSchemasRead').mockResolvedValue({
            supported: true,
            result: DaemonPluginActionSchemasReadResponseSchema.parse({
                ok: true,
                inputSchema: {
                    type: 'object', additionalProperties: false, required: ['credentialRef'],
                    properties: {
                        credentialRef: {
                            type: 'object', additionalProperties: false, required: ['service', 'accountId'],
                            properties: {
                                service: {
                                    type: 'object', additionalProperties: false, required: ['pluginId', 'localId'],
                                    properties: { pluginId: { type: 'string' }, localId: { type: 'string' } },
                                },
                                accountId: { type: 'string' },
                            },
                        },
                    },
                },
            }),
        });
        const resolveOptions = vi.spyOn(
            optionsTransport,
            'machinePluginActionFormConnectedAccountOptionsResolve',
        ).mockResolvedValue({
            supported: true,
            result: {
                ok: true,
                options: [{ value: account, label: 'Discord bot' }],
            },
        });
        const { Modal } = await import('@/modal');
        type PresentedForm = Readonly<{
            replaceInput(input: Readonly<Record<string, unknown>>): void;
            submit(): Promise<unknown>;
            getInput(): Readonly<Record<string, unknown>>;
        }>;
        let form: PresentedForm | undefined;
        const show = vi.spyOn(Modal, 'show').mockImplementation((config) => {
            form = (config as unknown as Readonly<{ props: Readonly<{ form: PresentedForm }> }>).props.form;
            return 'channels-provider-setup-form';
        });
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        try {
            const controller = createBoundPluginSurfaceController({
                facts: {
                    ...channelsFacts,
                    machineDisplayName: 'Development Mac',
                    pluginProjectionById,
                    targetedContributions,
                },
                binding: { executeContributedAction: executeContributedAction as never },
            });
            const channelsRequest = (method: string, payload?: unknown) => ({
                version: 1 as const,
                requestId: `channels:${method}`,
                surface: {
                    pluginId: channelsFacts.pluginId,
                    contributionId: channelsFacts.contributionId,
                    surfaceId: channelsFacts.surfaceId,
                    placement: channelsFacts.placement,
                    platform: channelsFacts.platform,
                    channel: channelsFacts.channel,
                    resourceScope: [],
                    diagnostics: [],
                },
                method,
                ...(payload === undefined ? {} : { payload }),
            }) as never;

            const selecting = controller.hostApi.handleRequest(channelsRequest('selectActionInput', { operation }));
            await vi.waitFor(() => expect(form).toBeDefined());
            form!.replaceInput({ credentialRef: account });
            await form!.submit();

            const selection = PluginUiSelectActionInputResultV1Schema.parse(await selecting);
            if (selection.kind !== 'submitted') {
                throw new Error('Expected a submitted provider selection.');
            }
            expect(selection).toEqual({
                kind: 'submitted',
                action: operation.action,
                input: {},
                selection: {
                    target: {
                        pluginId: targetedContributions.target.pluginId,
                        sourceCustody: targetedContributions.target.sourceCustody,
                    },
                    point: operation.point,
                    contributor: {
                        pluginId: operation.contributor.pluginId,
                        contributionId: operation.contributor.contributionId,
                        sourceCustody: operation.contributor.sourceCustody,
                    },
                },
                connectedAccount: { kind: 'selected', ref: account, fieldPath: 'credentialRef' },
                presentation: {
                    connectedAccountLabel: 'Discord bot',
                    machineDisplayName: 'Development Mac',
                },
            });
            expect(resolveOptions).toHaveBeenCalledWith('machine_1', expect.objectContaining({
                serverId: 'server-1',
                expectedOccurrenceId: 'discord-generation-a',
                qualifiedActionId: 'happier.channel.discord/channels/setup-v1',
                fieldPath: 'credentialRef',
            }));
            expect(form!.getInput()).toEqual({});

            await expect(controller.hostApi.handleRequest(channelsRequest('executeAction', {
                action: 'connection/prepare-v1',
                input: {
                    providerSelection: selection.selection,
                    providerSetupInput: selection.input,
                    credentialRef: account,
                },
            }))).resolves.toEqual({ prepared: true });
            expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
                serverId: 'server-1',
                expectedContributorOccurrenceId: 'daemon-action-occurrence-a',
                qualifiedActionId: 'happier.channels/connection/prepare-v1',
                signal: expect.any(AbortSignal),
                isCurrent: expect.any(Function),
                input: {
                    providerSelection: selection.selection,
                    providerSetupInput: selection.input,
                    credentialRef: account,
                },
                executionSurface: 'ui',
                invocation: {
                    kind: 'mountedPluginSurface',
                    mountedBinding: {
                        pluginId: channelsFacts.pluginId,
                        contributionLocalId: 'settings',
                        occurrenceId: channelsFacts.occurrenceId,
                        materializationRef: channelsFacts.executionOrigin.materializationRef,
                    },
                },
            });
        } finally {
            hide.mockRestore();
            show.mockRestore();
            resolveOptions.mockRestore();
            readSchemas.mockRestore();
        }
    });

    it('withholds the targeted provider form when the admitted operation names a client Action whose registration has not committed', async () => {
        const operation = {
            point: { pointId: 'providers', protocol: { id: 'happier.channels/providers', version: 1 } },
            contributor: {
                pluginId: 'happier.channel.discord',
                contributionId: 'discord-provider',
                occurrenceId: 'discord-generation-a',
                sourceCustody: { kind: 'development' as const, registeredRootId: 'discord-root' },
            },
            role: 'setup',
            action: { pluginId: 'happier.channel.discord', localId: 'channels/setup-v1' },
        } as const;
        const channelsFacts = {
            ...FACTS,
            pluginId: 'happier.channels',
            contributionId: 'settings',
            surfaceId: 'surfacePlacement:happier.channels:settings',
            resolveContributedAction: resolveClientTargetAction,
            executionOrigin: {
                ...FACTS.executionOrigin,
                materializationRef: {
                    ...FACTS.executionOrigin.materializationRef,
                    materializationId: 'channels-materialization-a',
                    pluginId: 'happier.channels',
                },
            },
        } as const;
        const pluginProjectionById: Readonly<Record<string, PluginProjectionEntry>> = {
            'happier.channel.discord': {
                pluginId: 'happier.channel.discord',
                immutableGenerationId: 'discord-generation-a',
                title: 'Discord Channels',
                description: null,
                version: '1.0.0',
                enabled: true,
                generation: 12,
                generationLabel: '12',
                status: null,
                provenance: null,
                diagnostics: [],
                actions: [{
                    id: 'channels/setup-v1',
                    occurrenceId: 'discord-generation-a',
                    title: 'Set up Discord Channels',
                    description: null,
                    icon: null,
                    scopes: ['settings'],
                    surfaces: ['plugin'],
                    placementBindings: [],
                    inputHints: {
                        fields: [{
                            path: 'workspace',
                            title: 'Workspace',
                            widget: 'text',
                            required: true,
                        }],
                    },
                    slash: null,
                    priority: null,
                    dangerLevel: 'safe',
                    confirmation: null,
                    available: true,
                }],
                resources: [],
                editableSettingsGroups: [],
            },
        };
        const targetedContributions: PluginUiTargetedContributionsV1 = {
            target: {
                pluginId: channelsFacts.pluginId,
                occurrenceId: 'channels-generation-a',
                sourceCustody: { kind: 'development', registeredRootId: 'channels-root' },
            },
            points: [{
                pointId: operation.point.pointId,
                protocols: [{
                    protocol: operation.point.protocol,
                    contributions: [{
                        contributor: operation.contributor,
                        protocol: operation.point.protocol,
                        operations: [operation],
                        surfaces: [],
                    }],
                }],
            }],
        };
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'unexpected-form');
        try {
            const controller = createBoundPluginSurfaceController({
                facts: {
                    ...channelsFacts,
                    pluginProjectionById,
                    targetedContributions,
                },
            });

            await expect(controller.hostApi.handleRequest({
                version: 1 as const,
                requestId: 'channels:selectActionInput',
                surface: {
                    pluginId: channelsFacts.pluginId,
                    contributionId: channelsFacts.contributionId,
                    surfaceId: channelsFacts.surfaceId,
                    placement: channelsFacts.placement,
                    platform: channelsFacts.platform,
                    channel: channelsFacts.channel,
                    resourceScope: [],
                    diagnostics: [],
                },
                method: 'selectActionInput',
                payload: { operation },
            } as never)).resolves.toEqual({
                code: 'stale_surface',
                diagnostics: ['action_retired'],
            });
            expect(show).not.toHaveBeenCalled();
        } finally {
            show.mockRestore();
        }
    });

    it('preserves structural Action admission without dispatching from a retained inactive projection', async () => {
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, interactionEnabled: false, daemonInteractionEnabled: false },
        });

        expect(controller.admissionMethods).toContain('executeAction');
        expect(controller.installedMethods).not.toContain('executeAction');
        await expect(Promise.resolve(controller.hostApi.handleRequest(request('executeAction', {
            action: 'save',
            input: {},
        })))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['host_api_method_unavailable:executeAction'],
        });
        controller.dispose();
        expect(controller.admissionMethods).toEqual([]);
    });

    it('keeps placement-local openSurface available when daemon interaction is inactive', async () => {
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, interactionEnabled: false, daemonInteractionEnabled: false },
            binding: { openSurface },
        });

        // Navigation is owned by the selected destination/pane, not the daemon
        // Action/Resource transport. A disconnected Account must therefore not
        // make an already-admitted local page destination unreachable.
        expect(controller.installedMethods).toContain('openSurface');
        expect(controller.interactive).toBe(true);
        await expect(controller.hostApi.handleRequest(request('openSurface', {
            destination: { pluginId: 'acme.browser', localId: 'settings' },
        }))).resolves.toBeNull();
        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: 'acme.browser', localId: 'settings' },
        });
        expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'save',
            input: {},
        }))).toEqual({
            code: 'unavailable',
            diagnostics: ['host_api_method_unavailable:executeAction'],
        });

        await expect(controller.applyComposer(
            { kind: 'session', sessionId: 'session-offline' },
            { expectedRevision: 0, operations: [{ kind: 'text.clear' }] },
        )).resolves.toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:applyComposer'],
        });
    });

    it('does not infer a Run-on choice request from the absence of a bound Machine', async () => {
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, machineId: null, daemonInteractionEnabled: false },
        });
        try {
            expect(await controller.hostApi.handleRequest(request('readResource', {
                resource: { pluginId: FACTS.pluginId, localId: 'latest' },
            }))).toMatchObject({ code: 'unavailable',
                message: t('settingsPlugins.surfaces.machineCapabilityUnavailable', { machine: t('machine.thisMachineInSentence') }) });
        } finally { controller.dispose(); }
    });

    it('keeps canonical Connected Accounts navigation available without daemon interaction', async () => {
        const openConnectedAccounts = vi.fn(async () => undefined);
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, interactionEnabled: false, daemonInteractionEnabled: false },
            binding: { openConnectedAccounts },
        });

        expect(controller.installedMethods).toContain('openConnectedAccounts');
        await expect(controller.hostApi.handleRequest(request('openConnectedAccounts', {
            service: { pluginId: 'happier.scm.github', localId: 'github-account' },
            accountId: 'github:work',
        }))).resolves.toBeNull();
        expect(openConnectedAccounts).toHaveBeenCalledWith({
            service: { pluginId: 'happier.scm.github', localId: 'github-account' },
            accountId: 'github:work',
        });
    });

    it('updates Connected Accounts navigation only on commit without replacing its physical caller', async () => {
        const firstOpen = vi.fn(async () => undefined);
        const secondOpen = vi.fn(async () => undefined);
        let openConnectedAccounts = firstOpen;
        let suspend = false;
        let attempted = 0;
        const pending = createDeferred<void>();
        let current: ReturnType<typeof useBoundPluginSurfaceController> | undefined;
        function Surface() {
            current = useBoundPluginSurfaceController({ facts: FACTS, binding: { openConnectedAccounts } });
            return null;
        }
        function Gate(): null {
            if (suspend) { attempted += 1; throw pending.promise; }
            return null;
        }
        const render = () => React.createElement(React.Suspense, { fallback: React.createElement('View', { testID: 'pending-navigation' }) },
            React.createElement(Surface), React.createElement(Gate));
        const screen = await renderScreen(render());
        const first = current!;
        const payload = { service: { pluginId: 'acme.accounts', localId: 'forge' } };
        try {
            openConnectedAccounts = secondOpen;
            suspend = true;
            await act(async () => {
                let update: Promise<void> | undefined;
                React.startTransition(() => { update = screen.update(render()); });
                await update;
            });
            expect(attempted).toBeGreaterThan(0);
            expect(screen.findHostByTestId('pending-navigation')).toBeNull();
            await expect(first.hostApi.handleRequest(request('openConnectedAccounts', payload))).resolves.toBeNull();
            expect(firstOpen).toHaveBeenCalledOnce();
            expect(secondOpen).not.toHaveBeenCalled();
            suspend = false;
            openConnectedAccounts = firstOpen;
            await screen.update(render());
            expect(current).toBe(first);
            openConnectedAccounts = secondOpen;
            await screen.update(render());
            expect(current).toBe(first);
            await expect(first.hostApi.handleRequest(request('openConnectedAccounts', payload))).resolves.toBeNull();
            expect(firstOpen).toHaveBeenCalledOnce();
            expect(secondOpen).toHaveBeenCalledExactlyOnceWith(payload);
        } finally {
            await screen.unmount();
            await act(async () => { pending.resolve(); });
        }
    });

    it('keeps locally served host methods when only the daemon binding is unavailable', async () => {
        const executeContributedAction = vi.fn();
        clipboard.getStringAsync.mockReset();
        clipboard.setStringAsync.mockReset();
        clipboard.getStringAsync.mockResolvedValue('  copied review link  ');
        clipboard.setStringAsync.mockResolvedValue(true);
        const diagnosticLog = vi.spyOn(log, 'log').mockImplementation(() => {});
        const openUrl = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
        vi.stubGlobal('open', undefined);
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        // A mount with a current Account but no exact daemon target still owns
        // local context, feedback and host-Action presentation. It must not
        // advertise a daemon-contributed Action merely because the renderer is
        // mounted; that binding requires the exact daemon admission separately.
        // `openNewSession` is locally served from the current Account lifetime,
        // so it stays installed beside the other local methods, as are the
        // client-realm linked-Session methods served from the Account's own
        // Session store.
        expect(controller.installedMethods).toEqual([
            'context',
            'executeAction',
            'admitAction',
            'readResource',
            'watchResource',
            'notify',
            'confirm',
            'diagnostic',
            'readClipboard',
            'writeClipboard',
            'openExternalLink',
            'openNewSession',
            'readSession',
            'readMachineDisplayName',
            'revealSessionInput',
            'watchSession',
            'respondToSessionPermission',
        ]);
        expect(controller.interactive).toBe(true);
        await expect(controller.hostApi.handleRequest(request('executeAction', {
            action: 'plugin-owned-action',
            input: {},
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_contributed_action_unavailable'],
            message: t('settingsPlugins.surfaces.machineCapabilityUnavailable', { machine: t('machine.thisMachineInSentence') }),
        });
        expect(executeContributedAction).not.toHaveBeenCalled();
        expect(controller.hostApi.handleRequest(request('diagnostic', {
            code: 'plugin.ui.ready',
            severity: 'warning',
            message: 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        }))).toBeNull();
        expect(diagnosticLog).toHaveBeenCalledTimes(1);
        const diagnosticText = diagnosticLog.mock.calls[0]?.[0] ?? '';
        expect(diagnosticText).toContain('plugin.ui.ready');
        expect(diagnosticText).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
        await expect(controller.hostApi.handleRequest(request('readClipboard'))).resolves.toEqual({
            value: '  copied review link  ',
        });
        clipboard.getStringAsync.mockRejectedValueOnce(new Error('clipboard is unavailable'));
        await expect(controller.hostApi.handleRequest(request('readClipboard'))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_clipboard_unavailable'],
        });
        await expect(controller.hostApi.handleRequest(request('writeClipboard', {
            value: 'review link',
        }))).resolves.toBeNull();
        expect(clipboard.setStringAsync).toHaveBeenCalledWith('review link');
        await expect(controller.hostApi.handleRequest(request('openExternalLink', {
            url: 'https://example.test/reviews/7',
        }))).resolves.toBeNull();
        expect(openUrl).toHaveBeenCalledWith('https://example.test/reviews/7');
        diagnosticLog.mockRestore();
        openUrl.mockRestore();
        vi.unstubAllGlobals();
    });

    it('keeps a non-interactive factual method set mountable for typed host refusal', () => {
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                interactionEnabled: false,
            },
        });

        // The facade is still useful even though it has no semantic producer:
        // the SDK can read its exact context and receives the canonical typed
        // refusal for every omitted method. Suppressing this facade turns the
        // controller's factual handler set into a renderer-local decision.
        expect(controller.installedMethods).toEqual(['context']);
        expect(controller.interactive).toBe(true);
    });

    it('fences clipboard reads behind the exact mounted lifetime and caller cancellation', async () => {
        let settleRetiredRead: ((value: string) => void) | undefined;
        clipboard.getStringAsync.mockReset();
        clipboard.getStringAsync.mockImplementationOnce(() => new Promise<string>((resolve) => {
            settleRetiredRead = resolve;
        }));
        const retiredController = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false },
        });
        const retiredRead = retiredController.hostApi.handleRequest(request('readClipboard'));
        retiredController.dispose();
        settleRetiredRead!('late clipboard value');
        await expect(retiredRead).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });

        let settleCancelledRead: ((value: string) => void) | undefined;
        clipboard.getStringAsync.mockImplementationOnce(() => new Promise<string>((resolve) => {
            settleCancelledRead = resolve;
        }));
        const cancelledController = createBoundPluginSurfaceController({
            facts: { ...FACTS, daemonInteractionEnabled: false },
        });
        const cancellation = new AbortController();
        const cancelledRead = cancelledController.hostApi.handleRequest(
            request('readClipboard'),
            { signal: cancellation.signal },
        );
        cancellation.abort();
        settleCancelledRead!('late clipboard value');
        await expect(cancelledRead).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_surface_clipboard_read_cancelled'],
        });
        cancelledController.dispose();
    });

    it('preserves a known openSurface success when its mount retires after settlement wins', async () => {
        let settle: ((value: { ok: true }) => void) | undefined;
        const openSurface = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
            settle = resolve;
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { openSurface },
        });

        const pending = controller.hostApi.handleRequest(request('openSurface', {
            destination: { pluginId: 'acme.browser', localId: 'settings' },
        }));
        expect(openSurface).toHaveBeenCalledTimes(1);

        settle!({ ok: true });

        await expect(pending).resolves.toBeNull();
        controller.dispose();
    });

    it('rejects openSurface before its outward effect is admitted after mount retirement', async () => {
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { openSurface },
        });

        controller.dispose();

        // A retired mount refuses synchronously, so the host result is
        // normalised the same way every other refusal assertion in this file
        // is — the contract is the value, not whether it was awaited.
        await expect(Promise.resolve(controller.hostApi.handleRequest(request('openSurface', {
            destination: { pluginId: 'acme.browser', localId: 'settings' },
        })))).resolves.toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(openSurface).not.toHaveBeenCalled();
    });

    it('preserves a known Action success when its mount retires after settlement wins', async () => {
        let settle: ((value: unknown) => void) | undefined;
        let signalAdmission: () => void = () => {};
        const admitted = new Promise<void>((resolve) => { signalAdmission = resolve; });
        const executeContributedAction = vi.fn(() => new Promise((resolve) => {
            settle = resolve;
            signalAdmission();
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction: executeContributedAction as never },
        });

        const pending = controller.hostApi.handleRequest(request('executeAction', {
            action: 'refresh-index',
            input: {},
        }));
        await admitted;
        expect(executeContributedAction).toHaveBeenCalledTimes(1);

        controller.dispose();
        settle!({
            supported: true,
            result: { ok: true, result: { applied: true } },
        });

        await expect(pending).resolves.toEqual({ applied: true });
    });

    it('routes a declarative action through this mount\'s one bound host facade', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true,
            result: { ok: true as const, result: { applied: true } },
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.dispatchAction(
            { pluginId: FACTS.pluginId, localId: 'save' },
            null,
        )).resolves.toEqual({ applied: true });

        expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: 'daemon-action-occurrence-a',
            qualifiedActionId: 'acme.browser/save',
            signal: expect.any(AbortSignal),
            isCurrent: expect.any(Function),
            input: null,
            executionSurface: 'ui',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    pluginId: FACTS.pluginId,
                    contributionLocalId: FACTS.contributionId,
                    occurrenceId: FACTS.occurrenceId,
                    materializationRef: FACTS.executionOrigin.materializationRef,
                },
            },
        });
    });

    it('refuses an uncommitted declarative Action before presenting an input form or dispatching', async () => {
        const action = {
            id: 'launch', occurrenceId: null, title: 'Launch a worker',
            description: null, icon: null, scopes: ['session'], surfaces: ['ui', 'plugin'],
            placementBindings: [], slash: null, priority: null, dangerLevel: 'safe',
            confirmation: null, available: true,
            inputHints: { fields: [{ path: 'name', title: 'Name', widget: 'text', required: true }] },
        } satisfies PluginProjectionEntry['actions'][number];
        const plugin = {
            pluginId: FACTS.pluginId, immutableGenerationId: FACTS.occurrenceId,
            title: 'Worker tools', description: null, version: '1.0.0', enabled: true,
            generation: 12, generationLabel: '12', status: null, provenance: null,
            diagnostics: [], actions: [action], resources: [], editableSettingsGroups: [],
        } satisfies PluginProjectionEntry;
        const { Modal } = await import('@/modal');
        const show = vi.spyOn(Modal, 'show').mockImplementation(() => 'unexpected-action-input');
        const executeContributedAction = vi.fn(async () => ({
            supported: true as const, result: { ok: true as const, result: { launched: true } },
        }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, sessionId: 'session-worker', pluginProjectionById: { [FACTS.pluginId]: plugin },
                resolveContributedAction: identity => ({ ...resolveDaemonTargetAction(identity),
                    surfaces: ['ui', 'plugin'], inputHints: action.inputHints }) },
            binding: { executeContributedAction },
        });
        try {
            await expect(controller.dispatchAction({ pluginId: FACTS.pluginId, localId: action.id }))
                .resolves.toEqual({ code: 'unavailable', diagnostics: ['action_retired'] });
            expect(show).not.toHaveBeenCalled();
            expect(executeContributedAction).not.toHaveBeenCalled();
        } finally {
            controller.dispose();
            show.mockRestore();
        }
    });

    it.each(['submit', 'cancel', 'retire', 'hydrate'] as const)('collects omitted declarative Action input before mounted dispatch (%s)', async (settlement) => {
        const action = {
            id: 'launch', occurrenceId: 'daemon-action-occurrence-a', title: 'Launch a worker',
            description: null, icon: null, scopes: ['session'], surfaces: ['ui'],
            placementBindings: [], slash: null, priority: null, dangerLevel: 'safe',
            confirmation: null, available: true,
            inputHints: { fields: [{ path: 'name', title: 'Name', widget: 'text', required: true }] },
        } satisfies PluginProjectionEntry['actions'][number];
        const plugin = {
            pluginId: FACTS.pluginId, immutableGenerationId: FACTS.occurrenceId,
            title: 'Worker tools', description: null, version: '1.0.0', enabled: true,
            generation: 12, generationLabel: '12', status: null, provenance: null,
            diagnostics: [], actions: [action], resources: [], editableSettingsGroups: [],
        } satisfies PluginProjectionEntry;
        const rpc = await import('@/sync/ops/machineContributionRegistryProjection');
        // The daemon's exact schema read and the app-shell modal are system boundaries.
        const readSchemas = vi.spyOn(rpc, 'machinePluginActionSchemasRead').mockResolvedValue({
            supported: true, result: DaemonPluginActionSchemasReadResponseSchema.parse({
                ok: true, inputSchema: { type: 'object', additionalProperties: false,
                    properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] },
            }),
        });
        const { Modal } = await import('@/modal');
        type Form = import('@/components/plugins/actions/pluginContributedActionController').PluginContributedActionSelectionForm;
        let form: Form | undefined;
        const show = vi.spyOn(Modal, 'show').mockImplementation(config => {
            form = (config.props as Readonly<{ form: Form }>).form;
            return 'declarative-worker-input';
        });
        const hide = vi.spyOn(Modal, 'hide').mockImplementation(() => {});
        const executeContributedAction = vi.fn(async () => ({
            supported: true as const, result: { ok: true as const, result: { launched: true } },
        }));
        const actionFacts = { pluginProjectionById: { [FACTS.pluginId]: plugin },
            resolveContributedAction: (identity: PluginContributionIdentityV1) => ({ ...resolveDaemonTargetAction(identity),
                inputHints: action.inputHints }) };
        let currentActionFacts: Pick<BoundPluginSurfaceFacts, 'pluginProjectionById' | 'resolveContributedAction'> =
            settlement === 'hydrate' ? { ...actionFacts, pluginProjectionById: null } : actionFacts;
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, ...currentActionFacts, sessionId: 'session-worker',
                readActionInputFacts: () => currentActionFacts },
            binding: { executeContributedAction },
        });
        try {
            currentActionFacts = actionFacts;
            const pending = controller.dispatchAction({ pluginId: FACTS.pluginId, localId: action.id });
            await vi.waitFor(() => expect(form).toBeDefined());
            expect(form!.getFields().map(field => field.path)).toEqual(['name']);
            expect(executeContributedAction).not.toHaveBeenCalled();
            if (settlement === 'submit') {
                form!.replaceInput({ name: 'Research' });
                await form!.submit();
                await expect(pending).resolves.toEqual({ launched: true });
                expect(executeContributedAction).toHaveBeenCalledWith('machine_1', expect.objectContaining({
                    input: { name: 'Research' }, sessionId: 'session-worker',
                    invocation: { kind: 'mountedPluginSurface', mountedBinding: expect.objectContaining({
                        occurrenceId: FACTS.occurrenceId, materializationRef: FACTS.executionOrigin.materializationRef,
                    }) },
                }));
            } else {
                if (settlement === 'cancel' || settlement === 'hydrate') form!.cancel();
                else controller.dispose();
                await pending;
                expect(executeContributedAction).not.toHaveBeenCalled();
                expect(form!.isRetired()).toBe(true);
            }
        } finally {
            controller.dispose();
            readSchemas.mockRestore(); show.mockRestore(); hide.mockRestore();
        }
    });

    it('routes declarative composerApply through the mounted Host API with the host-owned Composer ref', async () => {
        const applyComposer = vi.fn(async () => ({ status: 'applied' as const, revision: 8 }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { mountedHostApiHandlers: { applyComposer } },
        });
        const composer = { kind: 'session' as const, sessionId: 'session-composer-bound' };
        const transaction = {
            expectedRevision: 7,
            operations: [{ kind: 'text.set' as const, text: 'Review the incident' }],
        };

        await expect((controller as unknown as Readonly<{
            applyComposer: (ref: typeof composer, value: typeof transaction) => Promise<unknown>;
        }>).applyComposer(composer, transaction)).resolves.toEqual({ status: 'applied', revision: 8 });

        expect(applyComposer).toHaveBeenCalledWith(expect.objectContaining({
            version: 1,
            method: 'applyComposer',
            surface: controller.surfaceContext,
            payload: { ref: composer, transaction },
        }), undefined);
    });

    it('routes a declarative destination through this mount\'s one bound host facade', async () => {
        const openSurface = vi.fn(async () => ({ ok: true as const }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { openSurface },
        });

        await expect(controller.openSurface(
            { pluginId: FACTS.pluginId, localId: 'settings' },
        )).resolves.toBeNull();

        expect(openSurface).toHaveBeenCalledWith({
            destination: { pluginId: FACTS.pluginId, localId: 'settings' },
        });
    });

    it('keeps the mounted caller when that surface invokes a cross-plugin action', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true,
            result: { ok: true as const, result: { applied: true } },
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.dispatchAction(
            { pluginId: 'acme.reviewer', localId: 'publish' },
            { source: 'mounted-surface' },
        )).resolves.toEqual({ applied: true });

        expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: 'daemon-action-occurrence-a',
            qualifiedActionId: 'acme.reviewer/publish',
            input: { source: 'mounted-surface' },
            signal: expect.any(AbortSignal),
            isCurrent: expect.any(Function),
            executionSurface: 'ui',
            // The bound placement, never the target, supplies this claim; the
            // daemon revalidates it before deriving caller provenance.
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    pluginId: FACTS.pluginId,
                    contributionLocalId: FACTS.contributionId,
                    occurrenceId: FACTS.occurrenceId,
                    materializationRef: FACTS.executionOrigin.materializationRef,
                },
            },
        });
    });

    it('carries the bound Session into the canonical contributed Action binding', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true,
            result: { ok: true as const, result: { applied: true } },
        }));
        const controller = createBoundPluginSurfaceController({
            facts: { ...FACTS, sessionId: 'session-bound' },
            binding: { executeContributedAction: executeContributedAction as never },
        });

        await expect(controller.dispatchAction(
            { pluginId: 'acme.reviewer', localId: 'publish' },
            { source: 'bound-session' },
        )).resolves.toEqual({ applied: true });

        expect(executeContributedAction).toHaveBeenCalledWith('machine_1', {
            serverId: 'server-1',
            expectedContributorOccurrenceId: 'daemon-action-occurrence-a',
            qualifiedActionId: 'acme.reviewer/publish',
            input: { source: 'bound-session' },
            signal: expect.any(AbortSignal),
            isCurrent: expect.any(Function),
            executionSurface: 'ui',
            sessionId: 'session-bound',
            invocation: {
                kind: 'mountedPluginSurface',
                mountedBinding: {
                    pluginId: FACTS.pluginId,
                    contributionLocalId: FACTS.contributionId,
                    occurrenceId: FACTS.occurrenceId,
                    materializationRef: FACTS.executionOrigin.materializationRef,
                },
            },
        });
    });

    it('installs bounded openable-content handlers only for the selected reference', async () => {
        const stat = vi.fn(async () => ({
            status: 'ready' as const,
            contentClass: 'text' as const,
            mimeType: 'text/plain',
            extension: '.md',
            sizeBytes: 5,
            revision: 'workspace-file:5:100',
        }));
        const read = vi.fn(async () => ({
            status: 'ready' as const,
            content: { kind: 'utf8' as const, text: 'hello' },
            revision: 'workspace-file:5:100',
        }));
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            // The public method must be installed only from a host-created
            // binding. Before the producer exists, the controller must keep
            // rejecting the methods rather than fabricate a path-bearing read.
            binding: {
                ...{
                    openableContent: {
                        ref: { kind: 'workspaceFile', handle: 'workspaceFile_opaque' },
                        stat,
                        read,
                    },
                },
            },
        });

        expect(controller.installedMethods).toEqual([
            'context',
            'statOpenableContent',
            'readOpenableContent',
        ]);

        await expect(controller.hostApi.handleRequest(request('statOpenableContent', {
            ref: {
                kind: 'workspaceFile',
                handle: 'workspaceFile_opaque',
            },
        }))).resolves.toEqual({
            status: 'ready',
            contentClass: 'text',
            mimeType: 'text/plain',
            extension: '.md',
            sizeBytes: 5,
            revision: 'workspace-file:5:100',
        });

        await expect(controller.hostApi.handleRequest(request('readOpenableContent', {
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_other' },
            expectedRevision: 'workspace-file:5:100',
        }))).resolves.toEqual({ status: 'unsupported' });
        expect(read).not.toHaveBeenCalled();

        await expect(controller.hostApi.handleRequest(request('readOpenableContent', {
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_opaque' },
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }))).resolves.toEqual({
            status: 'ready',
            content: { kind: 'utf8', text: 'hello' },
            revision: 'workspace-file:5:100',
        });
        expect(read).toHaveBeenCalledWith({
            ref: { kind: 'workspaceFile', handle: 'workspaceFile_opaque' },
            expectedRevision: 'workspace-file:5:100',
            maxBytes: 5,
        }, undefined);
    });

    it('narrows an opaque file viewer to context and openable-content methods without narrowing the same renderer elsewhere', async () => {
        const executeContributedAction = vi.fn(async () => ({
            supported: true,
            result: { ok: true as const, result: { applied: true } },
        }));
        const readComposer = vi.fn(() => ({
            status: 'unavailable' as const,
            reason: 'scopeClosed' as const,
        }));
        const openableBinding = {
            ref: { kind: 'workspaceFile' as const, handle: 'workspaceFile_opaque' },
            stat: async () => ({
                status: 'ready' as const,
                contentClass: 'text' as const,
                mimeType: 'text/plain',
                sizeBytes: 5,
                revision: 'workspace-file:5:100',
            }),
            read: async () => ({ status: 'unsupported' as const }),
        };
        const fileViewer = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                executeContributedAction: executeContributedAction as never,
                openableContent: openableBinding,
                // A renderer declaration can request a generic mounted Host
                // API method, but the selected file-viewer role is factual:
                // only the host-owned opaque read/stat pair is installed.
                mountedHostApiHandlers: { readComposer },
            },
        });

        expect(fileViewer.installedMethods).toEqual([
            'context',
            'statOpenableContent',
            'readOpenableContent',
        ]);
        for (const method of [
            'executeAction',
            'readClipboard',
            'writeClipboard',
            'openExternalLink',
            'notify',
            'readResource',
            'watchResource',
            'openSurface',
            'selectActionInput',
            'readComposer',
        ] as const) {
            await expect(Promise.resolve(fileViewer.hostApi.handleRequest(request(method, {})))).resolves.toEqual({
                code: 'unsupported_method',
                diagnostics: [`host_api_method_not_installed:${method}`],
            });
        }
        expect(executeContributedAction).not.toHaveBeenCalled();
        expect(readComposer).not.toHaveBeenCalled();
        await expect(fileViewer.dispatchAction(
            { pluginId: FACTS.pluginId, localId: 'save' },
            null,
        )).resolves.toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:executeAction'],
        });

        const appPage = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: { executeContributedAction: executeContributedAction as never },
        });
        expect(appPage.installedMethods).toContain('executeAction');
        await expect(appPage.dispatchAction(
            { pluginId: FACTS.pluginId, localId: 'save' },
            null,
        )).resolves.toEqual({ applied: true });
    });

    it('builds mounted semantic handlers from the controller lifetime and never invokes that factory for a file viewer', () => {
        const dispose = vi.fn();
        const buildMountedHandlers = vi.fn((input: Readonly<{ isCurrent: () => boolean }>) => {
            expect(input.isCurrent()).toBe(true);
            return {
                handlers: {
                    readComposer: () => ({ status: 'unavailable' as const, reason: 'scopeClosed' as const }),
                },
                dispose,
            };
        });
        const generic = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                createMountedHostApiHandlers: buildMountedHandlers,
            } as never,
        });

        expect(buildMountedHandlers).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            isCurrent: expect.any(Function),
        }));
        expect(generic.installedMethods).toContain('readComposer');
        generic.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);

        const viewerFactory = vi.fn(buildMountedHandlers);
        const fileViewer = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                openableContent: {
                    ref: { kind: 'workspaceFile', handle: 'workspaceFile_opaque' },
                    stat: async () => ({ status: 'unsupported' as const }),
                    read: async () => ({ status: 'unsupported' as const }),
                },
                createMountedHostApiHandlers: viewerFactory,
            } as never,
        });

        expect(viewerFactory).not.toHaveBeenCalled();
        expect(fileViewer.installedMethods).not.toContain('readComposer');
    });

    it('retires and disposes a whole controller unmounted while Suspense keeps its source current', async () => {
        const suspended = createDeferred<void>();
        let hidden = false;
        let current: ReturnType<typeof useBoundPluginSurfaceController> | undefined;
        const dispose = vi.fn();
        const factory: BoundPluginSurfaceMountedHostApiHandlersFactory = () => ({ handlers: {}, dispose });
        function Surface() {
            current = useBoundPluginSurfaceController({ facts: FACTS, binding: { createMountedHostApiHandlers: factory } });
            return null;
        }
        function Gate(): null {
            if (hidden) throw suspended.promise;
            return null;
        }
        const render = () => React.createElement(React.Suspense, { fallback: React.createElement('View', { testID: 'suspended-controller' }) },
            React.createElement(Surface), React.createElement(Gate));
        const screen = await renderScreen(render());
        const controller = current!;
        const retired = vi.fn();
        const observation = controller.onRetire(retired);
        onTestFinished(async () => {
            observation.dispose();
            controller.dispose();
            await act(async () => { suspended.resolve(); });
        });
        expect(controller.isCurrent()).toBe(true);
        hidden = true;
        await screen.update(render());
        expect(screen.findByTestId('suspended-controller')).toBeTruthy();
        expect(CURRENT_ACCOUNT_LIFETIME.isCurrent()).toBe(true);
        expect(controller.isCurrent()).toBe(true);
        expect(retired).not.toHaveBeenCalled();
        expect(dispose).not.toHaveBeenCalled();
        await screen.unmount();
        expect(CURRENT_ACCOUNT_LIFETIME.isCurrent()).toBe(true);
        expect.soft(controller.isCurrent()).toBe(false);
        expect.soft(retired).toHaveBeenCalledTimes(1);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('updates mounted handler bundles without withdrawing an entered request or the physical controller', async () => {
        let finish: (value: null) => void = () => {};
        const pending = new Promise<null>(resolve => { finish = resolve; });
        const firstDispose = vi.fn();
        const firstFactory: BoundPluginSurfaceMountedHostApiHandlersFactory = () => ({ handlers: { readComposer: () => pending }, dispose: firstDispose });
        const secondFactory: BoundPluginSurfaceMountedHostApiHandlersFactory = () => ({ handlers: { readComposer: () => null } });
        const hook = await renderHook((factory: BoundPluginSurfaceMountedHostApiHandlersFactory) =>
            useBoundPluginSurfaceController({ facts: FACTS, binding: { createMountedHostApiHandlers: factory } }),
        { initialProps: firstFactory });
        try {
            const incumbent = hook.getCurrent();
            const entered = incumbent.hostApi.handleRequest(request('readComposer', {}));
            const current = await hook.rerender(secondFactory);
            expect(current).toBe(incumbent);
            expect(incumbent.isCurrent()).toBe(true);
            expect(firstDispose).toHaveBeenCalledOnce();
            expect(await current.hostApi.handleRequest(request('readComposer', {}))).toBeNull();
            finish(null);
            expect(await entered).toBeNull();
        } finally { finish(null); await hook.unmount(); }
    });

    it('readmits added mounted methods and withdraws removed methods in the committed render', async () => {
        const readFactory: BoundPluginSurfaceMountedHostApiHandlersFactory = () => ({ handlers: { readComposer: () => null } });
        const focusFactory: BoundPluginSurfaceMountedHostApiHandlersFactory = () => ({ handlers: { focusComposer: () => null } });
        const hook = await renderHook((factory: BoundPluginSurfaceBinding['createMountedHostApiHandlers']) => {
            const controller = useBoundPluginSurfaceController({ facts: FACTS, binding: { createMountedHostApiHandlers: factory } });
            return { controller, renderedMethods: controller.admissionMethods };
        }, { initialProps: readFactory });
        try {
            const initial = hook.getCurrent();
            const current = await hook.rerender(focusFactory);
            expect(current.controller).toBe(initial.controller);
            expect(current.renderedMethods).toContain('focusComposer');
            expect(current.renderedMethods).not.toContain('readComposer');
            expect(current.controller.installedMethods).toContain('focusComposer');
        } finally { await hook.unmount(); }
    });

    it('renders the current presentation binding after a same-method bundle replacement without a render loop', async () => {
        let presentation: { isCurrent(): boolean } | undefined;
        const makeFactory = () => () => {
            let current = true;
            presentation = { isCurrent: () => current };
            return { handlers: {}, dispose: () => { current = false; } };
        };
        let renders = 0;
        const firstFactory = makeFactory();
        const secondFactory = makeFactory();
        const hook = await renderHook((factory: BoundPluginSurfaceBinding['createMountedHostApiHandlers']) => {
            renders += 1;
            const controller = useBoundPluginSurfaceController({ facts: FACTS, binding: { createMountedHostApiHandlers: factory } });
            // The physical Host captures its entity-drag presentation binding
            // after constructing the controller, before committed layout work.
            return { controller, presentation };
        }, { initialProps: firstFactory });
        try {
            const first = hook.getCurrent();
            const before = renders;
            const second = await hook.rerender(secondFactory);
            expect(second.controller).toBe(first.controller);
            expect(first.presentation?.isCurrent()).toBe(false);
            expect(second.presentation?.isCurrent()).toBe(true);
            expect(renders - before).toBe(2);
            const committed = renders;
            await hook.rerender(secondFactory);
            expect(renders - committed).toBe(1);
        } finally { await hook.unmount(); }
    });

    it('activates and updates a mounted current-UI handler only after its controller commits, then retires it with that controller', async () => {
        const activate = vi.fn();
        const setCurrentUiContextEligibility = vi.fn();
        const dispose = vi.fn();
        const buildMountedHandlers = vi.fn(() => Object.freeze({
            handlers: {},
            activate,
            setCurrentUiContextEligibility,
            dispose,
        }));

        const hook = await renderHook(
            (focusEligible: boolean) => {
                const controller = useBoundPluginSurfaceController({
                    facts: FACTS,
                    binding: {
                        createMountedHostApiHandlers: buildMountedHandlers as never,
                    },
                });
                // This mirrors the physical host's post-commit focus observer.
                // It must update data on the exact committed controller rather
                // than replace the controller or retain plugin enrichment.
                React.useEffect(() => {
                    (controller as unknown as Readonly<{
                        setCurrentUiContextEligibility?: (eligible: boolean) => void;
                    }>).setCurrentUiContextEligibility?.(focusEligible);
                }, [controller, focusEligible]);
                return controller;
            },
            { initialProps: true },
        );

        expect(buildMountedHandlers).toHaveBeenCalledTimes(1);
        expect(activate).toHaveBeenCalledTimes(1);
        expect(setCurrentUiContextEligibility).toHaveBeenLastCalledWith(true);

        await hook.rerender(false);
        expect(buildMountedHandlers).toHaveBeenCalledTimes(1);
        expect(setCurrentUiContextEligibility).toHaveBeenLastCalledWith(false);

        await hook.unmount();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('does not activate a mounted handler while constructing an uncommitted controller', () => {
        const activate = vi.fn();
        const dispose = vi.fn();
        const controller = createBoundPluginSurfaceController({
            facts: FACTS,
            binding: {
                createMountedHostApiHandlers: (() => Object.freeze({
                    handlers: {},
                    activate,
                    dispose,
                })) as never,
            },
        });

        // Controller construction is the same render-time work an abandoned
        // React render performs. Registration must wait for the hook effect.
        expect(activate).not.toHaveBeenCalled();
        controller.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('does not admit plugin Resources when only host reads have a readable capability', async () => {
        const controller = createBoundPluginSurfaceController({
            // The selected-member capability is an admission fact. A sibling
            // projection cannot make this mount read or watch Resources.
            facts: {
                ...FACTS,
                resourceCapability: { readable: false, dynamic: false },
            },
        });

        expect(controller.installedMethods).toContain('readResource');
        expect(controller.installedMethods).toContain('watchResource');
        await expect(controller.hostApi.handleRequest(request('readResource', {
            resource: 'sibling-or-static-resource',
        }))).resolves.toEqual({
            code: 'unavailable',
            diagnostics: ['plugin_resource_transport_unavailable'],
        });
    });

    it('installs only snapshot reads for a readable non-dynamic selected Resource capability', async () => {
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                resourceCapability: { readable: true, dynamic: false },
            },
        });

        expect(controller.installedMethods).toContain('readResource');
        expect(controller.installedMethods).toContain('watchResource');
        await expect(controller.hostApi.handleRequest(request('watchResource', {
            resource: 'static-resource', subscriptionId: 'static-plugin-watch',
        }))).resolves.toMatchObject({ code: 'unavailable' });
        // This remains an envelope-only transport operation, so it is never
        // advertised in `version().methods`; without watch ownership it is not
        // installed behind that transport path either.
        expect(controller.installedMethods).not.toContain('unsubscribeResource');
        expect(controller.hostApi.handleRequest(request('unsubscribeResource', {
            subscriptionId: 'static-resource',
        }))).toEqual({
            code: 'unsupported_method',
            diagnostics: ['host_api_method_not_installed:unsubscribeResource'],
        });
    });

    it('installs snapshot and invalidation methods only for a dynamic selected Resource capability', async () => {
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                resourceCapability: { readable: true, dynamic: true },
            },
        });

        expect(controller.installedMethods).toContain('readResource');
        expect(controller.installedMethods).toContain('watchResource');
        // Disposal is intentionally a transport operation rather than an
        // advertised author method. Dynamic capability installs its handler
        // behind that private envelope path.
        expect(controller.installedMethods).not.toContain('unsubscribeResource');
        await expect(controller.hostApi.handleRequest(request('disposeHostResource', {
            subscriptionId: 'dynamic-resource',
        }))).resolves.toBeNull();
    });

    it('fences the facade when the captured Account lifetime retires', async () => {
        let accountCurrent = true;
        let retireController: (() => void) | undefined;
        const publication = {
            publish: vi.fn(() => true),
            clear: vi.fn(),
            restore: vi.fn(),
            dispose: vi.fn(),
        };
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                accountLifetime: {
                    scope: { serverId: 'server-1', accountId: 'account-a' },
                    isCurrent: () => accountCurrent,
                    onRetire: (cancel) => {
                        retireController = cancel;
                        return { dispose() {} };
                    },
                },
            },
            binding: {
                createMountedHostApiHandlers: (() => ({
                    handlers: {},
                    currentUiContext: publication,
                })) as never,
            },
        });

        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Account-scoped issue' } },
        })))).resolves.toBeNull();

        accountCurrent = false;
        expect(retireController).toBeTypeOf('function');
        retireController!();

        expect(controller.hostApi.handleRequest(request('context'))).toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(publication.dispose).toHaveBeenCalledTimes(1);
    });

    it('inherits parent mount retirement so a retained targeted child aborts its own Resource work', async () => {
        let parentCurrent = true;
        let retireParent: (() => void) | undefined;
        let resourceSignal: AbortSignal | undefined;
        let settleRead: ((value: Awaited<ReturnType<PluginSurfaceResourceReadTransport>>) => void) | undefined;
        const publication = {
            publish: vi.fn(() => true),
            clear: vi.fn(),
            restore: vi.fn(),
            dispose: vi.fn(),
        };
        const controller = createBoundPluginSurfaceController({
            facts: {
                ...FACTS,
                parentLifetime: {
                    isCurrent: () => parentCurrent,
                    onRetire: (cancel) => {
                        retireParent = cancel;
                        return { dispose() {} };
                    },
                },
            },
            binding: {
                readResource: ((_machineId, options) => {
                    resourceSignal = options.signal;
                    return new Promise((resolve) => { settleRead = resolve; });
                }) as PluginSurfaceResourceReadTransport,
                createMountedHostApiHandlers: (() => ({
                    handlers: {},
                    currentUiContext: publication,
                })) as never,
            },
        });

        await expect(Promise.resolve(controller.hostApi.handleRequest(request('publishCurrentUiContext', {
            enrichment: { entity: { kind: 'issue', label: 'Parent-scoped issue' } },
        })))).resolves.toBeNull();

        const pending = Promise.resolve(controller.hostApi.handleRequest(request('readResource', {
            resource: 'review-summary',
        })));
        expect(resourceSignal?.aborted).toBe(false);

        parentCurrent = false;
        expect(retireParent).toBeTypeOf('function');
        retireParent!();

        // A parent callback retained during offline presentation must not leave
        // B's mounted transport live. The child owns its abort controller, but
        // its sole parent lifetime source is the incumbent controller.
        expect(resourceSignal?.aborted).toBe(true);
        expect(controller.hostApi.handleRequest(request('context'))).toEqual({
            code: 'stale_surface',
            diagnostics: ['plugin_surface_retired'],
        });
        expect(publication.dispose).toHaveBeenCalledTimes(1);

        settleRead!({
            supported: true,
            result: {
                ok: true,
                resource: { pluginId: FACTS.pluginId, localId: 'review-summary' },
                kind: 'asset',
                contentType: 'application/json',
                digest: `sha256:${'a'.repeat(64)}`,
                bytesBase64: 'e30=',
            },
        });
        await expect(pending).resolves.toEqual({
            // Existing Resource cancellation maps to unavailable, while a new
            // post-retirement request above is the typed stale-surface path.
            code: 'unavailable',
            diagnostics: ['plugin_surface_retired'],
        });
    });
});
