import { ActionExecuteFailureSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import type {
    PluginHostedWebBridgeEnvelopeV1,
    PluginHostedWebBridgeHostMessageEnvelopeV1,
    PluginUiEntityDragDropStateV1,
    PluginUiHostMethodV1,
    PluginUiJsonValueV1,
    PluginUiSurfaceContextV1,
} from '@happier-dev/protocol/plugins/ui';
import type { PluginUiHostApi, SurfaceContext } from '@happier-dev/plugin-sdk/ui';
import { describe, expect, it, vi } from 'vitest';

import { createPluginHostedWebHostApiBridgeHandler } from '@/components/plugins/hostApi/hostedWebAdapter';
import { createCanonicalPluginReactNativeHostApiAdapter } from '@/components/plugins/reactNative/hostApi';
import { createPluginSurfaceHostApi } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { createPluginSurfaceHostApiError } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';
import { acquirePluginReactNativeArtifactAvailability } from '@/sync/domains/plugins/availability/reactNativeArtifactAvailability';
import { PluginUiArtifactDigestV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createPluginUiHostApiClientFromTransport } from '../../../../../../packages/plugin-sdk/src/ui/clientTransport';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy/resolveReasonCopy';
import {
    createPluginSurfaceOpenSurfaceHandler,
    type PluginSurfaceOpenHandler,
} from '@/components/plugins/surfaces/openPluginSurface';
import type { PluginSurfaceHostApiHandlers } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { createEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropRuntime';
import { createPluginEntityDragDropBinding } from '../surfaces/entityDragDrop/pluginEntityDragDropBinding';
import { createHostedEntityDragDropHandlers } from './hostedEntityDragDrop';
import { createPluginSurfaceActionControls } from '../surfaces/pluginSurfaceActionControls';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginSurfaceResourceReadHandler } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';

/**
 * One settlement rule, two physical carriers.
 *
 * `openSurface` is the case that forces the rule to exist: the navigation it
 * performs routinely unmounts the surface that requested it, so the mount's
 * retirement is a CONSEQUENCE of the success. A carrier that reads currentness
 * after the settlement and rewrites it into `stale_surface` tells the author
 * nothing happened after something did, and the only sane response to "nothing
 * happened" is to do it again.
 *
 * `openNewSession` is the sibling navigation: the New Session screen it opens
 * replaces the requesting surface, so the same consequence rule applies. A
 * terminal `settleEphemeralInput` is the sibling settlement: the mounted owner
 * records the input and closes the ephemeral surface as a consequence, and the
 * settlement is durable — rewriting it into `stale_surface` would ask the
 * plugin to settle an already-settled input, which can only fail.
 *
 * Finite requests keep their admitted result across an authority change.
 * The next request is admitted against current authority. Carrier disposal
 * after admission (the effect unmounting its own requester) does not rewrite
 * the outcome either; reads opt into their own delivery fence at the adapter.
 *
 * Caller WITHDRAWAL is a different fact from retirement and is never rewritten
 * into success: a launch the caller cancelled before the owner settled it
 * settles as the carrier's typed withdrawal, and a response that arrives after
 * the withdrawal is inert.
 */

const surface: PluginUiSurfaceContextV1 = {
    pluginId: 'acme.preview',
    contributionId: 'preview',
    surfaceId: 'sessionSurface:acme.preview:preview-pane',
    sessionId: 'session-1',
    placement: 'sessionPane',
    platform: 'web',
    channel: 'internal',
    resourceScope: [],
    diagnostics: [],
};

const canonicalIdentity = {
    instanceId: 'instance-1',
    mountNonce: 'nonce-1',
} as const;

const canonicalSurface = {
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'preview' },
        container: 'rightPane',
    },
    target: { kind: 'session', sessionId: 'session-1' },
    platform: 'web',
    locale: 'en',
    direction: 'ltr',
    colorScheme: 'light',
    contrast: 'normal',
    textScale: 1,
    reducedMotion: false,
    screenReaderEnabled: false,
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    translations: {},
    targetedContributions: {
        target: { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' },
        points: [],
    },
} as const;

const destination = { pluginId: 'acme.preview', localId: 'details' } as const;

type MountFixture = Readonly<{
    /** Flipped by the fixture to simulate the mount retiring. */
    retire: () => void;
    isCurrent: () => boolean;
    /** Captured while the mount is live: retirement empties the live set. */
    installedMethods: readonly PluginUiHostMethodV1[];
    host: ReturnType<typeof createPluginSurfaceHostApi>;
}>;

function createMount(input: Readonly<{
    openSurface?: PluginSurfaceOpenHandler;
    confirm?: () => Promise<PluginUiJsonValueV1>;
    /** Additional canonical handlers under test (openNewSession, settleEphemeralInput, …). */
    handlers?: PluginSurfaceHostApiHandlers;
    connection?: Readonly<{ pending: () => boolean; available: () => boolean }>;
}>): MountFixture {
    let current = true;
    const isCurrent = () => current;
    const host = createPluginSurfaceHostApi({
        surfaceContext: surface,
        isCurrent,
        ...(input.connection ? { isMethodAvailable: (method: PluginUiHostMethodV1) => method === 'context' || input.connection!.available(),
            isConnectionPending: input.connection.pending } : {}),
        handlers: {
            ...(input.openSurface
                ? { openSurface: createPluginSurfaceOpenSurfaceHandler(input.openSurface, isCurrent) }
                : {}),
            ...(input.confirm ? { confirm: async () => await input.confirm!() } : {}),
            ...input.handlers,
        },
    });
    return {
        retire: () => { current = false; },
        isCurrent,
        installedMethods: [...host.admissionMethods],
        host,
    };
}

