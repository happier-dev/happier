import { randomUUID } from 'node:crypto';

import { MessageAckResponseSchema } from '@happier-dev/protocol/updates';

import { createMachineBoundSessionScopedSocketCollector } from '../../sessionSocketBinding';
import { createUserScopedSocketCollector, type CapturedEvent, type SocketConnectivityState } from '../../socketClient';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';

export type MixedScenarioAuth = Readonly<{
    token: string;
    publicKeyBase64?: string;
}>;

export function compactMixedScenarioAuth(auth: MixedScenarioAuth): MixedScenarioAuth {
    return { token: auth.token };
}

export function summarizeMixedScenarioAuthPayload(auths: readonly MixedScenarioAuth[]): Readonly<{
    tokenCharsRetained: number;
    publicKeyCharsRetained: number;
}> {
    return auths.reduce((summary, auth) => ({
        tokenCharsRetained: summary.tokenCharsRetained + auth.token.length,
        publicKeyCharsRetained: summary.publicKeyCharsRetained + (auth.publicKeyBase64?.length ?? 0),
    }), {
        tokenCharsRetained: 0,
        publicKeyCharsRetained: 0,
    });
}

export type MixedCollector = Readonly<{
    sessionId: string;
    machineId: string;
    authIndex: number;
    socket: Awaited<ReturnType<typeof createMachineBoundSessionScopedSocketCollector>>['socket'];
}>;

export type MixedProvisionedCollectorIdentity = Readonly<{
    sessionId: string;
    machineId: string;
    authIndex: number;
}>;

export type MixedUserScopedDevice = ReturnType<typeof createUserScopedSocketCollector>;

export type MixedUserDeviceBinding = Readonly<{
    authIndex: number;
    deviceCount: number;
}>;

export type MixedUserDevices = Readonly<{
    authIndex: number;
    devices: ReadonlyArray<MixedUserScopedDevice>;
}>;

export type MixedSessionTarget = Readonly<{
    sessionId: string;
    authIndex: number;
}>;

export type MixedConnectivitySnapshot = Readonly<{
    userDevices: {
        total: number;
        connected: number;
        disconnectedAuthIndexes: number[];
        eventSummary: {
            lastConnectErrorMessageCounts: Record<string, number>;
            lastDisconnectReasonCounts: Record<string, number>;
            missingLastConnectErrorCount: number;
            missingLastDisconnectCount: number;
        };
        disconnectedSample: Array<{
            authIndex: number;
            disconnectedDeviceCount: number;
            devices: Array<{
                deviceIndex: number;
                lastConnectError?: {
                    at: number;
                    message: string;
                };
                lastDisconnect?: {
                    at: number;
                    reason?: string;
                };
            }>;
        }>;
    };
    machineCollectors: {
        total: number;
        connected: number;
        disconnectedCount: number;
        disconnectedAuthIndexes: number[];
        eventSummary: {
            lastConnectErrorMessageCounts: Record<string, number>;
            lastDisconnectReasonCounts: Record<string, number>;
            missingLastConnectErrorCount: number;
            missingLastDisconnectCount: number;
        };
        disconnectedSample: Array<{
            sessionId: string;
            machineId: string;
            authIndex: number;
            lastConnectError?: {
                at: number;
                message: string;
            };
            lastDisconnect?: {
                at: number;
                reason?: string;
            };
        }>;
    };
}>;

function truncateConnectivityEventString(value: string | undefined, maxLength = 200): string | undefined {
    if (typeof value !== 'string') {
        return value;
    }
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function summarizeSocketConnectivityFailure(events: readonly CapturedEvent[]): {
    lastConnectError?: {
        at: number;
        message: string;
    };
    lastDisconnect?: {
        at: number;
        reason?: string;
    };
} {
    let lastConnectError: { at: number; message: string } | undefined;
    let lastDisconnect: { at: number; reason?: string } | undefined;

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event) {
            continue;
        }
        if (!lastConnectError && event.kind === 'connect_error') {
            lastConnectError = {
                at: event.at,
                message: truncateConnectivityEventString(event.message) ?? 'unknown',
            };
            continue;
        }
        if (!lastDisconnect && event.kind === 'disconnect') {
            lastDisconnect = {
                at: event.at,
                reason: truncateConnectivityEventString(event.reason),
            };
        }
        if (lastConnectError && lastDisconnect) {
            break;
        }
    }

    return {
        ...(lastConnectError ? { lastConnectError } : {}),
        ...(lastDisconnect ? { lastDisconnect } : {}),
    };
}

