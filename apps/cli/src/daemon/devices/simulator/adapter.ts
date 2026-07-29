import type {
    AndroidSimulatorAdapterHealthV1,
    IosSimulatorAdapterHealthV1,
    SimulatorDeviceResourceV1,
    SimulatorPlatformV1,
    SimulatorPreviewActionResultV1,
    SimulatorPreviewActionTypeV1,
    SimulatorPreviewActionV1,
} from '@happier-dev/protocol';

import { createSimulatorPlatformDiagnosticsReader } from './platform/diagnostics';

type MaybePromise<T> = T | Promise<T>;

export type SimulatorPreviewDaemonAdapterDispatchInput = Readonly<{
    event: SimulatorPreviewActionV1;
    resources: readonly SimulatorDeviceResourceV1[];
}>;

export type SimulatorPreviewDaemonAdapterDispatch = (
    input: SimulatorPreviewDaemonAdapterDispatchInput,
) => MaybePromise<SimulatorPreviewActionResultV1 | void>;

export type SimulatorPreviewDaemonAdapter = Readonly<{
    listResources(): MaybePromise<readonly SimulatorDeviceResourceV1[]>;
    listDiagnostics(): MaybePromise<readonly Record<string, unknown>[]>;
    dispatchAction: SimulatorPreviewDaemonAdapterDispatch;
    stop(): Promise<void>;
}>;

export type SimulatorPlatformPreviewDispatchInput = Readonly<{
    event: SimulatorPreviewActionV1;
    resources: readonly SimulatorDeviceResourceV1[];
    platformResources: readonly SimulatorDeviceResourceV1[];
    resource: SimulatorDeviceResourceV1 | null;
}>;

export type SimulatorPlatformPreviewAdapter = Readonly<{
    platform: SimulatorPlatformV1;
    listResources(): MaybePromise<readonly SimulatorDeviceResourceV1[]>;
    listDiagnostics(): MaybePromise<readonly Record<string, unknown>[]>;
    dispatchAction(input: SimulatorPlatformPreviewDispatchInput): MaybePromise<SimulatorPreviewActionResultV1 | void>;
    stop(): MaybePromise<void>;
}>;

export type SimulatorPlatformHealthAdapter = Readonly<{
    platform: SimulatorPlatformV1;
    health(): Promise<IosSimulatorAdapterHealthV1 | AndroidSimulatorAdapterHealthV1>;
}>;

export type CreateSimulatorPreviewDaemonAdapterInput = Readonly<{
    resources?: readonly SimulatorDeviceResourceV1[];
    listResources?: () => Promise<readonly SimulatorDeviceResourceV1[]> | readonly SimulatorDeviceResourceV1[];
    listDiagnostics?: () => Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[];
    dispatchAction?: SimulatorPreviewDaemonAdapterDispatch | null;
    stop?: () => Promise<void> | void;
}>;

function actionEventType(event: SimulatorPreviewActionV1): SimulatorPreviewActionTypeV1 {
    return event.type;
}

function unavailableResult(
    event: SimulatorPreviewActionV1,
    reasonCode = 'simulator_runtime_action_unavailable',
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: actionEventType(event),
        status: 'unavailable',
        reasonCode,
        diagnostics: [],
    };
}

function rejectedResult(
    event: SimulatorPreviewActionV1,
    reasonCode: string,
): SimulatorPreviewActionResultV1 {
    return {
        v: 1,
        eventType: actionEventType(event),
        status: 'rejected',
        reasonCode,
        diagnostics: [],
    };
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
}

function isResourceScopedEvent(
    event: SimulatorPreviewActionV1,
): event is Extract<SimulatorPreviewActionV1, { simulatorId: string }> {
    return 'simulatorId' in event;
}

function eventSourceId(event: SimulatorPreviewActionV1): string | null {
    if (event.type === 'simulator.control.send') return event.control.sourceId;
    if ('sourceId' in event && typeof event.sourceId === 'string') return event.sourceId;
    return null;
}

function findResourcesBySimulatorId(
    resources: readonly SimulatorDeviceResourceV1[],
    simulatorId: string,
): readonly SimulatorDeviceResourceV1[] {
    return resources.filter((resource) => resource.simulatorId === simulatorId);
}

function findResourcesBySourceId(
    resources: readonly SimulatorDeviceResourceV1[],
    sourceId: string,
): readonly SimulatorDeviceResourceV1[] {
    return resources.filter((resource) => resource.capture.sourceId === sourceId);
}

function resolveDispatchResource(input: Readonly<{
    event: SimulatorPreviewActionV1;
    resources: readonly SimulatorDeviceResourceV1[];
}>): Readonly<
    | { ok: true; resource: SimulatorDeviceResourceV1 | null }
    | { ok: false; result: SimulatorPreviewActionResultV1 }