function createNativeCarrier(mount: MountFixture) {
    return createCanonicalPluginReactNativeHostApiAdapter({
        surface: canonicalSurface as unknown as SurfaceContext,
        requestSurface: surface,
        handleRequest: mount.host.handleRequest,
        installedMethods: mount.installedMethods,
        getAdmissionMethods: () => mount.installedMethods,
        isCurrent: mount.isCurrent,
    });
}

function createHostedEnvelope(
    kind: PluginHostedWebBridgeEnvelopeV1['kind'],
    payload: PluginHostedWebBridgeEnvelopeV1['payload'],
    sequence = 7,
): PluginHostedWebBridgeEnvelopeV1 {
    return {
        version: 1,
        identity: canonicalIdentity,
        sequence,
        kind,
        payload,
    };
}

async function createHostedCarrier(mount: MountFixture, methods: readonly PluginUiHostMethodV1[], postToFrame?: (envelope: PluginHostedWebBridgeHostMessageEnvelopeV1) => void) {
    const handler = createPluginHostedWebHostApiBridgeHandler({
        surface,
        requestIdPrefix: 'hosted-settlement',
        identity: canonicalIdentity,
        canonicalHostApi: {
            identity: canonicalIdentity,
            surface: canonicalSurface,
            methods,
        },
        handleRequest: mount.host.handleRequest,
        isCurrent: mount.isCurrent,
        ...(postToFrame ? { postToFrame } : {}),
    });
    await handler(createHostedEnvelope('ready', { ready: true }));
    await handler(createHostedEnvelope('hostApi', {
        wireVersion: 1,
        kind: 'negotiate',
        identity: canonicalIdentity,
        apiRange: '^1.0.0',
    }, 8));
    return handler;
}

async function createAuthorCarrier(mount: MountFixture, kind: 'native' | 'hosted'): Promise<Readonly<{
    api: PluginUiHostApi;
    dispose(): void;
}>> {
    if (kind === 'native') return createNativeCarrier(mount);
    let receive: ((value: unknown) => void) | undefined;
    const handler = await createHostedCarrier(mount, mount.installedMethods, message => receive?.(message.payload));
    let sequence = 20;
    const lifetime = new AbortController();
    const api = await createPluginUiHostApiClientFromTransport({ identity: canonicalIdentity, signal: lifetime.signal,
        transport: {
            subscribe: listener => { receive = listener; return { dispose: () => { receive = undefined; } }; },
            send: async message => {
                const response = await handler(createHostedEnvelope('hostApi', message, sequence++));
                if (response.kind === 'result') receive?.(response.payload);
            },
        } });
    return { api, dispose: () => { lifetime.abort(); handler.dispose(); } };
}

function hostedRequest(
    handler: Awaited<ReturnType<typeof createHostedCarrier>>,
    input: Readonly<{ requestId: string; method: string; payload?: unknown; sequence?: number }>,
) {
    return handler(createHostedEnvelope('hostApi', {
        wireVersion: 1,
        kind: 'request',
        identity: canonicalIdentity,
        requestId: input.requestId,
        method: input.method,
        ...(input.payload === undefined ? {} : { payload: input.payload }),
    } as PluginHostedWebBridgeEnvelopeV1['payload'], input.sequence ?? 9));
}

