import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type {
    ExecService,
    PluginExecSpawnRequest,
    PluginProcessHandle,
    PluginProcessResult,
} from '@happier-dev/plugin-sdk/exec';
import type {
    ManagedServiceHttpHealthResponse,
    ManagedServiceNativeInstanceV1,
    ManagedServiceNativeLifecycleV1,
    ManagedServiceNativeObservationV1,
} from '@happier-dev/plugin-sdk/managed-services';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { PluginDiagnosticDataV1Schema } from '@happier-dev/protocol/daemon/pluginContributionIntrospection';
import { readManagedServiceEndpointUrl } from '@happier-dev/protocol/plugins/managedServiceEndpointUrl';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import type { ManagedServiceEndpointHostPolicy } from '@happier-dev/protocol';

import type {
    ManagedServiceProcessDurabilityOwner,
    ManagedServiceDurableLogCapture,
} from './managedServiceDurability';
import {
    isManagedServiceHttpHealthResponse,
    MANAGED_SERVICE_NUMERIC_CONTRACT,
} from './managedServiceSpecNormalization';
import {
    installManagedProcessCustodyForHost,
    installPreauthorizedPluginExecSpawnForHost,
    spawnAuthorizedHostExecLaunchForHost,
    type HostAuthorizedPluginExecLaunch,
    type ResolvedPluginExecutable,
} from './exec';
import {
    readSupervisedPluginProcessIdForHost,
    waitForSupervisedPluginProcessCustody,
    type SupervisedPluginProcessCustody,
} from '../../exec/processSupervisor';
import {
    createProcessCustodyHandshakePath,
    createWindowsJobCustodyName,
    formatWindowsJobCustodyStartIdentity,
    resolveProcessCustodyRuntimeExecutable,
    type ProcessCustodySpawnSpec,
} from '@/subprocess/supervision/processCustody';
import {
    type PackagedRuntimeBinaryExecutableRef,
} from '@/providers/lifecycle/resolveManagedProviderRuntimeLaunch';
import { normalizeLocalServiceScan } from '@/daemon/local/services/inventory/scanner';
import { scanPlatformLocalServices } from '@/daemon/local/services/inventory/platform/scan';
import { selectManagedOwnedTreeEndpoint } from './managedOwnedTreeEndpoint';
import {
    reserveLoopbackPort,
    type LoopbackHost,
    type LoopbackPortReservation,
} from '@/cloud/loopbackPort';
import { readCredentialRedactionValues } from './credentialRedactionValues';
import { clonePluginPlainData } from '../../plainData';
import { sanitizeExecDiagnosticText } from '../../exec/errors';

export type ManagedServiceProcessCredential =
    | Readonly<{
        environment: { name: string; value: string };
        httpHeader?: { name: string; value: string };
    }>
    | Readonly<{
        environment?: never;
        httpHeader: { name: string; value: string };
    }>;

/**
 * Host-private headers prepared for one health-probe dispatch. The optional
 * currentness check belongs to the owner that leased the headers and is
 * evaluated immediately before this supervisor fetches.
 */
export type ManagedServiceProcessHealthHeaderLease = Readonly<{
    headers: Readonly<Record<string, string>>;
    isCurrent?(signal?: AbortSignal): Promise<boolean>;
}>;

export type ManagedServiceProcessHealthCheck =
    | Readonly<{
        kind: 'http';
        target?:
            | { kind: 'serverPath'; path: string }
            | { kind: 'url'; url: string };
        alternatives?: readonly Readonly<{
            target: Readonly<{ kind: 'serverPath'; path: string }>;
            response: ManagedServiceHttpHealthResponse;
        }>[];
        headers?: Readonly<Record<string, string>>;
        /** Host-private lease resolver. Public plugin specs cannot supply this callback. */
        resolveHeaders?: (
            signal?: AbortSignal,
        ) => Promise<ManagedServiceProcessHealthHeaderLease>;
        timeoutMs: number;
    }>
    | Readonly<{
        kind: 'command';
        executable: PluginExecSpawnRequest['executable'];
        args?: readonly string[];
        timeoutMs: number;
    }>;

type ManagedServiceProcessLaunch =
    | Readonly<{ launch: PluginExecSpawnRequest; authorizeLaunch?: never }>
    | Readonly<{ launch?: never; authorizeLaunch: ProjectManagedServiceLaunchAuthorizer }>;

/** Builtin codecs use the same native custody owner without impersonating a plugin. */
export type ProjectBuiltinNativeLifecycle = Readonly<{
    inspect(options?: Readonly<{ signal?: AbortSignal }>): Promise<ManagedServiceNativeObservationV1>;
    stop(options?: Readonly<{ signal?: AbortSignal }>): ReturnType<ManagedServiceNativeLifecycleV1['stop']>;
    logs?(options?: Readonly<{ signal?: AbortSignal }>): Promise<string>;
    prepareStart?(options?: Readonly<{ signal?: AbortSignal }>): Promise<void>;
    redactedValues?: readonly string[];
}>;

export type ManagedServiceProcessSpec = Readonly<{
    id: string;
    healthCheck?: ManagedServiceProcessHealthCheck;
    watchdog: Readonly<{
        intervalMs: number;
        missedIntervals: number;
    }>;
    startupTimeoutMs?: number;
}> & (
    | Readonly<{
        mode: Readonly<{
            kind: 'managedSpawn';
            /** Lifetime/readiness is endpoint-free; endpointDetection may still observe an optional address. */
            endpointNone?: true;
            host?: string;
            port?: number;
            baseUrl?: string;
            portArgument?: string;
            portEnvironmentKey?: string;
            baseUrlEnvironmentKey?: string;
            endpointDetection?: Readonly<{
                kind: 'detectAfterLaunch';
                minimumConfidence: 'high' | 'medium' | 'low';
            }>;
            onPortCollision?: 'fail' | 'fallback';
            credential?: ManagedServiceProcessCredential;
        }>;
        durableLog?: { enabled: boolean; keepCount: number };
    }> & ManagedServiceProcessLaunch
    | Readonly<{
        mode: Readonly<{
            kind: 'native';
            instance: ManagedServiceNativeInstanceV1;
            lifecycle: ManagedServiceNativeLifecycleV1;
            builtinLifecycle?: never;
        } | {
            kind: 'native';
            instance?: never;
            lifecycle?: never;
            builtinLifecycle: ProjectBuiltinNativeLifecycle;
        }>;
        durableLog?: never;
    }> & ManagedServiceProcessLaunch
    | Readonly<{
        mode: Readonly<{
            kind: 'externalAttach';
            baseUrl: string;
            credential?: ManagedServiceProcessCredential;
        }>;
        launch?: never;
        authorizeLaunch?: never;
        durableLog?: never;
    }>
);

export type ManagedServiceProcessSnapshot = Readonly<{
    id: string;
    instanceId: string;
    state: 'starting' | 'running' | 'healthy' | 'unhealthy' | 'stopped';
    mode: 'managedSpawn' | 'externalAttach' | 'native';
    readiness?: ManagedServiceNativeObservationV1['readiness'];
    nativePhase?: ManagedServiceNativeObservationV1['phase'];
    baseUrl: string | null;
    port: number | null;
    pid: number | null;
    startedAtMs: number | null;
    lastHealthyAtMs: number | null;
    diagnostics: readonly PluginDiagnosticData[];
    diagnosticsTruncated: boolean;
}>;

export type ManagedServiceDiagnosticRetention = Readonly<{
    diagnostics: readonly PluginDiagnosticData[];
    diagnosticsTruncated: boolean;
}>;

export type ManagedServiceProcessStopResult = Readonly<{
    status: 'stopped' | 'detached' | 'unsupported' | 'termination_incomplete';
}>;

export interface ManagedServiceProcessHandle {
    snapshot(): ManagedServiceProcessSnapshot;
    observe?(
        listener: (snapshot: ManagedServiceProcessSnapshot) => void,
    ): Readonly<{ dispose(): void }>;
    waitUntilHealthy(options?: Readonly<{
        timeoutMs?: number;
        signal?: AbortSignal;
    }>): Promise<ManagedServiceProcessSnapshot>;
    stop(options?: Readonly<{
        signal?: AbortSignal;
    }>): Promise<ManagedServiceProcessStopResult>;
    dispose(): Promise<void>;
}

export interface ManagedServiceProcessSupervisor {
    supervise(
        spec: ManagedServiceProcessSpec,
        options?: Readonly<{
            signal?: AbortSignal;
            /** Internal owner custody for resources acquired before a public handle exists. */
            registerEstablishmentCleanup?(
                cleanup: () => Promise<void>,
                observation: ManagedServiceEstablishmentCustodyObservation,
            ): Readonly<{ release(): void }>;
        }>,
    ): Promise<ManagedServiceProcessHandle>;
}

export type ManagedServiceEstablishmentCustodyObservation = Readonly<{
    snapshot(): ManagedServiceProcessSnapshot;
    hasAcquiredCustody(): boolean;
}>;

type ManagedServiceProcessScope = Readonly<{
    isOccurrenceCurrent(): boolean;
}> & (
Readonly<{
    kind?: 'plugin';
    occurrenceId: string;
    sourceCustody?: import('@happier-dev/protocol').PluginSourceCustodyV1;
    pluginId: string;
    contributionId: string;
    sessionId?: string;
    operationId?: string;
    exec: Pick<ExecService, 'spawn' | 'run'>;
    /** Host-private shared daemon admission, never accepted from an SDK spec. */
    independentInvocation?: true;
    resolveManagedExecutable?(
        executable: PluginExecSpawnRequest['executable'],
        isOccurrenceCurrent: () => boolean,
    ): Promise<ResolvedPluginExecutable>;
}> | Readonly<{
    kind: 'project';
    occurrenceId?: never;
    sourceCustody?: never;
    pluginId?: never;
    contributionId?: never;
    sessionId?: never;
    operationId?: never;
    exec?: never;
}>);

export type ProjectManagedServiceLaunchAuthorizer = (input: Readonly<{
    endpoint: Readonly<{ baseUrl: string; port: number }> | null;
    signal: AbortSignal;
}>) => Promise<HostAuthorizedPluginExecLaunch>;

type ManagedServiceProcessSupervision = {
    readonly lifecycle: AbortController;
};

type RunnerManagedServiceSupervisionRequest = Readonly<{
    sessionId: string;
    pluginId: string;
    contributionId: string;
    operationClaimId?: string;
    serverId: string;
    occurrenceId: string;
    signal: AbortSignal;
}> & (
    | Readonly<{
        mode: 'managedSpawn';
        executable: PluginExecSpawnRequest['executable'];
        environmentKeys: readonly string[];
    }>
    | Readonly<{
        mode: 'externalAttach';
    }>
);