function summarizeSocketConnectivityFailureState(state: SocketConnectivityState | undefined): {
    lastConnectError?: {
        at: number;
        message: string;
    };
    lastDisconnect?: {
        at: number;
        reason?: string;
    };
} {
    return {
        ...(state?.lastConnectError ? {
            lastConnectError: {
                at: state.lastConnectError.at,
                message: truncateConnectivityEventString(state.lastConnectError.message) ?? 'unknown',
            },
        } : {}),
        ...(state?.lastDisconnect ? {
            lastDisconnect: {
                at: state.lastDisconnect.at,
                reason: truncateConnectivityEventString(state.lastDisconnect.reason),
            },
        } : {}),
    };
}

function resolveSocketConnectivityFailure(params: {
    events: readonly CapturedEvent[];
    connectivityState?: SocketConnectivityState;
}): {
    lastConnectError?: {
        at: number;
        message: string;
    };
    lastDisconnect?: {
        at: number;
        reason?: string;
    };
} {
    const stateSummary = summarizeSocketConnectivityFailureState(params.connectivityState);
    if (stateSummary.lastConnectError || stateSummary.lastDisconnect) {
        return stateSummary;
    }
    return summarizeSocketConnectivityFailure(params.events);
}

function summarizeDisconnectedSocketEventSummary(
    socketStates: readonly Readonly<{
        events: readonly CapturedEvent[];
        connectivityState?: SocketConnectivityState;
    }>[],
): {
    lastConnectErrorMessageCounts: Record<string, number>;
    lastDisconnectReasonCounts: Record<string, number>;
    missingLastConnectErrorCount: number;
    missingLastDisconnectCount: number;
} {
    const lastConnectErrorMessageCounts: Record<string, number> = {};
    const lastDisconnectReasonCounts: Record<string, number> = {};
    let missingLastConnectErrorCount = 0;
    let missingLastDisconnectCount = 0;

    for (const socketState of socketStates) {
        const summary = resolveSocketConnectivityFailure(socketState);
        if (summary.lastConnectError?.message) {
            lastConnectErrorMessageCounts[summary.lastConnectError.message] = (
                lastConnectErrorMessageCounts[summary.lastConnectError.message] ?? 0
            ) + 1;
        } else {
            missingLastConnectErrorCount += 1;
        }
        if (summary.lastDisconnect?.reason) {
            lastDisconnectReasonCounts[summary.lastDisconnect.reason] = (
                lastDisconnectReasonCounts[summary.lastDisconnect.reason] ?? 0
            ) + 1;
        } else {
            missingLastDisconnectCount += 1;
        }
    }

    return {
        lastConnectErrorMessageCounts,
        lastDisconnectReasonCounts,
        missingLastConnectErrorCount,
        missingLastDisconnectCount,
    };
}

export function normalizeMixedScenarioAuths(params: {
    auths?: readonly MixedScenarioAuth[];
    token?: string;
}): readonly MixedScenarioAuth[] {
    if (Array.isArray(params.auths) && params.auths.length > 0) {
        return params.auths.map(compactMixedScenarioAuth);
    }
    if (typeof params.token === 'string' && params.token.length > 0) {
        return [{ token: params.token }];
    }
    throw new Error('Mixed stress scenario requires at least one auth token');
}

export function resolveMixedControlPlaneBaseUrls(params: {
    baseUrl: string;
    controlPlaneBaseUrl?: string;
    controlPlaneBaseUrls?: readonly string[];
}): readonly string[] {
    const configuredTargets = (params.controlPlaneBaseUrls ?? [])
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (configuredTargets.length > 0) {
        return configuredTargets;
    }
    if (typeof params.controlPlaneBaseUrl === 'string' && params.controlPlaneBaseUrl.length > 0) {
        return [params.controlPlaneBaseUrl];
    }
    return [params.baseUrl];
}

export function resolveMixedControlPlaneBaseUrlForIndex(params: {
    baseUrl: string;
    controlPlaneBaseUrl?: string;
    controlPlaneBaseUrls?: readonly string[];
    index: number;
}): string {
    const targets = resolveMixedControlPlaneBaseUrls(params);
    const normalizedIndex = Number.isFinite(params.index) ? Math.abs(Math.trunc(params.index)) : 0;
    return targets[normalizedIndex % targets.length] ?? params.baseUrl;
}

export function resolveMixedAuth(params: {
    auths: readonly MixedScenarioAuth[];
    authIndex: number;
}): MixedScenarioAuth {
    const auth = params.auths[params.authIndex];
    if (!auth) {
        throw new Error(`Missing mixed scenario auth at index ${params.authIndex}`);
    }
    return auth;
}