describe('outward-effect settlement across the React Native and hosted-web carriers', () => {
    it.each(['native', 'hosted'] as const)('preserves the canonical Action refusal request id through %s', async kind => {
        let requestId = '';
        const mount = createMount({ handlers: { executeAction: request => {
            requestId = request.requestId;
            return createPluginSurfaceHostApiError('unavailable', ['plugin_surface_action_projection_unavailable']);
        } } });
        const carrier = await createAuthorCarrier(mount, kind);
        try {
            const error: unknown = await carrier.api.executeAction({ pluginId: 'happier.channels',
                localId: 'session-pull-request-binding-v1' }, {}).catch(error => error);
            expect(requestId).not.toBe('');
            expect(error).toMatchObject({ code: 'unavailable', details: { requestId },
                diagnostics: [{ code: 'plugin_surface_action_projection_unavailable', severity: 'error' }] });
        } finally { carrier.dispose(); mount.host.dispose?.(); }
    });
    it.each(['native', 'hosted'] as const)('finishes an admitted Resource read through %s before refusing the next request', async kind => {
        let release!: () => void;
        let started = false;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const digest = `sha256:${'a'.repeat(64)}` as const;
        const readResource = createPluginSurfaceResourceReadHandler({ pluginId: surface.pluginId,
            isCurrent: () => mount.isCurrent(),
            resource: { machineId: 'machine-1', expectedCallerOccurrenceId: 'occurrence-1',
                read: async (_machine, options) => {
                    started = true;
                    await pending;
                    return { supported: true, result: { ok: true, resource: options.resource, kind: 'config',
                        contentType: 'application/json', digest, bytesBase64: 'e30=' } };
                } },
        });
        const mount = createMount({ handlers: { readResource } });
        const native = kind === 'native' ? createNativeCarrier(mount) : null;
        const hosted = kind === 'hosted' ? await createHostedCarrier(mount, mount.installedMethods) : null;
        try {
            const read = native ? native.api.readResource('status') : hostedRequest(hosted!, {
                requestId: 'read', method: 'readResource', payload: { resource: 'status' },
            });
            await vi.waitFor(() => expect(started).toBe(true));
            mount.retire();
            release();
            await expect(read).resolves.toMatchObject(native ? { digest }
                : { kind: 'result', payload: { kind: 'result', result: { digest } } });
            if (native) await expect(native.api.readResource('status')).rejects.toMatchObject({ code: 'stale_surface' });
            else await expect(hostedRequest(hosted!, { requestId: 'next-read', method: 'readResource',
                payload: { resource: 'status' }, sequence: 10,
            })).resolves.toMatchObject({ kind: 'error', payload: { code: 'stale_surface' } });
        } finally { release(); native?.dispose(); hosted?.dispose(); mount.host.dispose?.(); }
    });

    it.each(['native', 'hosted'] as const)('drops a late Resource reply after %s disposal', async kind => {
        let release!: () => void;
        let started = false;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const readResource = createPluginSurfaceResourceReadHandler({ pluginId: surface.pluginId,
            resource: { machineId: 'machine-1', expectedCallerOccurrenceId: 'occurrence-1',
                read: async (_machine, options) => {
                    started = true;
                    await pending;
                    return { supported: true, result: { ok: true, resource: options.resource, kind: 'config',
                        contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`, bytesBase64: 'e30=' } };
                } },
        });
        const mount = createMount({ handlers: { readResource } });
        const carrier = await createAuthorCarrier(mount, kind);
        try {
            const read = carrier.api.readResource('status');
            const noReply = expect(read).rejects.toBeInstanceOf(Error);
            await vi.waitFor(() => expect(started).toBe(true));
            carrier.dispose();
            release();
            await noReply;
        } finally { release(); carrier.dispose(); mount.host.dispose?.(); }
    });
    it.each(['native', 'hosted'] as const)('preserves host Action preparation and original settlement custody through %s', async kind => {
        const execution = { ok: false as const, errorCode: 'action_outcome_unknown', error: 'Acceptance unknown',
            details: { operationId: 'original-operation' } };
        // Authenticated Project transport is the external boundary; control,
        // canonical executor, policy and both physical adapters remain real.
        const projectAction = vi.fn(async () => execution);
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ projectAction }));
        const lifetime = new AbortController();
        const controls = createPluginSurfaceActionControls({ pluginId: surface.pluginId, surfaceId: surface.surfaceId,
            hostAction: { execute: executor.execute, context: { serverId: 'home', runtimeAccountId: 'account' } },
            signal: lifetime.signal, isCurrent: () => mount.isCurrent(), captureCurrentBinding: () => () => mount.isCurrent() });
        const mount = createMount({ handlers: { actionControl: controls.handleRequest } });
        const carrier = await createAuthorCarrier(mount, kind);
        const preparedInput = { workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' },
            executable: '/usr/bin/tool', argv: ['check'], cwd: '/repo', choice: { kind: 'primary' as const } };
        const prepare = vi.fn(() => ({ input: preparedInput }));
        const onSettled = vi.fn();
        try {
            const control = await carrier.api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Run' } }, { prepare, onSettled });
            expect(prepare).not.toHaveBeenCalled();
            expect(projectAction).not.toHaveBeenCalled();
            expect(controls.getSnapshot()).toHaveLength(1);
            await controls.press(controls.getSnapshot()[0]!.id);
            expect(prepare).toHaveBeenCalledTimes(1);
            expect(projectAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actionId: 'projects.compute.exec', input: preparedInput,
                context: expect.objectContaining({ surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }) }));
            expect(onSettled).toHaveBeenCalledExactlyOnceWith(execution);
            await control.update({ title: 'Run again', disabled: true });
            expect(controls.getSnapshot()[0]?.presentation).toEqual({ title: 'Run again', disabled: true });
            await controls.press(controls.getSnapshot()[0]!.id);
            expect(projectAction).toHaveBeenCalledTimes(1);
            await control.dispose();
            await vi.waitFor(() => expect(controls.getSnapshot()).toEqual([]));
        } finally { lifetime.abort(); carrier.dispose(); mount.host.dispose?.(); }
    });

    it.each(['native', 'hosted'] as const)('retires %s preparation without accepting late input or executing an Action', async kind => {
        const projectAction = vi.fn(async () => ({ ok: false as const, errorCode: 'unexpected_execution', error: 'unexpected_execution' }));
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ projectAction }));
        const lifetime = new AbortController();
        const controls = createPluginSurfaceActionControls({ pluginId: surface.pluginId, surfaceId: surface.surfaceId,
            hostAction: { execute: executor.execute, context: {} }, signal: lifetime.signal,
            isCurrent: () => mount.isCurrent(), captureCurrentBinding: () => () => mount.isCurrent() });
        const mount = createMount({ handlers: { actionControl: controls.handleRequest } });
        const carrier = await createAuthorCarrier(mount, kind);
        let finish: ((value: { input: null }) => void) | undefined;
        let signal: AbortSignal | undefined;
        const prepare = vi.fn((options: { signal: AbortSignal }) => {
            signal = options.signal;
            return new Promise<{ input: null }>(resolve => { finish = resolve; });
        });
        const onSettled = vi.fn();
        try {
            const control = await carrier.api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Run' } }, { prepare, onSettled });
            const press = controls.press(controls.getSnapshot()[0]!.id);
            await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
            await control.dispose();
            expect(signal?.aborted).toBe(true);
            finish?.({ input: null });
            await press;
            expect(projectAction).not.toHaveBeenCalled();
            expect(onSettled).not.toHaveBeenCalled();
            expect(controls.getSnapshot()).toEqual([]);
        } finally { lifetime.abort(); carrier.dispose(); mount.host.dispose?.(); }
    });

    it.each(['native', 'hosted'] as const)('invalidates %s preparation on authority change while retaining the control for a fresh press', async kind => {
        const execution = { ok: false as const, errorCode: 'action_outcome_unknown', error: 'Acceptance unknown',
            details: { operationId: 'original-operation' } };
        const projectAction = vi.fn(async () => execution);
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ projectAction }));
        const lifetime = new AbortController();
        let authority = 'machine-one';
        const controls = createPluginSurfaceActionControls({ pluginId: surface.pluginId, surfaceId: surface.surfaceId,
            hostAction: { execute: executor.execute, context: {} }, signal: lifetime.signal,
            isCurrent: () => mount.isCurrent(), captureCurrentBinding: () => {
                const captured = authority;
                return () => mount.isCurrent() && authority === captured;
            } });
        const mount = createMount({ handlers: { actionControl: controls.handleRequest } });
        const carrier = await createAuthorCarrier(mount, kind);
        let finish: ((value: { input: null }) => void) | undefined;
        let preparedSignal: AbortSignal | undefined;
        let preparations = 0;
        const prepare = vi.fn((options: { signal: AbortSignal }) => {
            preparedSignal = options.signal;
            preparations += 1;
            if (preparations === 1) return new Promise<{ input: null }>(resolve => { finish = resolve; });
            return { input: { workspace: { serverId: 'home', workspaceId: 'workspace', machineId: authority, rootPath: '/repo' },
                executable: '/usr/bin/tool', argv: ['check'], cwd: '/repo', choice: { kind: 'primary' } } };
        });
        const onSettled = vi.fn();
        let firstPress: Promise<void> | undefined;
        try {
            const control = await carrier.api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Run' } }, { prepare, onSettled });
            const id = controls.getSnapshot()[0]!.id;
            firstPress = controls.press(id);
            await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
            authority = 'machine-two';
            controls.invalidatePreparations();
            await firstPress;
            expect(preparedSignal?.aborted).toBe(true);
            expect(onSettled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ok: false, errorCode: 'stale_surface' }));
            expect(projectAction).not.toHaveBeenCalled();
            expect(controls.getSnapshot()).toHaveLength(1);
            finish?.({ input: null });
            await Promise.resolve();
            await controls.press(id);
            expect(prepare).toHaveBeenCalledTimes(2);
            expect(projectAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: expect.objectContaining({
                workspace: expect.objectContaining({ machineId: 'machine-two' }),
            }) }));
            expect(onSettled).toHaveBeenNthCalledWith(2, execution);
            await control.dispose();
        } finally {
            lifetime.abort(); carrier.dispose(); mount.host.dispose?.();
            await firstPress;
        }
    });

    it.each(['native', 'hosted'] as const)('wakes a real pre-invocation transport refusal at the %s author API and keeps domain error-shaped data', async kind => {
        let connecting = true;
        let effects = 0;
        const mount = createMount({ connection: { pending: () => connecting, available: () => !connecting },
            handlers: { executeAction: () => {
                effects++;
                return { code: 'unavailable', value: 'ordinary Action data' };
            } } });
        const carrier = await createAuthorCarrier(mount, kind);
        try {
            const pending = carrier.api.executeAction({ pluginId: surface.pluginId, localId: 'run' }, null);
            await Promise.resolve(); await Promise.resolve();
            expect(effects).toBe(0);
            connecting = false;
            mount.host.notifyConnectionSettled?.();
            await expect(pending).resolves.toEqual({ code: 'unavailable', value: 'ordinary Action data' });
            mount.host.notifyConnectionSettled?.();
            expect(effects).toBe(1);
        } finally { carrier.dispose(); mount.host.dispose?.(); }
    });
    it.each(['native', 'hosted'] as const)('preserves a real terminal slot refusal at the %s author API without re-polling', async kind => {
        const scope = { serverId: 'reason-home', accountId: 'reason-account' };
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } });
        const reader = store.bind(scope);
        let admissions = 0;
        const mount = createMount({ handlers: { executeAction: async () => {
            admissions++;
            const refusal = await acquirePluginReactNativeArtifactAvailability({ reader,
                accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) },
                isCurrent: () => true,
                // A closed slot is refused before graph/byte acquisition.
                artifactGraph: null,
                cacheIdentity: { pluginId: surface.pluginId, contributionId: surface.contributionId,
                    artifactId: 'ui', artifactDigest: PluginUiArtifactDigestV1Schema.parse(`sha256:${'0'.repeat(64)}`), platform: 'web' },
            });
            if (refusal.kind !== 'unavailable') throw new Error('Expected real missing slot');
            return createPluginSurfaceHostApiError(refusal.code, [], undefined,
                { layer: refusal.layer, phase: refusal.phase, retryable: refusal.retryable });
        } } });
        const carrier = await createAuthorCarrier(mount, kind);
        try {
            const error: unknown = await carrier.api.executeAction({ pluginId: surface.pluginId, localId: 'run' }, null).catch(error => error);
            expect(error).toMatchObject({ code: 'artifact_not_current', retryable: false,
                details: { layer: 'artifact', phase: 'preparation' },
                message: resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: 'artifact_not_current' }).body,
                data: { code: 'artifact_not_current', details: { layer: 'artifact', phase: 'preparation' }, retryable: false } });
            mount.host.notifyConnectionSettled?.();
            mount.host.notifyConnectionSettled?.();
            expect(admissions).toBe(1);
        } finally { carrier.dispose(); mount.host.dispose?.(); }
    });
    it('projects exact-source semantic feedback through both real carriers and retires their existing subscription leases', async () => {
        const runtime = createEntityDragDropRuntime();
        const scope = { serverId: 'home', accountId: 'account' };
        const sourceDefinition = { id: 'issue', title: 'Issue', client: { artifactId: 'ui', exportName: 'activate' }, platforms: ['web' as const], referenceSchema: { type: 'string' as const } };
        const source = { descriptor: sourceDefinition, describe: () => ({ title: 'Issue' }), isCurrent: () => true };
        const target = { descriptor: { id: 'board', title: 'Board', client: sourceDefinition.client, platforms: sourceDefinition.platforms, acceptedKinds: ['plugin:acme.preview/issue' as const], actions: [{ kind: 'plugin' as const, action: 'add' }] }, resolve: () => ({ status: 'allowed' as const, effect: { actionId: 'plugin:acme.preview/add', input: {}, preview: { verb: 'Add', target: 'Board' } } }), isCurrent: () => true };
        const writes: unknown[] = [];
        const binding = createPluginEntityDragDropBinding({ runtime, pluginId: 'acme.preview', mountKey: 'carrier', scope, isCurrent: () => true, readSource: () => source, readTarget: () => target, executeAction: async (_action, input) => { writes.push(input); return { status: 'applied' }; } });
        const hostedOwner = createHostedEntityDragDropHandlers({ binding, isCurrent: () => true, readSessionItem: () => null });
        const mount = createMount({ handlers: hostedOwner.handlers });
        const native = createNativeCarrier(mount);
        await native.api.updateEntityDragDrop({ kind: 'mountSource', mountId: 'first', sourceId: 'issue', reference: 'first' });
        await native.api.updateEntityDragDrop({ kind: 'mountSource', mountId: 'second', sourceId: 'issue', reference: 'second' });
        const targetMount = binding.mountTarget({ mountId: 'target', targetId: 'board', getBounds: () => null })!;
        const nativeStates: PluginUiEntityDragDropStateV1[] = [];
        const subscription = await native.api.watchEntityDragDrop({ mountId: 'first' }, state => { nativeStates.push(state); });
        const frames: PluginHostedWebBridgeHostMessageEnvelopeV1[] = [];
        const hosted = await createHostedCarrier(mount, mount.installedMethods, frame => { frames.push(frame); });
        await hosted(createHostedEnvelope('hostApi', { wireVersion: 1, kind: 'subscribe', identity: canonicalIdentity, requestId: 'watch', subscriptionId: 'second-watch', method: 'watchEntityDragDrop', payload: { mountId: 'second' } }));
        const hostedState = () => {
            const payload = frames.at(-1)?.payload;
            return payload && typeof payload === 'object' && !Array.isArray(payload) && 'event' in payload ? payload.event : null;
        };
        await native.api.updateEntityDragDrop({ kind: 'begin', mountId: 'first', input: 'keyboard', pointer: { x: 0, y: 0 }, viewport: { width: 100, height: 100 } });
        await native.api.updateEntityDragDrop({ kind: 'choose', mountId: 'first', targetId: targetMount.id });
        expect(nativeStates.at(-1)).toMatchObject({ phase: 'carrying', admission: { status: 'allowed' } });
        expect(hostedState()).toMatchObject({ phase: 'idle', admission: null, outcome: null });
        await hostedRequest(hosted, { requestId: 'second-begin', method: 'updateEntityDragDrop', payload: { kind: 'begin', mountId: 'second', input: 'keyboard', pointer: { x: 0, y: 0 }, viewport: { width: 100, height: 100 } } });
        await hostedRequest(hosted, { requestId: 'second-choose', method: 'updateEntityDragDrop', payload: { kind: 'choose', mountId: 'second', targetId: targetMount.id } });
        expect(nativeStates.at(-1)).toMatchObject({ phase: 'idle', admission: null });
        expect(hostedState()).toMatchObject({ phase: 'carrying', admission: { status: 'allowed' } });
        targetMount.dispose();
        expect(hostedState()).toMatchObject({ admission: null, destinations: [] });
        await hostedRequest(hosted, { requestId: 'second-retire', method: 'updateEntityDragDrop', payload: { kind: 'unmount', mountId: 'second' } });
        expect(hostedState()).toMatchObject({ current: false, phase: 'idle', admission: null });
        await subscription.dispose();
        const count = nativeStates.length;
        runtime.begin(binding.runtimeMountId('first'));
        expect(nativeStates).toHaveLength(count);
        expect(writes).toEqual([]);
        hosted.dispose(); native.dispose(); hostedOwner.dispose(); binding.dispose();
    });
    it('preserves an applied entity-drop settlement when its Action retires the surface', async () => {
        const nativeMount = createMount({ handlers: { updateEntityDragDrop: () => { nativeMount.retire(); return { accepted: true, outcome: { status: 'applied' } }; } } });
        await expect(createNativeCarrier(nativeMount).api.updateEntityDragDrop({ kind: 'commit', mountId: 'source' })).resolves.toEqual({ accepted: true, outcome: { status: 'applied' } });
        const hostedMount = createMount({ handlers: { updateEntityDragDrop: () => { hostedMount.retire(); return { accepted: true, outcome: { status: 'applied' } }; } } });
        const hosted = await createHostedCarrier(hostedMount, ['updateEntityDragDrop']);
        await expect(hostedRequest(hosted, { requestId: 'drop-settled', method: 'updateEntityDragDrop', payload: { kind: 'commit', mountId: 'source' } })).resolves.toMatchObject({ kind: 'result', payload: { kind: 'result', result: { accepted: true, outcome: { status: 'applied' } } } });
    });
    // Scenario: contributor retirement AFTER success / disconnect AFTER a known
    // settlement. These are the same transport fact — currentness read after the
    // owner settled — and `openSurface` produces it by construction.
    it('delivers a navigation that retired its own mount, on both carriers', async () => {
        const nativeMount = createMount({
            openSurface: async () => { nativeMount.retire(); return { ok: true as const }; },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openSurface(destination)).resolves.toBeUndefined();

        const hostedMount = createMount({
            openSurface: async () => { hostedMount.retire(); return { ok: true as const }; },
        });
        const hosted = await createHostedCarrier(hostedMount, ['openSurface']);
        await expect(hostedRequest(hosted, {
            requestId: 'open-1',
            method: 'openSurface',
            payload: { destination },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'openSurface' },
        });
    });

    it('preserves input navigation success when the route retires its requesting mount on both carriers', async () => {
        const nativeMount = createMount({ handlers: { revealSessionInput: () => { nativeMount.retire(); return null; } } });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.revealSessionInput({ sessionId: 'session-1', localId: 'exact-input' })).resolves.toBeUndefined();
        const hostedMount = createMount({ handlers: { revealSessionInput: () => { hostedMount.retire(); return null; } } });
        const hosted = await createHostedCarrier(hostedMount, ['revealSessionInput']);
        await expect(hostedRequest(hosted, { requestId: 'input-reveal', method: 'revealSessionInput',
            payload: { sessionId: 'session-1', localId: 'exact-input' } })).resolves.toMatchObject({
            kind: 'result', payload: { kind: 'result', method: 'revealSessionInput' },
        });
    });

    it('preserves an admitted confirmation when authority retires, on both carriers', async () => {
        const nativeMount = createMount({
            openSurface: async () => ({ ok: true as const }),
            confirm: async () => { nativeMount.retire(); return { confirmed: true }; },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.confirm('Delete the preview?')).resolves.toBe(true);

        const hostedMount = createMount({
            openSurface: async () => ({ ok: true as const }),
            confirm: async () => { hostedMount.retire(); return { confirmed: true }; },
        });
        const hosted = await createHostedCarrier(hostedMount, ['confirm']);
        await expect(hostedRequest(hosted, {
            requestId: 'confirm-1',
            method: 'confirm',
            payload: { message: 'Delete the preview?' },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', result: { confirmed: true } },
        });
    });

    it('preserves the owner error when authority retires, on both carriers', async () => {
        const nativeMount = createMount({
            confirm: async () => {
                nativeMount.retire();
                throw new Error('confirmation_owner_failed');
            },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.confirm('Delete the preview?')).rejects.toMatchObject({
            name: 'PluginError',
            code: 'internal_error',
        });

        const hostedMount = createMount({
            confirm: async () => {
                hostedMount.retire();
                throw new Error('confirmation_owner_failed');
            },
        });
        const hosted = await createHostedCarrier(hostedMount, ['confirm']);
        await expect(hostedRequest(hosted, {
            requestId: 'confirm-error-retired',
            method: 'confirm',
            payload: { message: 'Delete the preview?' },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'error', error: { code: 'internal_error' } },
        });
    });

    // Scenario: disconnect BEFORE any settlement. Nothing was applied, so the
    // refusal is truthful on both carriers and the author may retry.
    it('refuses a navigation whose mount retired before the placement settled', async () => {
        const nativeMount = createMount({
            openSurface: async () => ({ ok: true as const }),
        });
        nativeMount.retire();
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openSurface(destination)).rejects.toMatchObject({
            name: 'PluginError',
            code: 'stale_surface',
        });

        const hostedMount = createMount({
            openSurface: async () => ({ ok: true as const }),
        });
        const hosted = await createHostedCarrier(hostedMount, ['openSurface']);
        hostedMount.retire();
        // A bridge whose mount is already retired refuses at its own entry,
        // before the request can reach the owner at all.
        await expect(hostedRequest(hosted, {
            requestId: 'open-stale',
            method: 'openSurface',
            payload: { destination },
        })).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'stale_surface' },
        });
    });

    // Scenario: the New Session launch is the sibling navigation. The New
    // Session screen replaces the requesting surface, so the retirement is a
    // CONSEQUENCE of the success and must not rewrite it on either carrier.
    it('delivers a New Session launch that retired its own mount, on both carriers', async () => {
        const nativeMount = createMount({
            handlers: {
                openNewSession: async () => {
                    nativeMount.retire();
                    return null;
                },
            },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openNewSession({ prompt: 'Repair CI' })).resolves.toBeUndefined();

        const hostedMount = createMount({
            handlers: {
                openNewSession: async () => {
                    hostedMount.retire();
                    return null;
                },
            },
        });
        const hosted = await createHostedCarrier(hostedMount, ['openNewSession']);
        await expect(hostedRequest(hosted, {
            requestId: 'new-session-1',
            method: 'openNewSession',
            payload: { prompt: 'Repair CI' },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'openNewSession' },
        });
    });

    // Scenario: the terminal ephemeral settlement is the sibling durable
    // settlement. The mounted owner records the input and closes the ephemeral
    // surface as a consequence; a rewritten `stale_surface` would invite the
    // plugin to settle an already-settled input, which can only fail.
    it('delivers a terminal ephemeral settlement that retired its own mount, on both carriers', async () => {
        const nativeMount = createMount({
            handlers: {
                settleEphemeralInput: async () => {
                    nativeMount.retire();
                    return null;
                },
            },
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.settleEphemeralInput({ kind: 'completed', input: { answer: 7 } }))
            .resolves.toBeUndefined();

        const hostedMount = createMount({
            handlers: {
                settleEphemeralInput: async () => {
                    hostedMount.retire();
                    return null;
                },
            },
        });
        const hosted = await createHostedCarrier(hostedMount, ['settleEphemeralInput']);
        await expect(hostedRequest(hosted, {
            requestId: 'ephemeral-1',
            method: 'settleEphemeralInput',
            payload: { kind: 'completed', input: { answer: 7 } },
        })).resolves.toMatchObject({
            kind: 'result',
            payload: { kind: 'result', method: 'settleEphemeralInput' },
        });
    });

    // Scenario: retirement BEFORE any settlement. Nothing launched and nothing
    // was recorded, so the refusal stays truthful on both carriers.
    it('still refuses a New Session launch whose mount retired before the placement settled', async () => {
        const nativeMount = createMount({
            handlers: { openNewSession: async () => null },
        });
        nativeMount.retire();
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openNewSession({ prompt: 'Repair CI' })).rejects.toMatchObject({
            name: 'PluginError',
            code: 'stale_surface',
        });

        const hostedMount = createMount({
            handlers: { openNewSession: async () => null },
        });
        const hosted = await createHostedCarrier(hostedMount, ['openNewSession']);
        hostedMount.retire();
        await expect(hostedRequest(hosted, {
            requestId: 'new-session-stale',
            method: 'openNewSession',
            payload: { prompt: 'Repair CI' },
        })).resolves.toMatchObject({
            kind: 'error',
            payload: { code: 'stale_surface' },
        });
    });

    // Scenario: the effect's own consequence TEARS DOWN the requesting surface
    // (unmount retires the mount and disposes its carrier) before the admitted
    // settlement reaches the caller — New Session swapping the docked draft
    // under the picker that asked. Admission already decided currentness; the
    // settled effect is delivered as success on both carriers.
    const tornDownEffects = [
        { method: 'openNewSession', payload: { prompt: 'Repair CI' },
            invoke: (api: PluginUiHostApi) => api.openNewSession({ prompt: 'Repair CI' }) },
        { method: 'openSurface', payload: { destination },
            invoke: (api: PluginUiHostApi) => api.openSurface(destination) },
        { method: 'revealSessionInput', payload: { sessionId: 'session-1', localId: 'exact-input' },
            invoke: (api: PluginUiHostApi) => api.revealSessionInput({ sessionId: 'session-1', localId: 'exact-input' }) },
        { method: 'settleEphemeralInput', payload: { kind: 'completed', input: { answer: 7 } },
            invoke: (api: PluginUiHostApi) => api.settleEphemeralInput({ kind: 'completed', input: { answer: 7 } }) },
    ] as const;
    function createTearingDownMount(method: PluginUiHostMethodV1, tearDown: () => void): MountFixture {
        const settle = async () => { tearDown(); return method === 'openSurface' ? { ok: true as const } : null; };
        return method === 'openSurface'
            ? createMount({ openSurface: settle })
            : createMount({ handlers: { [method]: settle } });
    }

    it.each(tornDownEffects)('delivers $method whose settlement tore down its own surface, on both carriers', async ({ method, payload, invoke }) => {
        let native: ReturnType<typeof createNativeCarrier> | undefined;
        const nativeMount = createTearingDownMount(method, () => { nativeMount.retire(); native?.dispose(); });
        native = createNativeCarrier(nativeMount);
        await expect(invoke(native.api)).resolves.toBeUndefined();

        let hosted: Awaited<ReturnType<typeof createHostedCarrier>> | undefined;
        const hostedMount = createTearingDownMount(method, () => { hostedMount.retire(); hosted?.dispose(); });
        hosted = await createHostedCarrier(hostedMount, [method]);
        await expect(hostedRequest(hosted, { requestId: `torn-down-${method}`, method, payload }))
            .resolves.toMatchObject({ kind: 'result', payload: { kind: 'result', method } });
    });

    // Scenario: the surface was torn down BEFORE admission. Nothing ran, so
    // the request is refused and the owner is never invoked.
    it.each(tornDownEffects)('refuses $method on a surface torn down before admission, on both carriers', async ({ method, payload, invoke }) => {
        let invoked = 0;
        const nativeMount = createTearingDownMount(method, () => { invoked += 1; });
        const native = createNativeCarrier(nativeMount);
        nativeMount.retire();
        native.dispose();
        await expect(invoke(native.api)).rejects.toMatchObject({ name: 'PluginError', code: 'stale_surface' });

        const hostedMount = createTearingDownMount(method, () => { invoked += 1; });
        const hosted = await createHostedCarrier(hostedMount, [method]);
        hostedMount.retire();
        hosted.dispose();
        await expect(hostedRequest(hosted, { requestId: `torn-down-early-${method}`, method, payload }))
            .resolves.not.toMatchObject({ payload: { kind: 'result' } });
        expect(invoked).toBe(0);
    });

    // Scenario: the placement refused. No effect happened, so the refusal
    // reaches the author unchanged and carries its own retry classification.
    it('carries a placement refusal through unchanged, with its own retry classification', async () => {
        const nativeMount = createMount({
            openSurface: async () => ({
                ok: false as const,
                code: 'unavailable' as const,
                reason: 'plugin_surface_open_destination_unknown',
            }),
        });
        const native = createNativeCarrier(nativeMount);
        await expect(native.api.openSurface(destination)).rejects.toMatchObject({
            name: 'PluginError',
            code: 'unavailable',
            // An unknown destination is terminal. A coarse unavailable code
            // does not establish retry safety.
            retryable: false,
            diagnostics: [{ code: 'plugin_surface_open_destination_unknown', severity: 'error' }],
        });

        const hostedMount = createMount({
            openSurface: async () => ({
                ok: false as const,
                code: 'unavailable' as const,
                reason: 'plugin_surface_open_destination_unknown',
            }),
        });
        const hosted = await createHostedCarrier(hostedMount, ['openSurface']);
        await expect(hostedRequest(hosted, {
            requestId: 'open-refused',
            method: 'openSurface',
            payload: { destination },
        })).resolves.toMatchObject({
            payload: { kind: 'error', error: { code: 'unavailable' } },
        });
    });

    // Scenario: the caller withdrew. Each carrier keeps its own withdrawal
    // semantics (the hosted guest settles its own promise the moment it
    // aborts), so this asserts only that a withdrawal is never reported as a
    // completed effect.
    it('answers a withdrawn request as a withdrawal rather than a completed effect', async () => {
        let settleOpen: ((outcome: { ok: true }) => void) | undefined;
        const hostedMount = createMount({
            openSurface: () => new Promise((resolve) => { settleOpen = resolve; }),
        });
        const hosted = await createHostedCarrier(hostedMount, ['openSurface']);
        const inFlight = hostedRequest(hosted, {
            requestId: 'open-withdrawn',
            method: 'openSurface',
            payload: { destination },
        });
        await vi.waitFor(() => expect(settleOpen).toBeTypeOf('function'));
        await expect(hosted(createHostedEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'cancel',
            identity: canonicalIdentity,
            requestId: 'open-withdrawn',
        } as PluginHostedWebBridgeEnvelopeV1['payload'], 11))).resolves.toMatchObject({ kind: 'ack' });
        settleOpen?.({ ok: true });
        await expect(inFlight).resolves.toMatchObject({ kind: 'ack' });
    });

    // Scenario: the caller withdrew a New Session launch BEFORE the owner
    // settled it. The direct carrier must settle the withdrawal promptly — not
    // wait for parked handler cooperation — and a response that arrives after
    // the withdrawal is inert.
    it('settles a withdrawn New Session launch promptly on the direct carrier and fences its late response', async () => {
        const controller = new AbortController();
        let settleLaunch: (() => void) | undefined;
        let seenSignal: AbortSignal | undefined;
        const nativeMount = createMount({
            handlers: {
                openNewSession: async (_request, options) => {
                    seenSignal = options?.signal;
                    return await new Promise<PluginUiJsonValueV1>((resolve) => {
                        settleLaunch = () => resolve(null);
                    });
                },
            },
        });
        const native = createNativeCarrier(nativeMount);
        const launch = native.api.openNewSession({ prompt: 'Repair CI' }, { signal: controller.signal });
        const settlements: unknown[] = [];
        void launch.then(
            () => settlements.push({ kind: 'result' }),
            (error: unknown) => settlements.push({ kind: 'error', error }),
        );

        try {
            await vi.waitFor(() => expect(seenSignal).toBeTypeOf('object'));
            controller.abort();

            await vi.waitFor(() => expect(settlements).toHaveLength(1), { timeout: 250 });
            expect(settlements[0]).toMatchObject({
                kind: 'error',
                error: {
                    code: 'unavailable',
                    diagnostics: [{ code: 'aborted', severity: 'error' }],
                },
            });

            settleLaunch?.();
            await vi.waitFor(() => expect(settlements).toHaveLength(1));
            expect(settlements[0]).toMatchObject({ kind: 'error' });
        } finally {
            settleLaunch?.();
            await launch.catch(() => undefined);
        }
    });

    // Scenario: the hosted carrier's cancel wire message reaches the parked
    // mounted handler (the dialog/surface behind it is retired there), and the
    // abandoned request never becomes a completed launch.
    it('cancels a parked New Session launch at the mounted handler on the hosted carrier', async () => {
        let settleLaunch: (() => void) | undefined;
        let seenSignal: AbortSignal | undefined;
        const hostedMount = createMount({
            handlers: {
                openNewSession: async (_request, options) => {
                    seenSignal = options?.signal;
                    return await new Promise<PluginUiJsonValueV1>((resolve) => {
                        settleLaunch = () => resolve(null);
                    });
                },
            },
        });
        const hosted = await createHostedCarrier(hostedMount, ['openNewSession']);
        const launch = hostedRequest(hosted, {
            requestId: 'new-session-cancelled',
            method: 'openNewSession',
            payload: { prompt: 'Repair CI' },
        });
        await vi.waitFor(() => expect(seenSignal).toBeTypeOf('object'));

        await expect(hosted(createHostedEnvelope('hostApi', {
            wireVersion: 1,
            kind: 'cancel',
            identity: canonicalIdentity,
            requestId: 'new-session-cancelled',
        } as PluginHostedWebBridgeEnvelopeV1['payload'], 11))).resolves.toMatchObject({ kind: 'ack' });
        expect(seenSignal?.aborted).toBe(true);

        settleLaunch?.();
        await expect(launch).resolves.toMatchObject({ kind: 'ack' });
    });
});


describe('Action failure presentation through plugin UI carriers', () => {
    it.each(['native', 'hosted'] as const)('%s returns the host presenter and disclosure fields', async kind => {
        const mount = createMount({});
        const carrier = await createAuthorCarrier(mount, kind);
        try {
            expect(carrier.api.version().methods).toContain('presentActionFailure');
            const failure = ActionExecuteFailureSchema.parse({ ok: false as const, errorCode: 'mode_none', error: 'mode_none', requestId: 'failed-action-1',
                details: { reasonCode: 'administrator_required', token: 'private-token' },
                failureCause: projectActionFailureCauseV1(Object.assign(new Error('private provider text'), { code: 'not_preauthorized', status: 403 }), 'dispatch') });
            const presentation = await carrier.api.presentActionFailure!(failure);
            expect(presentation.reason).toBe(resolveActionExecutionFailureMessage(failure, t('common.requestFailed')));
            expect(presentation.nextStep).toBeNull();
            expect(presentation.technicalDetails).toEqual(expect.arrayContaining([
                expect.objectContaining({ key: 'code', value: 'mode_none' }),
                expect.objectContaining({ key: 'requestId', value: 'failed-action-1' }),
                expect.objectContaining({ key: 'reasonCode', value: 'administrator_required' }),
                expect.objectContaining({ key: 'causeCode', value: 'not_preauthorized' }),
                expect.objectContaining({ key: 'httpStatus', value: '403' }),
            ]));
            expect(JSON.stringify(presentation)).not.toContain('private-token');
            const unknown = { ok: false as const, errorCode: 'future_failure' };
            expect((await carrier.api.presentActionFailure!(unknown)).reason)
                .toBe(t('common.requestFailed'));
            expect((await carrier.api.presentActionFailure!(unknown)).reason)
                .toBe(resolveActionExecutionFailureMessage(unknown, t('common.requestFailed')));
        } finally { carrier.dispose(); mount.host.dispose?.(); }
    });
    it('uses producer message and correlation on an older host without sending the new method', async () => {
        const failure = { ok: false as const, errorCode: 'future_failure', error: 'Producer reason', requestId: 'old-host-request' };
        const { presentActionFailure } = await import('../../../../../../packages/plugin-sdk/src/ui/actionFailurePresentation');
        const presentation = await presentActionFailure({ version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: [] }), presentActionFailure: async () => { throw new Error('Older host must not receive the method'); } }, failure);
        expect(presentation.reason).toBe(failure.error);
        expect(presentation.technicalDetails.map(line => line.value)).toEqual([failure.errorCode, failure.requestId]);
    });
});