type RunnerManagedServiceSupervisionAuthorization =
    | Readonly<{
        mode: 'managedSpawn';
        launch:
            | Readonly<{
                kind: 'daemonResolved';
                value: ResolvedPluginExecutable;
            }>
            | Readonly<{ kind: 'runnerPackagedRuntime' }>;
    }>
    | Readonly<{
        mode: 'externalAttach';
    }>;

export interface ManagedServiceProcessSupervisorHost {
    readonly custodyOwner: 'daemon' | 'sessionRunner';
    bind(scope: ManagedServiceProcessScope): ManagedServiceProcessSupervisor;
}

type ManagedServiceProcessEndpoint = Readonly<{
    baseUrl: string;
    /**
     * Hostname without IPv6 brackets. Loopback for a service this host spawned;
     * whatever the user declared for one they run themselves.
     */
    host: string;
    port: number;
    /** Which rule this endpoint was admitted under, so its health target uses the same one. */
    hostPolicy: ManagedServiceEndpointHostPolicy;
}>;

const MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES = 64 * 1024;
const MAX_MANAGED_SERVICE_DIAGNOSTICS = 32;
const MAX_MANAGED_SERVICE_DIAGNOSTIC_BYTES = 8_192;
const MAX_MANAGED_SERVICE_DIAGNOSTICS_BYTES = 65_536;
const diagnosticEncoder = new TextEncoder();
function diagnosticJsonBytes(value: unknown): number {
    return diagnosticEncoder.encode(JSON.stringify(value)).byteLength;
}

function isBoundedManagedServiceDiagnosticCode(code: string): boolean {
    return code.length >= 1
        && code.length <= 128
        && code.trim() === code;
}

function fixedRejectedManagedServiceDiagnostic(): PluginDiagnosticData {
    return Object.freeze({
        code: 'plugin_managed_service_diagnostic_rejected',
        severity: 'warning' as const,
        message:
            'Managed-service diagnostic exceeded the entry byte limit and was omitted',
    });
}

function rejectedManagedServiceDiagnostic(
    rejectedCode: string,
): PluginDiagnosticData {
    if (!isBoundedManagedServiceDiagnosticCode(rejectedCode)) {
        return fixedRejectedManagedServiceDiagnostic();
    }
    const replacement = Object.freeze({
        ...fixedRejectedManagedServiceDiagnostic(),
        details: Object.freeze({ rejectedCode }),
    });
    return diagnosticJsonBytes(replacement)
        <= MAX_MANAGED_SERVICE_DIAGNOSTIC_BYTES
        ? replacement
        : fixedRejectedManagedServiceDiagnostic();
}

function readPlainDataStringProperty(
    value: unknown,
    key: string,
): string | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor
        && typeof descriptor.value === 'string'
        ? descriptor.value
        : null;
}

function canonicalizeManagedServiceDiagnostic(
    value: unknown,
): PluginDiagnosticData | null {
    try {
        const snapshot = clonePluginPlainData(value, {
            path: 'Managed-service diagnostic',
            invalid: (message) => new TypeError(message),
        });
        const parsed = PluginDiagnosticDataV1Schema.safeParse(snapshot);
        const inputCode = readPlainDataStringProperty(snapshot, 'code');
        if (
            !parsed.success
            || inputCode !== parsed.data.code
            || !isBoundedManagedServiceDiagnosticCode(parsed.data.code)
            || (
                parsed.data.message !== undefined
                && parsed.data.message.length > 2_048
            )
        ) return null;
        return clonePluginPlainData(parsed.data, {
            path: 'Managed-service diagnostic',
            invalid: (message) => new TypeError(message),
        });
    } catch {
        return null;
    }
}

export function retainManagedServiceDiagnostic(
    current: ManagedServiceDiagnosticRetention,
    diagnostic: unknown,
): ManagedServiceDiagnosticRetention {
    const canonicalDiagnostic = canonicalizeManagedServiceDiagnostic(
        diagnostic,
    );
    const rejectedForEntryBytes = canonicalDiagnostic !== null
        && diagnosticJsonBytes(canonicalDiagnostic)
            > MAX_MANAGED_SERVICE_DIAGNOSTIC_BYTES;
    const rejected = canonicalDiagnostic === null || rejectedForEntryBytes;
    const admitted = canonicalDiagnostic === null
        ? fixedRejectedManagedServiceDiagnostic()
        : rejectedForEntryBytes
            ? rejectedManagedServiceDiagnostic(canonicalDiagnostic.code)
            : canonicalDiagnostic;
    const diagnostics = [...current.diagnostics, admitted];
    let diagnosticsTruncated = current.diagnosticsTruncated
        || rejected;
    while (
        diagnostics.length > MAX_MANAGED_SERVICE_DIAGNOSTICS
        || diagnosticJsonBytes(diagnostics)
            > MAX_MANAGED_SERVICE_DIAGNOSTICS_BYTES
    ) {
        diagnostics.shift();
        diagnosticsTruncated = true;
    }
    return Object.freeze({
        diagnostics: Object.freeze(diagnostics),
        diagnosticsTruncated,
    });
}

type ManagedServiceCleanupPhase =
    | 'establishment'
    | 'endpointProjection'
    | 'outputSubscription'
    | 'process'
    | 'durableLog'
    | 'portReservation';
type ManagedServiceCleanupFailure = Readonly<{
    phase: ManagedServiceCleanupPhase;
    cause: unknown;
}>;

function fail(code: string, message: string): never {
    throw new PluginError({ code, message });
}

function managedServiceCleanupAggregate(
    failures: readonly ManagedServiceCleanupFailure[],
): AggregateError & Readonly<{ code: string }> {
    const sanitized: PluginError[] = [];
    const append = (
        phase: ManagedServiceCleanupPhase,
        cause: unknown,
    ): void => {
        if (cause instanceof AggregateError) {
            for (const nested of cause.errors) append(phase, nested);
            return;
        }
        const nestedPhase = isPluginError(cause)
            && cause.code === 'plugin_managed_server_cleanup_failed'
            && cause.details
            && !Array.isArray(cause.details)
            && typeof cause.details === 'object'
            && 'phase' in cause.details
            && (
                cause.details.phase === 'establishment'
                || cause.details.phase === 'endpointProjection'
                || cause.details.phase === 'outputSubscription'
                || cause.details.phase === 'process'
                || cause.details.phase === 'durableLog'
                || cause.details.phase === 'portReservation'
            )
            ? cause.details.phase
            : phase;
        sanitized.push(new PluginError({
            code: 'plugin_managed_server_cleanup_failed',
            message: 'Managed server cleanup did not complete safely',
            details: { phase: nestedPhase },
        }));
    };
    for (const failure of failures) append(failure.phase, failure.cause);
    return Object.assign(new AggregateError(
        sanitized,
        'Managed server cleanup did not complete safely',
    ), {
        code: 'plugin_managed_server_cleanup_failed',
    });
}

export function readManagedServiceProcessCredentialRedactionValues(
    credential: ManagedServiceProcessCredential | undefined,
): readonly string[] {
    if (!credential) return Object.freeze([]);
    const httpHeader = credential.httpHeader;
    const authorizationValue = httpHeader
        && httpHeader.name.trim().toLowerCase() === 'authorization'
        ? httpHeader.value
        : undefined;
    return Object.freeze([...new Set([
        ...readCredentialRedactionValues({
            ...(credential.environment?.value
                ? { rawCredential: credential.environment.value }
                : {}),
            ...(authorizationValue ? { authorizationValue } : {}),
        }),
        ...(httpHeader && !authorizationValue ? [httpHeader.value] : []),
    ])]);
}

function durableLogSecretValues(spec: ManagedServiceProcessSpec): readonly string[] {
    if (spec.mode.kind !== 'managedSpawn') return Object.freeze([]);
    const values = [
        ...(spec.launch?.args ?? []),
        ...Object.values(spec.launch?.env ?? {}),
        ...readManagedServiceProcessCredentialRedactionValues(
            spec.mode.credential,
        ),
        ...(spec.healthCheck?.kind === 'http' ? Object.values(spec.healthCheck.headers ?? {}) : []),
    ];
    return Object.freeze([...new Set(values.filter((value) => value.length > 0))]);
}

function normalizeLoopbackHost(host: string): '127.0.0.1' | '::1' {
    if (host === '127.0.0.1' || host === '::1') return host;
    return fail(
        'plugin_managed_server_endpoint_denied',
        'Managed servers must bind or attach to an explicit loopback address',
    );
}

function validatePort(port: number): number {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        return fail('plugin_managed_server_endpoint_invalid', 'Managed server port must be between 1 and 65535');
    }
    return port;
}

/**
 * Applies the shared endpoint-URL rule and turns a rejection into this
 * supervisor's typed failure. The `hostPolicy` is the only thing that differs
 * between a port this host allocated for a process it spawned (`ownedLoopback`)
 * and an address the user typed for a server they run (`userDeclaredAttach`).
 */
function parseManagedServiceEndpointUrl(
    value: string,
    hostPolicy: ManagedServiceEndpointHostPolicy,
    options: Readonly<{ allowSearch?: boolean; allowHash?: boolean }> = {},
): ManagedServiceProcessEndpoint {
    const read = readManagedServiceEndpointUrl(value, { hostPolicy, ...options });
    if (read.ok) {
        return Object.freeze({ ...read.endpoint, hostPolicy });
    }
    switch (read.rejection) {
        case 'malformed':
            return fail('plugin_managed_server_endpoint_invalid', 'Managed server base URL is invalid');
        case 'queryOrFragment':
            return fail(
                'plugin_managed_server_endpoint_invalid',
                'Managed server base URLs cannot carry query credentials or fragments',
            );
        case 'port':
            return fail('plugin_managed_server_endpoint_invalid', 'Managed server port must be between 1 and 65535');
        case 'embeddedCredentials':
            return fail(
                'plugin_managed_server_endpoint_denied',
                'Managed server endpoints must not embed credentials in the URL',
            );
        default:
            return fail(
                'plugin_managed_server_endpoint_denied',
                hostPolicy === 'userDeclaredAttach'
                    ? 'Attached server endpoints must be http or https URLs naming a host'
                    : 'Managed server endpoints must use credential-free HTTP loopback URLs',
            );
    }
}

function resolveHealthServerPath(path: string, endpoint: ManagedServiceProcessEndpoint): ManagedServiceProcessEndpoint {
    if (!path.startsWith('/')) {
        return fail('plugin_managed_server_health_invalid', 'Managed server health path must be absolute');
    }
    // A declared service path names a route WITHIN the supervised service, so it
    // resolves under the endpoint's own base path. Resolving it against the
    // origin instead discards a reverse-proxy prefix and probes a route that is
    // not the service — a server the operator declared behind a prefix could
    // never become healthy. A spawned loopback endpoint carries no base path, so
    // its probe URL is unchanged.
    const basePath = new URL(`${endpoint.baseUrl}/`).pathname.replace(/\/+$/u, '');
    const target = parseManagedServiceEndpointUrl(
        new URL(`${basePath}${path}`, `${endpoint.baseUrl}/`).toString(),
        endpoint.hostPolicy,
        { allowSearch: true },
    );
    if (target.host !== endpoint.host || target.port !== endpoint.port) {
        return fail(
            'plugin_managed_server_endpoint_denied',
            'Managed server health checks must target the supervised endpoint',
        );
    }
    return target;
}