export function resolveMixedUserDeviceBindings(params: {
    auths: readonly MixedScenarioAuth[];
    mixedMessageEmitterCount: number;
    authIndexOffset?: number;
}): readonly MixedUserDeviceBinding[] {
    const perAuthEmitterCount = Math.max(
        1,
        Math.ceil(Math.max(1, params.mixedMessageEmitterCount) / Math.max(1, params.auths.length)),
    );
    const authIndexOffset = params.authIndexOffset ?? 0;

    return params.auths.map((_auth, authIndex) => ({
        authIndex: authIndexOffset + authIndex,
        deviceCount: perAuthEmitterCount,
    }));
}

export function resolveMixedUserDevices(params: {
    auths: readonly MixedScenarioAuth[];
    baseUrl: string;
    transports: readonly ('websocket' | 'polling')[];
    mixedMessageEmitterCount: number;
    mixedSocketConnectTimeoutMs: number;
    mixedSocketAutoReconnect: boolean;
    mixedCaptureSocketEvents: boolean;
    authIndexOffset?: number;
}): readonly MixedUserDevices[] {
    const bindings = resolveMixedUserDeviceBindings({
        auths: params.auths,
        mixedMessageEmitterCount: params.mixedMessageEmitterCount,
        authIndexOffset: params.authIndexOffset,
    });

    return bindings.map((binding, authIndex) => {
        const auth = params.auths[authIndex];
        if (!auth) {
            throw new Error(`Missing mixed scenario auth at index ${authIndex}`);
        }
        return {
            authIndex: binding.authIndex,
            devices: Array.from({ length: binding.deviceCount }, () =>
                createUserScopedSocketCollector(params.baseUrl, auth.token, {
                    transports: params.transports,
                    connectTimeoutMs: params.mixedSocketConnectTimeoutMs,
                    autoReconnect: params.mixedSocketAutoReconnect,
                    captureEvents: params.mixedCaptureSocketEvents,
                }),
            ),
        };
    });
}

export function resolveMixedConnectConvergenceTimeoutMs(config: Pick<StressConfig, 'load'>): number {
    if (typeof config.load.mixedConnectConvergenceTimeoutMs === 'number') {
        return config.load.mixedConnectConvergenceTimeoutMs;
    }
    return Math.max(60_000, config.load.mixedSocketConnectTimeoutMs ?? 60_000);
}

export function resolvePrimaryMixedUserDevice(params: {
    userDevices: readonly MixedUserDevices[];
    authIndex: number;
}): MixedUserScopedDevice {
    const device = params.userDevices.find((entry) => entry.authIndex === params.authIndex)?.devices[0];
    if (!device) {
        throw new Error(`Missing primary mixed user device for auth ${params.authIndex}`);
    }
    return device;
}

export async function resolveReadyMixedUserDevice(params: {
    userDevices: readonly MixedUserDevices[];
    authIndex: number;
    preferredDeviceIndex?: number;
    reconnectTimeoutMs: number;
}): Promise<MixedUserScopedDevice> {
    const userDeviceGroup = params.userDevices.find((entry) => entry.authIndex === params.authIndex);
    if (!userDeviceGroup || userDeviceGroup.devices.length === 0) {
        throw new Error(`Missing primary mixed user device for auth ${params.authIndex}`);
    }

    const connectedDevice = userDeviceGroup.devices.find((device) => (
        typeof device.isConnected !== 'function' || device.isConnected()
    ));
    if (connectedDevice) {
        return connectedDevice;
    }

    const deviceIndex = Math.abs(Math.trunc(params.preferredDeviceIndex ?? 0)) % userDeviceGroup.devices.length;
    const reconnectingDevice = userDeviceGroup.devices[deviceIndex] ?? userDeviceGroup.devices[0];
    if (!reconnectingDevice) {
        throw new Error(`Missing reconnectable mixed user device for auth ${params.authIndex}`);
    }
    if (typeof reconnectingDevice.connect !== 'function' || typeof reconnectingDevice.isConnected !== 'function') {
        return reconnectingDevice;
    }

    reconnectingDevice.connect();
    await waitFor(() => reconnectingDevice.isConnected(), {
        timeoutMs: params.reconnectTimeoutMs,
    });
    return reconnectingDevice;
}