> {
    if (input.event.type === 'simulator.devices.list') {
        return { ok: true, resource: null };
    }

    const matches = input.event.type === 'simulator.control.send'
        ? findResourcesBySourceId(input.resources, input.event.control.sourceId)
        : isResourceScopedEvent(input.event)
            ? findResourcesBySimulatorId(input.resources, input.event.simulatorId)
            : [];

    if (matches.length > 1) {
        return {
            ok: false,
            result: rejectedResult(
                input.event,
                input.event.type === 'simulator.control.send'
                    ? 'ambiguous_simulator_source'
                    : 'ambiguous_simulator',
            ),
        };
    }
    const resource = matches[0] ?? null;
    if (!resource) {
        return {
            ok: false,
            result: rejectedResult(
                input.event,
                input.event.type === 'simulator.control.send'
                    ? 'unknown_simulator_source'
                    : 'unknown_simulator',
            ),
        };
    }

    const sourceId = eventSourceId(input.event);
    if (sourceId && resource.capture.sourceId !== sourceId) {
        return {
            ok: false,
            result: rejectedResult(input.event, 'unknown_simulator_source'),
        };
    }
    if (input.event.type !== 'simulator.sideband.request' && resource.capture.status === 'unavailable') {
        return {
            ok: false,
            result: rejectedResult(input.event, resource.capture.reasonCode),
        };
    }
    return { ok: true, resource };
}

export function createSimulatorPreviewDaemonAdapter(
    input: CreateSimulatorPreviewDaemonAdapterInput = {},
): SimulatorPreviewDaemonAdapter {
    let stopPromise: Promise<void> | null = null;
    return Object.freeze({
        listResources: input.listResources ?? (() => input.resources ?? []),
        listDiagnostics: input.listDiagnostics ?? (() => []),
        dispatchAction: input.dispatchAction ?? (() => undefined),
        stop: async () => {
            stopPromise ??= Promise.resolve(input.stop?.()).then(() => undefined);
            await stopPromise;
        },
    });
}

export function createComposedSimulatorPreviewAdapter(input: Readonly<{
    platforms: readonly SimulatorPlatformPreviewAdapter[];
}>): SimulatorPreviewDaemonAdapter {
    let stopPromise: Promise<void> | null = null;
    let lastResourceDiagnostics: readonly Record<string, unknown>[] = [];

    return Object.freeze({
        listResources: async () => {
            const resources: SimulatorDeviceResourceV1[] = [];
            const diagnostics: Record<string, unknown>[] = [];
            const results = await Promise.allSettled(input.platforms.map(async (platform) => ({
                platform: platform.platform,
                resources: await platform.listResources(),
            })));

            results.forEach((result, index) => {
                const platform = input.platforms[index]?.platform ?? 'unknown';
                if (result.status === 'rejected') {
                    diagnostics.push({
                        platform,
                        code: 'simulator_platform_resources_unavailable',
                        errorName: errorName(result.reason),
                    });
                    return;
                }
                resources.push(...result.value.resources);
            });
            lastResourceDiagnostics = diagnostics;
            return resources;
        },
        listDiagnostics: async () => {
            const diagnostics: Record<string, unknown>[] = [...lastResourceDiagnostics];
            const results = await Promise.allSettled(input.platforms.map(async (platform) => ({
                platform: platform.platform,
                diagnostics: await platform.listDiagnostics(),
            })));

            results.forEach((result, index) => {
                const platform = input.platforms[index]?.platform ?? 'unknown';
                if (result.status === 'rejected') {
                    diagnostics.push({
                        platform,
                        code: 'simulator_platform_diagnostics_unavailable',
                        errorName: errorName(result.reason),
                    });
                    return;
                }
                diagnostics.push(...result.value.diagnostics);
            });
            return diagnostics;
        },
        dispatchAction: async ({ event, resources }) => {
            const resolved = resolveDispatchResource({ event, resources });
            if (!resolved.ok) return resolved.result;

            const resource = resolved.resource;
            if (!resource) return unavailableResult(event);

            const platformResources = resources.filter((candidate) => candidate.platform === resource.platform);
            const platform = input.platforms.find((candidate) => candidate.platform === resource.platform);
            if (!platform) return unavailableResult(event, 'simulator_platform_adapter_unavailable');

            try {
                return await platform.dispatchAction({
                    event,
                    resources,
                    platformResources,
                    resource,
                });
            } catch (error) {
                return unavailableResult(event, 'simulator_platform_dispatch_failed');
            }
        },
        stop: async () => {
            stopPromise ??= Promise.allSettled(input.platforms.map(async (platform) => {
                await platform.stop();
            })).then(() => undefined);
            await stopPromise;
        },
    });
}

export function createHealthBackedSimulatorPlatformPreviewAdapter(
    adapter: SimulatorPlatformHealthAdapter,
): SimulatorPlatformPreviewAdapter {
    const listDiagnostics = createSimulatorPlatformDiagnosticsReader([adapter]);
    return Object.freeze({
        platform: adapter.platform,
        listResources: () => [],
        listDiagnostics,
        dispatchAction: async ({ event }) => {
            const health = await adapter.health();
            if (health.status === 'unavailable') {
                return unavailableResult(event, health.reasonCode);
            }
            return unavailableResult(event, 'simulator_platform_action_unimplemented');
        },
        stop: async () => {},
    });
}