function canonicalHealthCheckFacts(
    check: ManagedServiceProcessHealthCheck,
    hostPolicy: ManagedServiceEndpointHostPolicy,
): ManagedServiceProcessHealthCheck {
    if (check.kind === 'command') return check;
    const { resolveHeaders: _resolveHeaders, ...canonicalCheck } = check;
    const fixtureEndpoint = Object.freeze({
        baseUrl: 'http://127.0.0.1:49152',
        host: '127.0.0.1',
        port: 49_152,
        hostPolicy: 'ownedLoopback' as const,
    });
    if (check.alternatives) {
        return {
            ...canonicalCheck,
            alternatives: check.alternatives.map((alternative) => {
                const canonical = new URL(healthCheckUrl(
                    check,
                    fixtureEndpoint,
                    alternative.target,
                ));
                return {
                    ...alternative,
                    target: {
                        kind: 'serverPath' as const,
                        path: `${canonical.pathname}${canonical.search}`,
                    },
                };
            }),
        };
    }
    if (!check.target) return canonicalCheck;
    if (check.target.kind === 'url') {
        return {
            ...canonicalCheck,
            target: {
                kind: 'url',
                url: parseManagedServiceEndpointUrl(check.target.url, hostPolicy, { allowSearch: true }).baseUrl,
            },
        };
    }
    const canonical = new URL(resolveHealthServerPath(check.target.path, fixtureEndpoint).baseUrl);
    return {
        ...canonicalCheck,
        target: { kind: 'serverPath', path: `${canonical.pathname}${canonical.search}` },
    };
}

function canonicalSpecFacts(spec: ManagedServiceProcessSpec): unknown {
    if (spec.startupTimeoutMs !== undefined && (
        !Number.isSafeInteger(spec.startupTimeoutMs)
        || spec.startupTimeoutMs
            < MANAGED_SERVICE_NUMERIC_CONTRACT.startupTimeoutMs.minimum
    )) {
        return fail('plugin_managed_server_timeout_invalid', 'Managed server startup timeout must be a positive safe integer');
    }
    if (!spec.watchdog || (
        !Number.isSafeInteger(spec.watchdog.intervalMs)
        || spec.watchdog.intervalMs
            < MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs.minimum
        || spec.watchdog.intervalMs
            > MANAGED_SERVICE_NUMERIC_CONTRACT.healthIntervalMs.maximum
        || !Number.isSafeInteger(spec.watchdog.missedIntervals)
        || spec.watchdog.missedIntervals
            < MANAGED_SERVICE_NUMERIC_CONTRACT.consecutiveFailures.minimum
        || spec.watchdog.missedIntervals
            > MANAGED_SERVICE_NUMERIC_CONTRACT.consecutiveFailures.maximum
    )) {
        return fail(
            'plugin_managed_server_watchdog_invalid',
            'Managed server watchdog interval or consecutive-failure count is invalid',
        );
    }
    if (spec.healthCheck && (
        !Number.isSafeInteger(spec.healthCheck.timeoutMs)
        || spec.healthCheck.timeoutMs
            < MANAGED_SERVICE_NUMERIC_CONTRACT.healthTimeoutMs.minimum
        || spec.healthCheck.timeoutMs
            > MANAGED_SERVICE_NUMERIC_CONTRACT.healthTimeoutMs.maximum
    )) {
        return fail(
            'plugin_managed_server_health_timeout_invalid',
            'Managed server health timeout must be between 1 and 60000 milliseconds',
        );
    }
    if (spec.healthCheck?.kind === 'http' && spec.healthCheck.alternatives) {
        if (
            spec.healthCheck.target !== undefined
            || spec.healthCheck.alternatives.length === 0
            || spec.healthCheck.alternatives.some((alternative) => (
                alternative.target.kind !== 'serverPath'
                || typeof alternative.target.path !== 'string'
                || alternative.target.path.length === 0
                || !isManagedServiceHttpHealthResponse(alternative.response)
            ))
        ) {
            return fail(
                'plugin_managed_server_health_invalid',
                'Managed server ordered health alternatives are invalid',
            );
        }
    }
    if (spec.durableLog && (
        !Number.isSafeInteger(spec.durableLog.keepCount)
        || spec.durableLog.keepCount
            < MANAGED_SERVICE_NUMERIC_CONTRACT.durableLogKeepCount.minimum
        || spec.durableLog.keepCount
            > MANAGED_SERVICE_NUMERIC_CONTRACT.durableLogKeepCount.maximum
    )) {
        return fail(
            'plugin_managed_server_timeout_invalid',
            'Managed server durable-log keep count must be between 1 and 50',
        );
    }
    if (spec.mode.kind === 'externalAttach') {
        const endpoint = parseManagedServiceEndpointUrl(spec.mode.baseUrl, 'userDeclaredAttach');
        return {
            ...spec,
            mode: { ...spec.mode, baseUrl: endpoint.baseUrl },
            ...(spec.healthCheck
                ? { healthCheck: canonicalHealthCheckFacts(spec.healthCheck, 'userDeclaredAttach') }
                : {}),
        };
    }
    if (spec.mode.kind === 'native') {
        return spec;
    }
    if (spec.mode.endpointNone) {
        if (spec.healthCheck?.kind === 'http') {
            return fail('plugin_managed_service_unavailable', 'URL-less service has no HTTP health capability');
        }
        return spec;
    }
    const host = normalizeLoopbackHost(spec.mode.host ?? '127.0.0.1');
    const port = spec.mode.port === undefined ? null : validatePort(spec.mode.port);
    const baseUrl = spec.mode.baseUrl === undefined
        ? null
        : parseManagedServiceEndpointUrl(spec.mode.baseUrl, 'ownedLoopback').baseUrl;
    if (baseUrl !== null) {
        const parsed = parseManagedServiceEndpointUrl(baseUrl, 'ownedLoopback');
        if (parsed.host !== host || (port !== null && parsed.port !== port)) {
            return fail(
                'plugin_managed_server_endpoint_invalid',
                'Managed server base URL must match its selected loopback host and port',
            );
        }
    }
    return {
        ...spec,
        mode: {
            ...spec.mode,
            host,
            port,
            baseUrl,
        },
        ...(spec.healthCheck
            ? { healthCheck: canonicalHealthCheckFacts(spec.healthCheck, 'ownedLoopback') }
            : {}),
    };
}

function assertSpecId(id: string): void {
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
        fail('plugin_managed_server_id_invalid', 'Managed server id must be between 1 and 256 code units');
    }
}

function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted) fail('plugin_managed_server_aborted', 'Managed server operation was aborted');
}

async function waitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    assertNotAborted(signal);
    if (!signal) return await promise;
    let abort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new PluginError({
            code: 'plugin_managed_server_aborted',
            message: 'Managed server operation was aborted',
        }));
        signal.addEventListener('abort', abort, { once: true });
    });
    try {
        return await Promise.race([promise, aborted]);
    } finally {
        if (abort) signal.removeEventListener('abort', abort);
    }
}

function freezeSnapshot(snapshot: ManagedServiceProcessSnapshot): ManagedServiceProcessSnapshot {
    return Object.freeze({ ...snapshot });
}

function processExitCode(result: PluginProcessResult): string {
    const observed = result.termination.observed;
    if (observed.kind === 'exit') return `exit_${observed.exitCode}`;
    if (observed.kind === 'signal') return 'signal';
    return observed.diagnostic.code;
}

type ManagedServiceProcessHttpHealthCheck = Extract<
    ManagedServiceProcessHealthCheck,
    Readonly<{ kind: 'http' }>
>;

type ManagedServiceProcessHttpHealthTarget =
    NonNullable<ManagedServiceProcessHttpHealthCheck['target']>;

function healthCheckUrl(
    check: ManagedServiceProcessHttpHealthCheck,
    endpoint: ManagedServiceProcessEndpoint,
    target: ManagedServiceProcessHttpHealthTarget | undefined = check.target,
): string {
    if (!target || target.kind === 'serverPath') {
        const path = target?.path ?? '/';
        return resolveHealthServerPath(path, endpoint).baseUrl;
    }
    const parsedTarget = parseManagedServiceEndpointUrl(target.url, endpoint.hostPolicy, { allowSearch: true });
    if (parsedTarget.host !== endpoint.host || parsedTarget.port !== endpoint.port) {
        return fail(
            'plugin_managed_server_endpoint_denied',
            'Managed server health checks must target the supervised endpoint',
        );
    }
    return parsedTarget.baseUrl;
}

function validateHealthCheckTargets(
    check: ManagedServiceProcessHttpHealthCheck,
    endpoint: ManagedServiceProcessEndpoint,
): void {
    if (check.alternatives) {
        for (const alternative of check.alternatives) {
            healthCheckUrl(check, endpoint, alternative.target);
        }
        return;
    }
    healthCheckUrl(check, endpoint);
}

function readsManagedServiceHttpHealthResponse(
    body: unknown,
    response: ManagedServiceHttpHealthResponse,
): boolean {
    if (
        typeof body !== 'object'
        || body === null
        || Array.isArray(body)
    ) {
        return false;
    }
    const record = body as Readonly<Record<string, unknown>>;
    return Object.entries(response.required).every(([name, requirement]) => {
        const value = record[name];
        switch (requirement) {
            case 'true':
                return value === true;
            case 'nonEmptyString':
                return typeof value === 'string' && value.length > 0;
            case 'nonNegativeInteger':
                return typeof value === 'number'
                    && Number.isInteger(value)
                    && value >= 0;
            case 'array':
                return Array.isArray(value);
            case 'object':
                return typeof value === 'object'
                    && value !== null
                    && !Array.isArray(value);
        }
    });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    return new Promise((resolve, reject) => {
        const finish = () => {
            signal?.removeEventListener('abort', abort);
            resolve();
        };
        const timer = setTimeout(finish, ms);
        const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            reject(new PluginError({
                code: 'plugin_managed_server_aborted',
                message: 'Managed server operation was aborted',
            }));
        };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal) {
            void Promise.resolve().then(() => {
                if (signal.aborted) abort();
            });
        }
    });
}