export function captureMixedConnectivitySnapshot(params: {
    userDevices: readonly MixedUserDevices[];
    machineCollectors: readonly MixedCollector[];
    disconnectedSampleLimit?: number;
}): MixedConnectivitySnapshot {
    const disconnectedUserDevices = params.userDevices
        .map((userDevice) => ({
            authIndex: userDevice.authIndex,
            disconnectedDevices: userDevice.devices
                .map((device, deviceIndex) => ({ device, deviceIndex }))
                .filter(({ device }) => !device.isConnected()),
        }))
        .filter((userDevice) => userDevice.disconnectedDevices.length > 0);
    const disconnectedCollectors = params.machineCollectors.filter((collector) => !collector.socket.isConnected());
    const disconnectedSampleLimit = Math.max(1, params.disconnectedSampleLimit ?? 16);

    return {
        userDevices: {
            total: params.userDevices.length,
            connected: params.userDevices.length - disconnectedUserDevices.length,
            disconnectedAuthIndexes: disconnectedUserDevices.map((userDevice) => userDevice.authIndex),
            eventSummary: summarizeDisconnectedSocketEventSummary(
                disconnectedUserDevices.flatMap((userDevice) =>
                    userDevice.disconnectedDevices.map(({ device }) => ({
                        events: device.getEvents(),
                        connectivityState: device.getConnectivityState?.(),
                    })),
                ),
            ),
            disconnectedSample: disconnectedUserDevices.slice(0, disconnectedSampleLimit).map((userDevice) => ({
                authIndex: userDevice.authIndex,
                disconnectedDeviceCount: userDevice.disconnectedDevices.length,
                devices: userDevice.disconnectedDevices.slice(0, disconnectedSampleLimit).map(({ device, deviceIndex }) => ({
                    deviceIndex,
                    ...resolveSocketConnectivityFailure({
                        events: device.getEvents(),
                        connectivityState: device.getConnectivityState?.(),
                    }),
                })),
            })),
        },
        machineCollectors: {
            total: params.machineCollectors.length,
            connected: params.machineCollectors.length - disconnectedCollectors.length,
            disconnectedCount: disconnectedCollectors.length,
            disconnectedAuthIndexes: disconnectedCollectors.map((collector) => collector.authIndex),
            eventSummary: summarizeDisconnectedSocketEventSummary(
                disconnectedCollectors.map((collector) => ({
                    events: collector.socket.getEvents(),
                    connectivityState: collector.socket.getConnectivityState?.(),
                })),
            ),
            disconnectedSample: disconnectedCollectors.slice(0, disconnectedSampleLimit).map((collector) => ({
                sessionId: collector.sessionId,
                machineId: collector.machineId,
                authIndex: collector.authIndex,
                ...resolveSocketConnectivityFailure({
                    events: collector.socket.getEvents(),
                    connectivityState: collector.socket.getConnectivityState?.(),
                }),
            })),
        },
    };
}

export function recordProvisionedCollector<TCollector extends MixedProvisionedCollectorIdentity>(params: {
    collector: TCollector;
    sessions: MixedSessionTarget[];
    machineCollectors: TCollector[];
    verificationSessionIds: string[];
    expectedLocalIdsBySession: Map<string, string[]>;
    verificationSessionCount: number;
}): void {
    params.sessions.push({
        sessionId: params.collector.sessionId,
        authIndex: params.collector.authIndex,
    });
    params.machineCollectors.push(params.collector);

    if (params.verificationSessionIds.length >= params.verificationSessionCount) {
        return;
    }

    params.verificationSessionIds.push(params.collector.sessionId);
    params.expectedLocalIdsBySession.set(params.collector.sessionId, []);
}

export async function emitPresencePulse(collector: MixedCollector): Promise<void> {
    const now = Date.now();
    collector.socket.emit('session-alive', {
        sid: collector.sessionId,
        time: now,
        thinking: false,
    });
    collector.socket.emit('machine-alive', {
        machineId: collector.machineId,
        time: now,
    });
}

export async function sendMixedMessageBatch(params: {
    startIndex: number;
    endIndexExclusive: number;
    sessions: readonly MixedSessionTarget[];
    concurrency: number;
    userDevices: readonly MixedUserDevices[];
    ackLatencies: number[];
    expectedLocalIdsBySession: Map<string, string[]>;
    reconnectTimeoutMs: number;
}): Promise<void> {
    const indices = Array.from(
        { length: Math.max(0, params.endIndexExclusive - params.startIndex) },
        (_, offset) => params.startIndex + offset,
    );

    await runStressTasksWithConcurrencyLimit(indices, params.concurrency, async (index) => {
        const session = params.sessions[index % params.sessions.length];
        if (!session) {
            throw new Error(`Missing session id for mixed workload at index ${index}`);
        }

        const userDeviceGroup = params.userDevices.find((entry) => entry.authIndex === session.authIndex);
        const device = await resolveReadyMixedUserDevice({
            userDevices: params.userDevices,
            authIndex: session.authIndex,
            preferredDeviceIndex: index % (userDeviceGroup?.devices.length || 1),
            reconnectTimeoutMs: params.reconnectTimeoutMs,
        });

        const localId = randomUUID();
        const started = Date.now();
        const rawAck = await device.emitWithAck<unknown>('message', {
            sid: session.sessionId,
            message: Buffer.from(`mixed-${index}`, 'utf8').toString('base64'),
            localId,
        });
        const ack = MessageAckResponseSchema.parse(rawAck);
        params.ackLatencies.push(Date.now() - started);
        if (!ack.ok) {
            throw new Error(
                `Expected successful mixed message ack for ${session.sessionId}: ${JSON.stringify(ack)}`,
            );
        }
        params.expectedLocalIdsBySession.get(session.sessionId)?.push(localId);
    });
}

export async function sendMixedTranscriptStreamBatch(params: {
    startIndex: number;
    endIndexExclusive: number;
    collectors: readonly MixedCollector[];
    concurrency: number;
    streamDispatchLatencies: number[];
}): Promise<void> {
    const indices = Array.from(
        { length: Math.max(0, params.endIndexExclusive - params.startIndex) },
        (_, offset) => params.startIndex + offset,
    );

    await runStressTasksWithConcurrencyLimit(indices, params.concurrency, async (index) => {
        const collector = params.collectors[index % params.collectors.length];
        if (!collector) {
            throw new Error(`Missing collector for transcript stream segment at index ${index}`);
        }

        const started = Date.now();
        collector.socket.emit('transcript-stream-segment', {
            sid: collector.sessionId,
            message: {
                localId: randomUUID(),
                sidechainId: null,
                content: { t: 'encrypted' as const, c: 'ciphertext' },
                createdAt: Date.now(),
                updatedAt: Date.now(),
            },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        params.streamDispatchLatencies.push(Date.now() - started);
    });
}

export async function sendMixedRpcBatch(params: {
    listeners: readonly {
        method: string;
        machineId: string;
        authIndex: number;
    }[];
    rpcPlans: readonly {
        listenerIndex: number;
        triggerMessageIndex: number;
    }[];
    concurrency: number;
    userDevices: readonly MixedUserDevices[];
    rpcLatencies: number[];
    reconnectTimeoutMs: number;
}): Promise<void> {
    await runStressTasksWithConcurrencyLimit(params.rpcPlans, params.concurrency, async (rpcPlan) => {
        const listener = params.listeners[rpcPlan.listenerIndex];
        if (!listener) {
            throw new Error(`Missing mixed workload RPC listener at index ${rpcPlan.listenerIndex}`);
        }

        const rpcStarted = Date.now();
        const response = await (await resolveReadyMixedUserDevice({
            userDevices: params.userDevices,
            authIndex: listener.authIndex,
            reconnectTimeoutMs: params.reconnectTimeoutMs,
        })).rpcCall<{ ok: boolean; result?: string; errorCode?: string }>(
            listener.method,
            JSON.stringify({ index: rpcPlan.triggerMessageIndex }),
        );
        params.rpcLatencies.push(Date.now() - rpcStarted);
        if (!response.ok || typeof response.result !== 'string') {
            const errorCode = typeof response.errorCode === 'string' ? response.errorCode : 'unknown';
            throw new Error(`Mixed workload RPC failed for ${listener.method}: ${errorCode}`);
        }
        const parsed = JSON.parse(response.result) as { ok?: boolean; machineId?: string };
        if (parsed.ok !== true || parsed.machineId !== listener.machineId) {
            throw new Error(`Mixed workload RPC routed to the wrong listener for ${listener.method}`);
        }
    });
}

export async function runMixedSocketConnectTasks(params: {
    tasks: ReadonlyArray<() => Promise<void>>;
    concurrency: number;
    connectPattern?: 'burst' | 'ramped';
    rampStepMs?: number;
    sleepImpl?: (ms: number) => Promise<void>;
}): Promise<void> {
    const sleepDuringRamp = params.sleepImpl ?? sleep;
    const concurrency = Math.max(1, params.concurrency);
    if (params.connectPattern !== 'ramped') {
        await runStressTasksWithConcurrencyLimit(params.tasks, concurrency, async (task) => {
            await task();
        });
        return;
    }

    const rampStepMs = Math.max(0, params.rampStepMs ?? 0);
    for (let batchStart = 0; batchStart < params.tasks.length; batchStart += concurrency) {
        if (batchStart > 0 && rampStepMs > 0) {
            await sleepDuringRamp(rampStepMs);
        }
        const batch = params.tasks.slice(batchStart, batchStart + concurrency);
        await Promise.all(batch.map(async (task) => task()));
    }
}