export function createManagedServiceProcessSupervisorHost(params: Readonly<{
    fetch?: typeof fetch;
    now?: () => number;
    createInstanceId?: () => string;
    reservePort?: (
        host: LoopbackHost,
        preferredPort?: number,
        signal?: AbortSignal,
    ) => Promise<LoopbackPortReservation>;
    durability?: ManagedServiceProcessDurabilityOwner;
    captureProcessStartIdentity?: (pid: number) => Promise<string | null>;
    custodyOwner?: 'daemon' | 'sessionRunner';
    authorizeRunnerSupervision?: (
        input: RunnerManagedServiceSupervisionRequest,
    ) => Promise<RunnerManagedServiceSupervisionAuthorization>;
    resolveRunnerPackagedRuntimeExecutable?: (
        executable: PackagedRuntimeBinaryExecutableRef,
    ) => Promise<string | null>;
    transformRunnerManagedSpawnEnvironment?(
        environment: Readonly<Record<string, string>>,
    ): Readonly<Record<string, string>>;
    installPreauthorizedSpawn?: typeof installPreauthorizedPluginExecSpawnForHost;
    /** Native-custody runtime resolution; injected only by tests. */
    resolveProcessCustodyRuntimeExecutable?: () => string | null;
    /** Host platform; injected only by platform contract tests. */
    platform?: NodeJS.Platform;
}>): ManagedServiceProcessSupervisorHost {
    const now = params.now ?? Date.now;
    const fetchImpl = params.fetch ?? globalThis.fetch;
    const createInstanceId = params.createInstanceId ?? randomUUID;
    const custodyOwner = params.custodyOwner ?? 'daemon';
    const reservePort = params.reservePort ?? reserveLoopbackPort;
    // The establish scope shadows `process` with the supervised handle, so the host platform is
    // captured once here where the global is still visible.
    const hostPlatform: NodeJS.Platform = params.platform ?? process.platform;
    function resolveInitialEndpoint(spec: ManagedServiceProcessSpec): ManagedServiceProcessEndpoint | null {
        if (spec.mode.kind === 'externalAttach') {
            return parseManagedServiceEndpointUrl(spec.mode.baseUrl, 'userDeclaredAttach');
        }
        return null;
    }

    function launchRequest(spec: ManagedServiceProcessSpec, endpoint: ManagedServiceProcessEndpoint | null) {
        if (spec.mode.kind !== 'managedSpawn' || !spec.launch) {
            return fail('plugin_managed_server_launch_invalid', 'Managed server launch facts are missing');
        }
        const mode = spec.mode;
        const args = [...(spec.launch.args ?? [])];
        if (mode.portArgument) {
            if (!endpoint) return fail(
                'plugin_managed_server_endpoint_invalid',
                'Detected endpoints cannot be injected before launch',
            );
            args.push(mode.portArgument, String(endpoint.port));
        }
        const env = { ...(spec.launch.env ?? {}) };
        if (mode.portEnvironmentKey) {
            if (!endpoint) return fail(
                'plugin_managed_server_endpoint_invalid',
                'Detected endpoints cannot be injected before launch',
            );
            env[mode.portEnvironmentKey] = String(endpoint.port);
        }
        if (mode.baseUrlEnvironmentKey) {
            if (!endpoint) return fail(
                'plugin_managed_server_endpoint_invalid',
                'Detected endpoints cannot be injected before launch',
            );
            env[mode.baseUrlEnvironmentKey] = endpoint.baseUrl;
        }
        if (mode.credential?.environment) {
            env[mode.credential.environment.name] = mode.credential.environment.value;
        }
        return Object.freeze({
            ...spec.launch,
            maxStdoutBytes: Math.min(
                spec.launch.maxStdoutBytes ?? MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES,
                MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES,
            ),
            maxStderrBytes: Math.min(
                spec.launch.maxStderrBytes ?? MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES,
                MAX_BUFFERED_MANAGED_SERVER_OUTPUT_BYTES,
            ),
            ...(args.length > 0 ? { args: Object.freeze(args) } : {}),
            ...(Object.keys(env).length > 0 ? { env: Object.freeze(env) } : {}),
        });
    }

    async function establish(
        spec: ManagedServiceProcessSpec,
        entry: ManagedServiceProcessSupervision,
        scope: ManagedServiceProcessScope,
        registerEstablishmentCleanup?: (
            cleanup: () => Promise<void>,
            observation: ManagedServiceEstablishmentCustodyObservation,
        ) => Readonly<{ release(): void }>,
    ): Promise<ManagedServiceProcessHandle> {
        let endpoint = resolveInitialEndpoint(spec);
        if (spec.healthCheck?.kind === 'http' && endpoint) {
            validateHealthCheckTargets(spec.healthCheck, endpoint);
        }
        const issuedInstanceId = createInstanceId();
        const instanceId = typeof issuedInstanceId === 'string' ? issuedInstanceId.trim() : '';
        if (!instanceId) {
            return fail('plugin_managed_server_identity_failed', 'Host could not issue a managed server identity');
        }

        let process: PluginProcessHandle | null = null;
        let retainedLaunchRelease: HostAuthorizedPluginExecLaunch['release'] | null = null;
        const retainLaunch = (release: HostAuthorizedPluginExecLaunch['release']): void => {
            retainedLaunchRelease = release;
        };
        let portReservation: LoopbackPortReservation | null = null;
        let processStartIdentity: string | null = null;
        let supervisionLaunch: ResolvedPluginExecutable | null = null;
        let endpointProjectionToken: string | null = null;
        let endpointProjectionPublication: Promise<void> | null = null;
        let endpointProjectionRelease: Promise<void> | null = null;
        let durableLog: ManagedServiceDurableLogCapture | null = null;
        let outputSubscription: Readonly<{ dispose(): void }> | null = null;
        let processTerminal: Readonly<
            | { kind: 'result'; result: PluginProcessResult }
            | { kind: 'failed' }
        > | null = null;
        let processTerminalObservation: Promise<void> | null = null;
        let processContainmentTerminated = false;
        let cleanupPromise: Promise<void> | null = null;
        let outputDisposed = false;
        let processDisposed = false;
        let logClosed = false;
        const lifecycleProbeController = new AbortController();
        let watchdogTimer: ReturnType<typeof setInterval> | null = null;
        let watchdogInFlight = false;
        let consecutiveHealthMisses = 0;
        const snapshotListeners = new Set<
            (snapshot: ManagedServiceProcessSnapshot) => void
        >();
        let snapshot = freezeSnapshot({
            id: spec.id,
            instanceId,
            state: 'starting',
            mode: spec.mode.kind,
            baseUrl: endpoint?.baseUrl ?? null,
            port: endpoint?.port ?? null,
            pid: null,
            startedAtMs: spec.mode.kind !== 'externalAttach' ? now() : null,
            lastHealthyAtMs: null,
            diagnostics: Object.freeze([]),
            diagnosticsTruncated: false,
        });
        function retainObserverFailure(): void {
            const retained = retainManagedServiceDiagnostic(snapshot, {
                code: 'plugin_managed_service_observer_failed',
                severity: 'warning',
            });
            snapshot = freezeSnapshot({ ...snapshot, ...retained });
        }
        function notifySnapshotListeners(
            diagnoseFailures: boolean,
        ): void {
            const failedListeners: Array<
                (snapshot: ManagedServiceProcessSnapshot) => void
            > = [];
            for (const listener of snapshotListeners) {
                try {
                    listener(snapshot);
                } catch {
                    failedListeners.push(listener);
                }
            }
            if (failedListeners.length === 0) return;
            for (const listener of failedListeners) {
                snapshotListeners.delete(listener);
            }
            if (!diagnoseFailures) return;
            retainObserverFailure();
            notifySnapshotListeners(false);
        }
        const setSnapshot = (
            next: ManagedServiceProcessSnapshot,
        ): void => {
            snapshot = freezeSnapshot(next);
            notifySnapshotListeners(true);
        };
        const isStopped = (): boolean => snapshot.state === 'stopped';
        const isStopping = (): boolean => cleanupPromise !== null;
        const hasProvenManagedProcessTermination = (): boolean => {
            if (spec.mode.kind === 'externalAttach' || !process) return true;
            const terminal = processTerminal;
            return processContainmentTerminated
                && terminal?.kind === 'result'
                && (
                    terminal.result.termination.observed.kind === 'exit'
                    || terminal.result.termination.observed.kind === 'signal'
                );
        };
        const terminationIncomplete = (cause?: unknown): PluginError => new PluginError({
            code: 'plugin_managed_server_termination_incomplete',
            message: 'Managed server termination could not be verified',
            retryable: true,
        }, cause === undefined ? undefined : { cause });
        const observeSpawnedProcessTerminal = (): void => {
            if (!process || processTerminalObservation) return;
            processTerminalObservation = process.wait().then((result) => {
                processTerminal = Object.freeze({ kind: 'result', result });
                if (spec.mode.kind === 'native') {
                    return;
                }
                lifecycleProbeController.abort();
                stopWatchdog();
                setUnhealthy('plugin_managed_server_process_exited');
            }).catch(() => {
                processTerminal = Object.freeze({ kind: 'failed' });
                if (spec.mode.kind === 'native') {
                    return;
                }
                lifecycleProbeController.abort();
                stopWatchdog();
                setUnhealthy('plugin_managed_server_process_failed');
            });
            void processTerminalObservation;
        };
        const assertProcessRunning = (): void => {
            if (!processTerminal || spec.mode.kind === 'native') return;
            if (processTerminal.kind === 'failed') {
                return fail('plugin_managed_server_process_failed', 'Managed server process observation failed');
            }
            return fail('plugin_managed_server_process_exited',
                `Managed server process exited (${processExitCode(processTerminal.result)})`);
        };
        const isGenerationUsable = (): boolean => {
            try {
                return scope.isOccurrenceCurrent() && !entry.lifecycle.signal.aborted;
            } catch {
                return false;
            }
        };
        const assertGenerationUsable = (): void => {
            if (!isGenerationUsable()) fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
        };
        const requireEndpoint = (): ManagedServiceProcessEndpoint => endpoint ?? fail(
            'plugin_managed_server_endpoint_unavailable',
            'Managed server endpoint detection is incomplete',
        );
        async function publishEndpointProjection(): Promise<void> {
            if (scope.kind === 'project') return;
            if (endpointProjectionPublication) {
                await endpointProjectionPublication;
                return;
            }
            const durability = params.durability;
            const sessionId = scope.sessionId;
            if (
                endpointProjectionToken
                || !durability
                || !sessionId
                || isStopping()
                || isStopped()
                || !endpoint
                || spec.mode.kind === 'native'
            ) return;
            const publication = (async () => {
                // The projection persists the address only; which policy admitted
                // it is re-derived from the record's own `mode` when it is read.
                const { hostPolicy: _hostPolicy, ...projectedEndpoint } = requireEndpoint();
                const common = {
                    sessionId,
                    pluginId: scope.pluginId,
                    contributionId: scope.contributionId,
                    ...(scope.operationId
                        ? { operationClaimId: scope.operationId }
                        : {}),
                    serverId: spec.id,
                    instanceId,
                    sourceCustody: scope.sourceCustody ?? (() => {
                        throw new PluginError({
                            code: 'plugin_managed_server_projection_custody_missing',
                            message: 'Managed server endpoint projection source custody is unavailable',
                        });
                    })(),
                    custodyOwner,
                    endpoint: projectedEndpoint,
                    createdAtMs: snapshot.startedAtMs ?? now(),
                };
                if (spec.mode.kind === 'managedSpawn') {
                    if (
                        snapshot.pid === null
                        || !processStartIdentity
                    ) {
                        return fail(
                            'plugin_managed_server_projection_custody_missing',
                            'Managed server endpoint projection requires exact process custody',
                        );
                    }
                    endpointProjectionToken =
                        await durability.publishEndpointProjection(Object.freeze({
                            ...common,
                            mode: 'managedSpawn',
                            process: Object.freeze({
                                pid: snapshot.pid,
                                startIdentity: processStartIdentity,
                            }),
                        }));
                    return;
                }
                endpointProjectionToken =
                    await durability.publishEndpointProjection(Object.freeze({
                        ...common,
                        mode: 'externalAttach',
                        process: null,
                    }));
            })();
            endpointProjectionPublication = publication;
            try {
                await publication;
            } finally {
                if (endpointProjectionPublication === publication) {
                    endpointProjectionPublication = null;
                }
            }
        }

        async function releaseEndpointProjection(): Promise<void> {
            if (scope.kind === 'project') return;
            if (endpointProjectionPublication) {
                await endpointProjectionPublication;
            }
            if (!endpointProjectionToken || !params.durability) return;
            const projectionToken = endpointProjectionToken;
            endpointProjectionRelease ??= params.durability
                .releaseEndpointProjection({
                    instanceId,
                    projectionToken,
                    sessionId: scope.sessionId!,
                    pluginId: scope.pluginId,
                })
                .then(() => {
                    if (endpointProjectionToken === projectionToken) {
                        endpointProjectionToken = null;
                    }
                })
                .finally(() => {
                    endpointProjectionRelease = null;
                });
            await endpointProjectionRelease;
        }

        const setUnhealthy = (code: string): void => {
            if (snapshot.state === 'stopped') return;
            const retained = retainManagedServiceDiagnostic(snapshot, {
                code,
                severity: 'error',
            });
            setSnapshot({
                ...snapshot,
                state: 'unhealthy',
                ...retained,
            });
        };

        async function runBoundedHealthProbe(
            operation: (signal: AbortSignal) => Promise<boolean>,
            signal: AbortSignal | undefined,
            timeoutMs: number,
        ): Promise<boolean> {
            assertNotAborted(signal);
            assertGenerationUsable();
            if (lifecycleProbeController.signal.aborted) return false;
            const controller = new AbortController();
            let rejectForAbort: ((error: PluginError) => void) | null = null;
            const callerAbort = new Promise<never>((_resolve, reject) => {
                rejectForAbort = reject;
            });
            const abort = () => {
                controller.abort();
                rejectForAbort?.(new PluginError({
                    code: 'plugin_managed_server_aborted',
                    message: 'Managed server operation was aborted',
                }));
            };
            signal?.addEventListener('abort', abort, { once: true });
            let resolveForLifecycle: (() => void) | null = null;
            const lifecycleInterrupted = new Promise<false>((resolve) => {
                resolveForLifecycle = () => {
                    controller.abort();
                    resolve(false);
                };
                lifecycleProbeController.signal.addEventListener('abort', resolveForLifecycle, { once: true });
            });
            let timedOut = false;
            let timeout: ReturnType<typeof setTimeout> | null = null;
            const timeoutResult = new Promise<false>((resolve) => {
                timeout = setTimeout(() => {
                    timedOut = true;
                    controller.abort();
                    resolve(false);
                }, Math.max(1, timeoutMs));
                timeout.unref?.();
            });
            try {
                return await Promise.race([
                    operation(controller.signal),
                    timeoutResult,
                    callerAbort,
                    lifecycleInterrupted,
                ]);
            } catch (error) {
                if (signal?.aborted) {
                    return fail('plugin_managed_server_aborted', 'Managed server operation was aborted');
                }
                if (timedOut) return false;
                throw error;
            } finally {
                if (timeout) clearTimeout(timeout);
                signal?.removeEventListener('abort', abort);
                if (resolveForLifecycle) {
                    lifecycleProbeController.signal.removeEventListener('abort', resolveForLifecycle);
                }
            }
        }

        async function checkHealth(signal: AbortSignal | undefined, timeoutMs?: number): Promise<boolean> {
            assertNotAborted(signal);
            assertGenerationUsable();
            if (spec.mode.kind === 'native') {
                const observation = await inspectNative(signal);
                return observation.phase === 'running' && observation.readiness === 'ready';
            }
            const healthCheck = spec.healthCheck;
            if (!healthCheck) return true;
            const probeTimeoutMs = timeoutMs ?? healthCheck.timeoutMs;
            if (healthCheck.kind === 'command') {
                return await runBoundedHealthProbe(async (probeSignal) => {
                    if (!scope.exec) {
                        return fail('plugin_managed_service_unavailable', 'Project command-health admission is unavailable');
                    }
                    const result = await scope.exec.run({
                        executable: healthCheck.executable,
                        args: healthCheck.args,
                        timeoutMs: probeTimeoutMs,
                    }, { signal: probeSignal });
                    return result.termination.observed.kind === 'exit'
                        && result.termination.observed.exitCode === 0;
                }, signal, probeTimeoutMs);
            }
            return await runBoundedHealthProbe(async (probeSignal) => {
                const alternatives = healthCheck.alternatives ?? [{
                    target: healthCheck.target,
                    response: undefined,
                }];
                for (const alternative of alternatives) {
                    const leasedHeaders = healthCheck.resolveHeaders
                        ? await healthCheck.resolveHeaders(probeSignal)
                        : undefined;
                    if (
                        leasedHeaders?.isCurrent
                        && !await leasedHeaders.isCurrent(probeSignal)
                    ) {
                        return false;
                    }
                    const response = await fetchImpl(healthCheckUrl(
                        healthCheck,
                        requireEndpoint(),
                        alternative.target,
                    ), {
                        method: 'GET',
                        headers: {
                            ...(healthCheck.headers ?? {}),
                            ...(leasedHeaders?.headers ?? {}),
                        },
                        redirect: 'manual',
                        signal: probeSignal,
                    });
                    try {
                        if (!response.ok) continue;
                        if (!alternative.response) return true;
                        const contentType = response.headers.get('content-type') ?? '';
                        if (!/^application\/(?:[^;]+\+)?json(?:\s*;|$)/iu.test(contentType)) {
                            continue;
                        }
                        const body = await response.json().catch(() => null);
                        if (readsManagedServiceHttpHealthResponse(
                            body,
                            alternative.response,
                        )) {
                            return true;
                        }
                    } finally {
                        // Status-only and rejected shaped probes both settle
                        // their bodies so repeating watchdogs retain no socket.
                        try {
                            await response.body?.cancel();
                        } catch {
                            // A consumed, locked, or aborted body is settled.
                        }
                    }
                }
                return false;
            }, signal, probeTimeoutMs);
        }

        async function observeOwnedTreeEndpoint(managedPid: number, signal: AbortSignal): Promise<boolean> {
            if (spec.mode.kind !== 'managedSpawn' || !spec.mode.endpointDetection) return false;
            const scan = await waitWithAbort(scanPlatformLocalServices(), signal);
            assertNotAborted(signal);
            assertProcessRunning();
            assertGenerationUsable();
            const inventorySnapshot = normalizeLocalServiceScan({
                machineId: 'managed-service-endpoint-detection', now: now(), previous: null,
                listeners: scan.listeners, processes: scan.processes, workspaces: scan.workspaces,
            });
            const selected = selectManagedOwnedTreeEndpoint({
                entries: inventorySnapshot.entries.filter(candidate => candidate.state === 'listening' && candidate.address.kind === 'loopback'),
                managedPid, minimumConfidence: spec.mode.endpointDetection.minimumConfidence,
            });
            const host = selected && inventorySnapshot.entries.find(({ id }) => id === selected.id)?.address.family === 'ipv6'
                ? '::1' as const : '127.0.0.1' as const;
            endpoint = selected ? Object.freeze({ host, port: selected.port,
                baseUrl: host === '::1' ? `http://[::1]:${selected.port}` : `http://127.0.0.1:${selected.port}`,
                hostPolicy: 'ownedLoopback' as const }) : null;
            if (snapshot.baseUrl !== (endpoint?.baseUrl ?? null) || snapshot.port !== (endpoint?.port ?? null)) {
                setSnapshot({ ...snapshot, baseUrl: endpoint?.baseUrl ?? null, port: endpoint?.port ?? null });
            }
            if (!endpoint) await releaseEndpointProjection();
            return endpoint !== null;
        }

        const observesOptionalEndpoint = spec.mode.kind === 'managedSpawn' && spec.mode.endpointNone && Boolean(spec.mode.endpointDetection);

        async function watchdogTick(): Promise<void> {
            if (watchdogInFlight || isStopped() || (processTerminal && spec.mode.kind !== 'native')) return;
            const healthCheck = spec.healthCheck;
            if (!healthCheck && spec.mode.kind !== 'native' && !observesOptionalEndpoint) return;
            if (!isGenerationUsable()) {
                if (watchdogTimer) {
                    clearInterval(watchdogTimer);
                    watchdogTimer = null;
                }
                return;
            }
            watchdogInFlight = true;
            try {
                if (observesOptionalEndpoint && snapshot.pid !== null) {
                    try {
                        if (await observeOwnedTreeEndpoint(snapshot.pid, AbortSignal.any([entry.lifecycle.signal, lifecycleProbeController.signal]))) {
                            await publishEndpointProjection();
                        }
                    } catch {
                        if (!isStopping() && !isStopped() && !processTerminal && isGenerationUsable()) {
                            endpoint = null;
                            setSnapshot({ ...snapshot, baseUrl: null, port: null });
                            await releaseEndpointProjection();
                        }
                    }
                }
                // An address observation never establishes readiness for an endpoint-free lifetime.
                if (!healthCheck && spec.mode.kind !== 'native') return;
                if (await checkHealth(undefined, healthCheck?.timeoutMs)) {
                    consecutiveHealthMisses = 0;
                    if (!isStopped() && (!processTerminal || spec.mode.kind === 'native') && isGenerationUsable()) {
                        setSnapshot({
                            ...snapshot,
                            state: 'healthy',
                            lastHealthyAtMs: now(),
                        });
                        await publishEndpointProjection();
                    }
                    return;
                }
            } catch {
                // A failed probe is one missed interval; the bounded watchdog decides terminal health truth.
                if (spec.mode.kind === 'native' && !isStopped()) {
                    setUnhealthy('plugin_managed_service_native_observation_failed');
                }
            } finally {
                watchdogInFlight = false;
            }
            if (isStopped() || (processTerminal && spec.mode.kind !== 'native') || !isGenerationUsable() || spec.mode.kind === 'native') return;
            consecutiveHealthMisses += 1;
            if (consecutiveHealthMisses >= spec.watchdog.missedIntervals) {
                setUnhealthy('plugin_managed_server_watchdog_unhealthy');
                await releaseEndpointProjection();
            }
        }

        function startWatchdog(): void {
            if (watchdogTimer || (!spec.healthCheck && spec.mode.kind !== 'native' && !observesOptionalEndpoint)) return;
            const intervalMs = spec.watchdog.intervalMs;
            watchdogTimer = setInterval(() => { void watchdogTick(); }, intervalMs);
            watchdogTimer.unref?.();
            if (observesOptionalEndpoint) void watchdogTick();
        }

        function stopWatchdog(): void {
            if (!watchdogTimer) return;
            clearInterval(watchdogTimer);
            watchdogTimer = null;
        }

        async function releasePortReservation(): Promise<void> {
            const reservation = portReservation;
            if (!reservation) return;
            await reservation.release();
            if (portReservation === reservation) portReservation = null;
        }

        async function inspectNative(signal?: AbortSignal): Promise<ManagedServiceNativeObservationV1> {
            if (spec.mode.kind !== 'native') {
                return fail('plugin_managed_service_unavailable', 'Native lifecycle is unavailable');
            }
            assertNotAborted(signal);
            assertGenerationUsable();
            try {
                const observation = await waitWithAbort(spec.mode.builtinLifecycle
                    ? spec.mode.builtinLifecycle.inspect({ signal })
                    : spec.mode.lifecycle.inspect(spec.mode.instance, { signal }), signal);
                assertNotAborted(signal);
                assertGenerationUsable();
                if (!observation
                    || !['running', 'stopped', 'unknown'].includes(observation.phase)
                    || !['ready', 'not_ready', 'not_reported'].includes(observation.readiness)
                    || (observation.endpoint !== null && typeof observation.endpoint !== 'string')) {
                    return fail('plugin_managed_service_unavailable', 'Native observation is invalid');
                }
                // A delayed read cannot supersede an already authoritative stop witness.
                if (nativeStopped || isStopped()) {
                    return observation;
                }
                endpoint = observation.endpoint === null
                    ? null
                    : parseManagedServiceEndpointUrl(observation.endpoint, 'ownedLoopback');
                const state = observation.phase === 'stopped'
                    // Native resource death is not settlement of its still-owned starter tree.
                    ? hasProvenManagedProcessTermination() ? 'stopped' : 'unhealthy'
                    : observation.phase === 'unknown'
                        ? 'unhealthy'
                        : observation.readiness === 'ready' ? 'healthy' : 'running';
                setSnapshot({
                    ...snapshot,
                    state,
                    readiness: observation.readiness,
                    nativePhase: observation.phase,
                    baseUrl: endpoint?.baseUrl ?? null,
                    port: endpoint?.port ?? null,
                    ...(observation.phase === 'running' && observation.readiness === 'ready'
                        ? { lastHealthyAtMs: now() }
                        : {}),
                });
                if (spec.mode.builtinLifecycle?.logs && observation.phase === 'running') {
                    try {
                        const message = sanitizeExecDiagnosticText(await spec.mode.builtinLifecycle.logs({ signal }),
                            MAX_MANAGED_SERVICE_DIAGNOSTIC_BYTES, { redactedValues: spec.mode.builtinLifecycle.redactedValues });
                        if (message && !snapshot.diagnostics.some(item => item.code === 'native_service_output' && item.message === message)) {
                            setSnapshot({ ...snapshot, ...retainManagedServiceDiagnostic(snapshot, {
                                code: 'native_service_output', severity: 'info', message,
                            }) });
                        }
                    } catch {
                        if (signal?.aborted) assertNotAborted(signal);
                        // Log failure cannot withdraw a separate native lifetime observation.
                        setSnapshot({ ...snapshot, ...retainManagedServiceDiagnostic(snapshot, {
                            code: 'native_service_logs_unavailable', severity: 'warning',
                        }) });
                    }
                }
                return observation;
            } catch (error) {
                // Failure of a current native read withdraws its previous running evidence,
                // but cancellation/retirement cannot supersede settled native custody.
                if (!nativeStopped && snapshot.nativePhase !== 'stopped' && !isStopped() && !signal?.aborted
                    && !entry.lifecycle.signal.aborted && isGenerationUsable()) {
                    endpoint = null;
                    setSnapshot({ ...snapshot, state: 'unhealthy', nativePhase: 'unknown',
                        readiness: 'not_reported', baseUrl: null, port: null,
                        ...retainManagedServiceDiagnostic(snapshot, {
                            code: 'plugin_managed_service_native_observation_failed', severity: 'error',
                        }) });
                    await releaseEndpointProjection();
                }
                throw error;
            }
        }

        let nativeStopped = false;

        async function cleanup(): Promise<void> {
            if (!cleanupPromise) {
                lifecycleProbeController.abort();
                stopWatchdog();
                const attempt = (async () => {
                    const failures: ManagedServiceCleanupFailure[] = [];
                    if (spec.mode.kind === 'native' && !nativeStopped) {
                        if (snapshot.state === 'stopped') {
                            nativeStopped = true;
                        } else {
                            const result = spec.mode.builtinLifecycle
                                ? await spec.mode.builtinLifecycle.stop()
                                : await spec.mode.lifecycle.stop(spec.mode.instance);
                            nativeStopped = result.status === 'stopped';
                            if (!nativeStopped && result.status !== 'unsupported') {
                                try {
                                    nativeStopped = (await inspectNative()).phase === 'stopped';
                                } catch {
                                    // Uncertain observation retains custody.
                                }
                            }
                            if (!nativeStopped) {
                                return fail(
                                    result.status === 'unsupported'
                                        ? 'plugin_managed_service_unavailable'
                                        : 'plugin_managed_server_termination_incomplete',
                                    'Native service stop is unconfirmed',
                                );
                            }
                        }
                        setSnapshot({ ...snapshot,
                            state: hasProvenManagedProcessTermination() ? 'stopped' : 'unhealthy', nativePhase: 'stopped' });
                    }
                    if (!processDisposed) {
                        if (!process) {
                            processDisposed = true;
                        }
                        let processDisposalFailure: unknown = null;
                        if (process) {
                            try {
                                await process.dispose();
                                processContainmentTerminated = true;
                                // The canonical process handle only resolves
                                // disposal after its exact terminal result is
                                // available. Join that same waiter here so the
                                // managed-service snapshot and projection are
                                // decided from the terminal fact, not a later
                                // microtask scheduling accident.
                                await processTerminalObservation;
                            } catch (error) {
                                processDisposalFailure = error;
                            }
                        }
                        // The canonical process handle resolves `dispose()`
                        // and its terminal waiter from the same observed OS
                        // fact. Join that already-started waiter before
                        // deciding whether cleanup proved termination; merely
                        // returning from the termination request is not proof.
                        if (
                            process
                            && !hasProvenManagedProcessTermination()
                        ) {
                            // `dispose()` returning or a terminator reporting
                            // success does not establish that the exact child
                            // exited. Keep its projection, logs, port lease and
                            // host-private process custody until a real terminal
                            // observation arrives.
                            throw terminationIncomplete(processDisposalFailure);
                        }
                        if (process) processDisposed = true;
                        if (
                            processDisposalFailure !== null
                            && !(
                                isPluginError(processDisposalFailure)
                                && processDisposalFailure.code
                                    === 'plugin_exec_termination_incomplete'
                            )
                        ) {
                            failures.push({
                                phase: 'process',
                                cause: processDisposalFailure,
                            });
                        }
                    }
                    try {
                        await releaseEndpointProjection();
                    } catch (error) {
                        failures.push({
                            phase: 'endpointProjection',
                            cause: error,
                        });
                    }
                    if (!outputDisposed) {
                        try {
                            outputSubscription?.dispose();
                            outputDisposed = true;
                        } catch (error) {
                            failures.push({
                                phase: 'outputSubscription',
                                cause: error,
                            });
                        }
                    }
                    if (!logClosed) {
                        try {
                            await durableLog?.close();
                            logClosed = true;
                        } catch (error) {
                            failures.push({
                                phase: 'durableLog',
                                cause: error,
                            });
                        }
                    }
                    try {
                        await releasePortReservation();
                    } catch (error) {
                        failures.push({
                            phase: 'portReservation',
                            cause: error,
                        });
                    }
                    if (failures.length > 0) {
                        throw managedServiceCleanupAggregate(failures);
                    }
                    const release = retainedLaunchRelease;
                    await release?.();
                    retainedLaunchRelease = null;
                    if (processDisposed) {
                        setSnapshot({ ...snapshot, state: 'stopped' });
                    }
                })();
                cleanupPromise = attempt;
                try {
                    await attempt;
                } finally {
                    if (cleanupPromise === attempt) cleanupPromise = null;
                    if (spec.mode.kind === 'native' && !nativeStopped && !isStopped() && isGenerationUsable()) {
                        startWatchdog();
                    }
                }
                return;
            }
            await cleanupPromise;
        }

        const establishHandle = async (): Promise<
            ManagedServiceProcessHandle
        > => {
        if (spec.mode.kind === 'native') {
            if (custodyOwner !== 'daemon') {
                return fail('plugin_managed_service_unavailable', 'Native lifetime requires daemon custody');
            }
            assertGenerationUsable();
            if (scope.kind === 'project' && spec.authorizeLaunch) {
                const launch = await spec.authorizeLaunch({ endpoint: null, signal: entry.lifecycle.signal });
                try {
                    assertGenerationUsable();
                    assertNotAborted(entry.lifecycle.signal);
                } catch (error) {
                    await launch.release();
                    throw error;
                }
                let startRequired = true;
                if (spec.mode.builtinLifecycle) {
                    // Recovery first observes the surviving native resource. Unknown is
                    // retained as unknown, never permission to run a replacement starter.
                    retainLaunch(launch.release);
                    const incumbent = await spec.mode.builtinLifecycle.inspect({ signal: entry.lifecycle.signal });
                    startRequired = incumbent.phase === 'stopped';
                    if (startRequired) await spec.mode.builtinLifecycle.prepareStart?.({ signal: entry.lifecycle.signal });
                }
                assertGenerationUsable();
                assertNotAborted(entry.lifecycle.signal);
                if (startRequired) process = spawnAuthorizedHostExecLaunchForHost(launch, { signal: entry.lifecycle.signal, retainLaunch }).handle;
            } else if (scope.exec && spec.launch) {
                process = await scope.exec.spawn(spec.launch, { signal: entry.lifecycle.signal });
            } else {
                return fail('plugin_managed_service_unavailable', 'Native launch admission is unavailable');
            }
            observeSpawnedProcessTerminal();
            if (spec.mode.builtinLifecycle && process) {
                // Detached up is a finite starter. Its exit does not decide resource death;
                // join it before the first post-launch native observation instead.
                const result = await waitWithAbort(process.wait(), entry.lifecycle.signal);
                if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== 0) {
                    return fail('native_service_start_failed', 'Native starter failed');
                }
                await process.dispose();
                processContainmentTerminated = true;
                await processTerminalObservation;
            }
            await inspectNative(entry.lifecycle.signal);
            startWatchdog();
        } else if (spec.mode.kind === 'managedSpawn') {
            let managedProcessCustody: ProcessCustodySpawnSpec | null = null;
            if (hostPlatform === 'win32') {
                // Windows managed spawn is real job custody — but it is
                // fail-closed about its helper: without the staged custody
                // runtime the host cannot prove containment, so it refuses
                // to spawn at all rather than owning an uncontained tree.
                const custodyExecutablePath = (
                    params.resolveProcessCustodyRuntimeExecutable
                    ?? resolveProcessCustodyRuntimeExecutable
                )();
                if (!custodyExecutablePath) {
                    return fail(
                        'plugin_managed_server_custody_failed',
                        'Managed server process-tree custody helper is unavailable on Windows',
                    );
                }
                managedProcessCustody = Object.freeze({
                    jobName: createWindowsJobCustodyName(instanceId),
                    executablePath: custodyExecutablePath,
                    handshakePath: createProcessCustodyHandshakePath(),
                });
            }
            if (!spec.mode.endpointDetection && !spec.mode.endpointNone) {
                const host = normalizeLoopbackHost(
                    spec.mode.host ?? '127.0.0.1',
                );
                const declaredEndpoint = spec.mode.baseUrl
                    ? parseManagedServiceEndpointUrl(spec.mode.baseUrl, 'ownedLoopback')
                    : null;
                if (declaredEndpoint && (
                    declaredEndpoint.host !== host
                    || (
                        spec.mode.port !== undefined
                        && declaredEndpoint.port
                            !== validatePort(spec.mode.port)
                    )
                )) {
                    return fail(
                        'plugin_managed_server_endpoint_invalid',
                        'Managed server base URL must match its selected loopback host and port',
                    );
                }
                const preferredPort = declaredEndpoint?.port
                    ?? (spec.mode.port === undefined
                        ? undefined
                        : validatePort(spec.mode.port));
                const requestedEndpoint = declaredEndpoint
                    ?? (preferredPort === undefined
                        ? null
                        : Object.freeze({
                            host,
                            port: preferredPort,
                            baseUrl: host === '::1'
                                ? `http://[::1]:${preferredPort}`
                                : `http://${host}:${preferredPort}`,
                            hostPolicy: 'ownedLoopback' as const,
                        }));
                if (spec.healthCheck?.kind === 'http') {
                    if (requestedEndpoint) {
                        validateHealthCheckTargets(spec.healthCheck, requestedEndpoint);
                    } else if (spec.healthCheck.target?.kind === 'url') {
                        return fail(
                            'plugin_managed_server_endpoint_denied',
                            'Managed server health checks must target the supervised loopback endpoint',
                        );
                    }
                }
                try {
                    portReservation = await reservePort(
                        host,
                        preferredPort,
                        entry.lifecycle.signal,
                    );
                } catch (error) {
                    assertNotAborted(entry.lifecycle.signal);
                    const collision = error !== null
                        && typeof error === 'object'
                        && 'code' in error
                        && error.code === 'EADDRINUSE';
                    if (
                        preferredPort === undefined
                        || spec.mode.onPortCollision !== 'fallback'
                        || !collision
                    ) {
                        return fail(
                            'plugin_managed_server_port_unavailable',
                            'The selected managed server port is unavailable',
                        );
                    }
                    portReservation = await reservePort(
                        host,
                        undefined,
                        entry.lifecycle.signal,
                    );
                }
                assertGenerationUsable();
                assertNotAborted(entry.lifecycle.signal);
                if (portReservation.host !== host) {
                    return fail(
                        'plugin_managed_server_port_unavailable',
                        'The selected managed server port belongs to another loopback host',
                    );
                }
                const port = validatePort(portReservation.port);
                endpoint = Object.freeze({
                    host,
                    port,
                    baseUrl: declaredEndpoint
                        && declaredEndpoint.port === port
                        ? declaredEndpoint.baseUrl
                        : host === '::1'
                            ? `http://[::1]:${port}`
                            : `http://${host}:${port}`,
                    hostPolicy: 'ownedLoopback' as const,
                });
                setSnapshot({
                    ...snapshot,
                    baseUrl: endpoint.baseUrl,
                    port: endpoint.port,
                });
                if (spec.healthCheck?.kind === 'http') {
                    validateHealthCheckTargets(spec.healthCheck, endpoint);
                }
            }
            const request = scope.kind === 'project' ? null : launchRequest(spec, endpoint);
            if (custodyOwner === 'sessionRunner') {
                if (scope.kind === 'project' || !request || !scope.sessionId || !params.authorizeRunnerSupervision) {
                    return fail(
                        'plugin_managed_server_authorization_unavailable',
                        'Runner-owned managed server launch authorization is unavailable',
                    );
                }
                const authorization = await params.authorizeRunnerSupervision({
                    mode: 'managedSpawn',
                    sessionId: scope.sessionId,
                    pluginId: scope.pluginId,
                    contributionId: scope.contributionId,
                    ...(scope.operationId
                        ? { operationClaimId: scope.operationId }
                        : {}),
                    serverId: spec.id,
                    occurrenceId: scope.occurrenceId,
                    executable: request.executable,
                    environmentKeys: Object.freeze(Object.keys(request.env ?? {}).sort()),
                    signal: entry.lifecycle.signal,
                });
                if (authorization.mode !== 'managedSpawn') {
                    return fail(
                        'plugin_managed_server_authorization_unavailable',
                        'Runner-owned managed server launch authorization is unavailable',
                    );
                }
                if (authorization.launch.kind === 'daemonResolved') {
                    supervisionLaunch = authorization.launch.value;
                } else {
                    if (
                        request.executable.kind
                            !== 'packaged-runtime-binary'
                    ) {
                        return fail(
                            'plugin_managed_server_executable_unavailable',
                            'Runner packaged-runtime authorization does not match the requested executable',
                        );
                    }
                    if (!params.resolveRunnerPackagedRuntimeExecutable) {
                        return fail(
                            'plugin_managed_server_executable_unavailable',
                            'Exact runner packaged runtime resolution is unavailable',
                        );
                    }
                    const command = await params
                        .resolveRunnerPackagedRuntimeExecutable(
                            request.executable,
                        );
                    if (!command || !isAbsolute(command)) {
                        return fail(
                            'plugin_managed_server_executable_unavailable',
                            'Runner packaged runtime is unavailable',
                        );
                    }
                    supervisionLaunch = Object.freeze({
                        command,
                        args: Object.freeze([]),
                        env: Object.freeze({ PATH: '' }),
                    });
                }
                assertGenerationUsable();
                assertNotAborted(entry.lifecycle.signal);
            }
            const spawnAuthorized = async (
                launch: PluginExecSpawnRequest | null,
            ): Promise<PluginProcessHandle> => {
                if (scope.kind === 'project') {
                    if (!spec.authorizeLaunch) {
                        return fail('plugin_managed_service_unavailable', 'Project launch admission is unavailable');
                    }
                    const authorized = await spec.authorizeLaunch({ endpoint, signal: entry.lifecycle.signal });
                    try {
                        assertGenerationUsable();
                        assertNotAborted(entry.lifecycle.signal);
                    } catch (error) {
                        await authorized.release();
                        throw error;
                    }
                    return spawnAuthorizedHostExecLaunchForHost(authorized, {
                        signal: entry.lifecycle.signal,
                        retainLaunch,
                        ...(managedProcessCustody ? { processCustody: managedProcessCustody } : {}),
                    }).handle;
                }
                if (!launch) {
                    return fail('plugin_managed_service_unavailable', 'Managed launch admission is unavailable');
                }
                const authorizedLaunchRequest = supervisionLaunch
                    && params.transformRunnerManagedSpawnEnvironment
                    ? Object.freeze({
                        ...launch,
                        env: params.transformRunnerManagedSpawnEnvironment(
                            Object.freeze({ ...(launch.env ?? {}) }),
                        ),
                    })
                    : launch;
                const preauthorization = supervisionLaunch
                    ? (params.installPreauthorizedSpawn
                        ?? installPreauthorizedPluginExecSpawnForHost)(
                        scope.exec,
                        authorizedLaunchRequest,
                        supervisionLaunch,
                    )
                    : null;
                const custodyInstall = managedProcessCustody || scope.independentInvocation
                    ? installManagedProcessCustodyForHost(
                        scope.exec,
                        authorizedLaunchRequest,
                        managedProcessCustody,
                        scope.independentInvocation ? {
                            signal: entry.lifecycle.signal,
                            isOccurrenceCurrent: scope.isOccurrenceCurrent,
                            ...(scope.resolveManagedExecutable ? {
                                resolveManagedExecutable: scope.resolveManagedExecutable,
                            } : {}),
                        } : undefined,
                    )
                    : null;
                try {
                    return await scope.exec.spawn(
                        authorizedLaunchRequest,
                        { signal: entry.lifecycle.signal },
                    );
                } finally {
                    preauthorization?.dispose();
                    custodyInstall?.dispose();
                }
            };
            assertGenerationUsable();
            assertNotAborted(entry.lifecycle.signal);
            await releasePortReservation();
            assertGenerationUsable();
            assertNotAborted(entry.lifecycle.signal);
            process = await spawnAuthorized(request);
            // Custody begins at spawn return. Start terminal observation before
            // any later log, projection, endpoint, or health setup can fail.
            observeSpawnedProcessTerminal();
            let custodyFacts: SupervisedPluginProcessCustody | null = null;
            if (managedProcessCustody) {
                // The helper writes the handshake only after the target was
                // assigned to the occurrenceId-unique job and resumed, so these
                // facts are the custody-established fact. Without them the
                // establishment fails before any projection or use.
                custodyFacts = await waitForSupervisedPluginProcessCustody({
                    custody: managedProcessCustody,
                    signal: entry.lifecycle.signal,
                    timeoutMs: 5_000,
                });
                if (!custodyFacts) {
                    return fail(
                        'plugin_managed_server_custody_failed',
                        'Managed server job custody could not be established',
                    );
                }
            }
            const processId = custodyFacts
                ? custodyFacts.targetPid
                : readSupervisedPluginProcessIdForHost(process);
            if (entry.lifecycle.signal.aborted) {
                return fail('plugin_managed_server_aborted', 'Managed server operation was aborted');
            }
            if (spec.mode.endpointDetection && !spec.mode.endpointNone) {
                if (processId === null) {
                    return fail(
                        'plugin_managed_server_endpoint_unavailable',
                        'Managed server endpoint detection requires an observable process id',
                    );
                }
                const managedPid = processId;
                const deadlineController = new AbortController();
                const disarmDeadline = spec.startupTimeoutMs === undefined ? undefined
                    : armDeadlineTimer(Date.now() + spec.startupTimeoutMs, () => deadlineController.abort());
                const signal = AbortSignal.any([
                    entry.lifecycle.signal, lifecycleProbeController.signal, deadlineController.signal,
                ]);
                try {
                    for (;;) {
                        assertNotAborted(entry.lifecycle.signal);
                        assertProcessRunning();
                        assertGenerationUsable();
                        if (await observeOwnedTreeEndpoint(managedPid, signal)) break;
                        await delay(25, signal);
                    }
                } catch (error) {
                    assertNotAborted(entry.lifecycle.signal);
                    assertProcessRunning();
                    if (!deadlineController.signal.aborted) throw error;
                } finally {
                    disarmDeadline?.();
                }
                if (!endpoint) {
                    return fail(
                        'plugin_managed_server_endpoint_unavailable',
                        'Managed server owned-tree endpoint was unavailable or ambiguous',
                    );
                }
                if (spec.healthCheck?.kind === 'http') {
                    validateHealthCheckTargets(spec.healthCheck, endpoint);
                }
            }
            setSnapshot({ ...snapshot, pid: processId });
            if (params.durability) {
                try {
                    const pid = processId;
                    if (custodyFacts) {
                        // Windows job custody IS the process identity: the
                        // projection persists the occurrenceId-unique job name,
                        // and recovery acts on the job. A pid-birth comparison
                        // could never be as exact as the containment itself.
                        processStartIdentity = formatWindowsJobCustodyStartIdentity(
                            custodyFacts.jobName,
                        );
                    } else {
                        processStartIdentity = pid === null || !params.captureProcessStartIdentity
                            ? null
                            : await params.captureProcessStartIdentity(pid);
                    }
                    if (pid === null || !processStartIdentity) {
                        fail(
                            'plugin_managed_server_custody_failed',
                            'Managed server process identity could not be captured safely',
                        );
                    }
                    if (spec.durableLog?.enabled) {
                        durableLog = await params.durability.openLog({
                            instanceId,
                            serverId: spec.id,
                            keepCount: spec.durableLog.keepCount,
                            secretValues: durableLogSecretValues(spec),
                            nowMs: snapshot.startedAtMs ?? now(),
                        });
                        outputSubscription = process.onOutput((chunk) => {
                            durableLog?.write(chunk.stream, chunk.data);
                        });
                    }
                } catch (error) {
                    if (
                        isPluginError(error)
                        && error.code === 'plugin_managed_server_custody_failed'
                    ) {
                        throw error;
                    }
                    fail(
                        'plugin_managed_server_custody_failed',
                        'Managed server custody could not be established',
                    );
                }
            }
        } else if (custodyOwner === 'sessionRunner') {
            if (scope.kind === 'project' || !scope.sessionId || !params.authorizeRunnerSupervision) {
                return fail(
                    'plugin_managed_server_authorization_unavailable',
                    'Runner-owned managed server attach authorization is unavailable',
                );
            }
            const authorization = await params.authorizeRunnerSupervision({
                mode: 'externalAttach',
                sessionId: scope.sessionId,
                pluginId: scope.pluginId,
                contributionId: scope.contributionId,
                ...(scope.operationId
                    ? { operationClaimId: scope.operationId }
                    : {}),
                serverId: spec.id,
                occurrenceId: scope.occurrenceId,
                signal: entry.lifecycle.signal,
            });
            if (authorization.mode !== 'externalAttach') {
                return fail(
                    'plugin_managed_server_authorization_unavailable',
                    'Runner-owned managed server attach authorization is unavailable',
                );
            }
        }

        const handle: ManagedServiceProcessHandle = Object.freeze({
            snapshot: () => snapshot,
            observe(listener: (snapshot: ManagedServiceProcessSnapshot) => void) {
                snapshotListeners.add(listener);
                try {
                    listener(snapshot);
                } catch {
                    snapshotListeners.delete(listener);
                    retainObserverFailure();
                    notifySnapshotListeners(false);
                }
                return Object.freeze({
                    dispose() {
                        snapshotListeners.delete(listener);
                    },
                });
            },
            async waitUntilHealthy(options?: { timeoutMs?: number; signal?: AbortSignal }) {
                if ((spec.mode.kind === 'managedSpawn' && spec.mode.endpointNone && !spec.healthCheck)
                    || (spec.mode.kind === 'native' && snapshot.readiness === 'not_reported')) {
                    return fail('plugin_managed_service_unavailable', 'Service has no reported readiness capability');
                }
                const timeoutMs = options?.timeoutMs;
                if (timeoutMs !== undefined && (
                    !Number.isSafeInteger(timeoutMs)
                    || timeoutMs
                        < MANAGED_SERVICE_NUMERIC_CONTRACT
                            .startupTimeoutMs.minimum
                )) {
                    return fail(
                        'plugin_managed_server_timeout_invalid',
                        'Managed server health deadline must be a positive safe integer',
                    );
                }
                const deadline = timeoutMs === undefined ? undefined : now() + timeoutMs;
                const deadlineController = new AbortController();
                const disarmDeadline = timeoutMs === undefined ? undefined
                    : armDeadlineTimer(Date.now() + timeoutMs, () => deadlineController.abort());
                const signal = AbortSignal.any([
                    ...(options?.signal ? [options.signal] : []),
                    entry.lifecycle.signal, lifecycleProbeController.signal, deadlineController.signal,
                ]);
                const assertWaitUsable = (): void => {
                    assertNotAborted(options?.signal);
                    assertGenerationUsable();
                    if (isStopping() || isStopped()) {
                        return fail('plugin_managed_server_stopped', 'Managed server handle is stopped');
                    }
                    assertProcessRunning();
                };
                try {
                    while (deadline === undefined || now() <= deadline) {
                        assertWaitUsable();
                        if (deadlineController.signal.aborted) break;
                        let healthy = false;
                        const remainingMs = deadline === undefined ? undefined : Math.max(1, deadline - now());
                        try {
                            healthy = await waitWithAbort(checkHealth(
                                signal,
                                remainingMs === undefined ? undefined : spec.healthCheck
                                    ? Math.min(spec.healthCheck.timeoutMs, remainingMs)
                                    : remainingMs,
                            ), signal);
                        } catch (error) {
                            assertWaitUsable();
                            if (deadlineController.signal.aborted) break;
                            if (isPluginError(error)) throw error;
                        }
                        assertWaitUsable();
                        if (deadlineController.signal.aborted) break;
                        if (healthy) {
                            setSnapshot({
                                ...snapshot,
                                state: 'healthy',
                                lastHealthyAtMs: now(),
                            });
                            await publishEndpointProjection();
                            assertWaitUsable();
                            startWatchdog();
                            return snapshot;
                        }
                        if (deadline !== undefined && now() >= deadline) break;
                        await delay(
                            deadline === undefined ? 25 : Math.min(25, Math.max(1, deadline - now())),
                            signal,
                        );
                    }
                } catch (error) {
                    assertWaitUsable();
                    if (!deadlineController.signal.aborted) throw error;
                } finally {
                    disarmDeadline?.();
                }
                setUnhealthy('plugin_managed_server_health_timeout');
                return fail(
                    'plugin_managed_server_health_timeout',
                    'Managed server did not become healthy before its startup timeout',
                );
            },
            async stop(options?: { signal?: AbortSignal }): Promise<ManagedServiceProcessStopResult> {
                assertNotAborted(options?.signal);
                try {
                    await waitWithAbort(cleanup(), options?.signal);
                } catch (error) {
                    if (
                        isPluginError(error)
                        && error.code === 'plugin_managed_service_unavailable'
                        && spec.mode.kind === 'native'
                    ) {
                        return Object.freeze({ status: 'unsupported' });
                    }
                    if (
                        isPluginError(error)
                        && error.code === 'plugin_managed_server_termination_incomplete'
                    ) {
                        return Object.freeze({ status: 'termination_incomplete' });
                    }
                    if (spec.mode.kind === 'native' && !options?.signal?.aborted) {
                        return Object.freeze({ status: 'termination_incomplete' });
                    }
                    throw error;
                }
                return Object.freeze({ status: spec.mode.kind !== 'externalAttach' ? 'stopped' : 'detached' });
            },
            async dispose(): Promise<void> {
                await cleanup();
            },
        });

        if (!spec.healthCheck && spec.mode.kind !== 'native') {
            // The no-health readiness commit fences through the same
            // currentness/stopping/running owners as the probed path: a process
            // that settled terminal while establishment was suspended keeps its
            // unhealthy observation and publishes nothing, instead of being
            // promoted over its own terminal fact.
            if (!isStopping() && !isStopped() && !processTerminal && isGenerationUsable()) {
                setSnapshot({
                    ...snapshot,
                    state: spec.mode.kind === 'managedSpawn' && spec.mode.endpointNone ? 'running' : 'healthy',
                    lastHealthyAtMs: spec.mode.kind === 'managedSpawn' && spec.mode.endpointNone ? null : now(),
                });
                await publishEndpointProjection();
                startWatchdog();
            }
        }
        return handle;
        };
        const cleanupCustody = registerEstablishmentCleanup?.(cleanup, {
            snapshot: () => snapshot,
            hasAcquiredCustody: () => process !== null || retainedLaunchRelease !== null,
        });
        try {
            return await establishHandle();
        } catch (error) {
            try {
                await cleanup();
                cleanupCustody?.release();
            } catch (cleanupError) {
                throw managedServiceCleanupAggregate([
                    { phase: 'establishment', cause: error },
                    { phase: 'establishment', cause: cleanupError },
                ]);
            }
            throw error;
        }
    }

    function bind(scope: ManagedServiceProcessScope): ManagedServiceProcessSupervisor {
        return Object.freeze({
            async supervise(spec: ManagedServiceProcessSpec, options?: {
                signal?: AbortSignal;
                registerEstablishmentCleanup?(
                    cleanup: () => Promise<void>,
                    observation: ManagedServiceEstablishmentCustodyObservation,
                ): Readonly<{ release(): void }>;
            }) {
                if (!scope.isOccurrenceCurrent()) {
                    return fail('plugin_generation_stale', 'Plugin occurrenceId is stale');
                }
                assertNotAborted(options?.signal);
                assertSpecId(spec.id);
                canonicalSpecFacts(spec);
                const entry: ManagedServiceProcessSupervision = {
                    lifecycle: new AbortController(),
                };
                const abort = (): void => entry.lifecycle.abort(
                    options?.signal?.reason,
                );
                options?.signal?.addEventListener('abort', abort, {
                    once: true,
                });
                try {
                    return await establish(
                        spec,
                        entry,
                        scope,
                        options?.registerEstablishmentCleanup,
                    );
                } finally {
                    options?.signal?.removeEventListener('abort', abort);
                }
            },
        });
    }

    return Object.freeze({ custodyOwner, bind });
}
