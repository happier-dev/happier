import {
    BrowserSidecarRuntimeStatusV1Schema,
    type BrowserSidecarRuntimeStatusV1,
} from '@happier-dev/protocol';

import {
    discoverBrowserSidecarCdpEndpoint,
    type BrowserSidecarCdpEndpointSource,
} from './cdpEndpoint';
import type { SidecarPrivateLaunchPlan } from './runtime';

export type SidecarProcessStderr = Readonly<{
    on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
    off?(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
    removeListener?(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
}>;

export type SidecarSpawnedProcess = Readonly<{
    pid?: number;
    stderr?: SidecarProcessStderr | null;
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    once(event: 'error', listener: (error: Error) => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
}>;

export type SpawnSidecarProcess = (executablePath: string, args: readonly string[]) => SidecarSpawnedProcess;

export type SidecarProcessResult =
    | Readonly<{ ok: true; status: BrowserSidecarRuntimeStatusV1 }>
    | Readonly<{ ok: false; status: BrowserSidecarRuntimeStatusV1; error: Error }>;

export type SidecarProcessEndpointSourceResult =
    | Readonly<{ ok: true; endpointSource: BrowserSidecarCdpEndpointSource }>
    | Readonly<{
        ok: false;
        errorCode: 'cdp_unavailable';
        disabledReason: string;
    }>;

type EndpointWaiter = Readonly<{
    sidecarId: string;
    timeout: NodeJS.Timeout;
    resolve: (result: SidecarProcessEndpointSourceResult) => void;
}>;

type ActiveSidecarProcess = Readonly<{
    plan: SidecarPrivateLaunchPlan;
    process: SidecarSpawnedProcess;
    stderrPreview: { value: string };
    endpointWaiters: Set<EndpointWaiter>;
    disposeStderr: () => void;
}>;

const MAX_STDERR_PREVIEW_CHARS = 64 * 1024;
const DEFAULT_ENDPOINT_TIMEOUT_MS = 5_000;

function statusForPlan(
    plan: SidecarPrivateLaunchPlan,
    state: BrowserSidecarRuntimeStatusV1['state'],
    updatedAtMs: number,
    errorCode?: BrowserSidecarRuntimeStatusV1['errorCode'],
): BrowserSidecarRuntimeStatusV1 {
    return BrowserSidecarRuntimeStatusV1Schema.parse({
        v: 1,
        sidecarId: plan.sidecarId,
        state,
        source: plan.source,
        profileId: plan.profileId,
        boundViewIds: [],
        ...(errorCode ? { errorCode } : {}),
        updatedAtMs,
    });
}

function unavailableStatus(updatedAtMs: number): BrowserSidecarRuntimeStatusV1 {
    return BrowserSidecarRuntimeStatusV1Schema.parse({
        v: 1,
        sidecarId: 'unbound',
        state: 'unavailable',
        source: 'unsupported',
        boundViewIds: [],
        errorCode: 'launch_failed',
        updatedAtMs,
    });
}

function cdpUnavailable(): SidecarProcessEndpointSourceResult {
    return {
        ok: false,
        errorCode: 'cdp_unavailable',
        disabledReason: 'Browser sidecar CDP endpoint is unavailable.',
    };
}

function normalizeEndpointTimeoutMs(input: number | undefined): number {
    return typeof input === 'number' && Number.isFinite(input) && input > 0
        ? Math.trunc(input)
        : DEFAULT_ENDPOINT_TIMEOUT_MS;
}

function appendStderrPreview(current: string, chunk: string | Uint8Array): string {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const next = `${current}${text}`;
    return next.length > MAX_STDERR_PREVIEW_CHARS
        ? next.slice(next.length - MAX_STDERR_PREVIEW_CHARS)
        : next;
}

function endpointSourceForPreview(preview: string): BrowserSidecarCdpEndpointSource | null {
    const endpointSource = {
        kind: 'devtoolsStderr',
        stderr: preview,
    } as const satisfies BrowserSidecarCdpEndpointSource;
    return discoverBrowserSidecarCdpEndpoint(endpointSource).ok ? endpointSource : null;
}

function resolveEndpointWaiter(
    activeProcess: ActiveSidecarProcess,
    waiter: EndpointWaiter,
    result: SidecarProcessEndpointSourceResult,
): void {
    if (!activeProcess.endpointWaiters.delete(waiter)) return;
    clearTimeout(waiter.timeout);
    waiter.resolve(result);
}

function resolveEndpointWaiters(activeProcess: ActiveSidecarProcess, result: SidecarProcessEndpointSourceResult): void {
    for (const waiter of [...activeProcess.endpointWaiters]) {
        resolveEndpointWaiter(activeProcess, waiter, result);
    }
}

function notifyEndpointWaiters(activeProcess: ActiveSidecarProcess): void {
    const endpointSource = endpointSourceForPreview(activeProcess.stderrPreview.value);
    if (!endpointSource) return;
    resolveEndpointWaiters(activeProcess, {
        ok: true,
        endpointSource,
    });
}

function createActiveSidecarProcess(
    plan: SidecarPrivateLaunchPlan,
    process: SidecarSpawnedProcess,
): ActiveSidecarProcess {
    const stderrPreview = { value: '' };
    const endpointWaiters = new Set<EndpointWaiter>();
    const stderr = process.stderr ?? null;
    const listener = (chunk: string | Uint8Array): void => {
        stderrPreview.value = appendStderrPreview(stderrPreview.value, chunk);
        notifyEndpointWaiters(activeProcess);
    };
    const disposeStderr = (): void => {
        stderr?.off?.('data', listener);
        stderr?.removeListener?.('data', listener);
    };
    const activeProcess: ActiveSidecarProcess = {
        plan,
        process,
        stderrPreview,
        endpointWaiters,
        disposeStderr,
    };

    stderr?.on('data', listener);
    return activeProcess;
}

function disposeActiveSidecarProcess(activeProcess: ActiveSidecarProcess): void {
    activeProcess.disposeStderr();
    resolveEndpointWaiters(activeProcess, cdpUnavailable());
}

export function createSidecarProcessController(params: Readonly<{
    nowMs: () => number;
    spawnProcess: SpawnSidecarProcess;
}>): SidecarProcessController {
    let active: ActiveSidecarProcess | null = null;
    let status = unavailableStatus(params.nowMs());

    function setStatus(nextStatus: BrowserSidecarRuntimeStatusV1): BrowserSidecarRuntimeStatusV1 {
        status = nextStatus;
        return status;
    }

    function handleExit(plan: SidecarPrivateLaunchPlan, code: number | null, signal: NodeJS.Signals | null): void {
        const current = active;
        if (current?.plan.sidecarId !== plan.sidecarId) return;
        disposeActiveSidecarProcess(current);
        active = null;
        const expectedStop = status.state === 'stopping' && (code === 0 || signal === 'SIGTERM');
        setStatus(statusForPlan(
            plan,
            expectedStop ? 'ready' : 'crashed',
            params.nowMs(),
            expectedStop ? undefined : 'process_crashed',
        ));
    }

    function handleError(plan: SidecarPrivateLaunchPlan): void {
        const current = active;
        if (current?.plan.sidecarId !== plan.sidecarId) return;
        disposeActiveSidecarProcess(current);
        active = null;
        setStatus(statusForPlan(plan, 'crashed', params.nowMs(), 'launch_failed'));
    }

    return {
        launch(plan) {
            if (active) {
                return {
                    ok: false,
                    status,
                    error: new Error('Browser sidecar process is already running.'),
                };
            }

            try {
                const spawnedProcess = params.spawnProcess(plan.executablePath, plan.args);
                active = createActiveSidecarProcess(plan, spawnedProcess);
                spawnedProcess.once('exit', (code, signal) => handleExit(plan, code, signal));
                spawnedProcess.once('error', () => handleError(plan));
                return {
                    ok: true,
                    status: setStatus(statusForPlan(plan, 'running', params.nowMs())),
                };
            } catch (error) {
                const normalizedError = error instanceof Error ? error : new Error(String(error));
                return {
                    ok: false,
                    status: setStatus(statusForPlan(plan, 'crashed', params.nowMs(), 'launch_failed')),
                    error: normalizedError,
                };
            }
        },
        stop() {
            if (!active) {
                return {
                    ok: true,
                    status,
                };
            }

            const current = active;
            current.process.kill('SIGTERM');
            return {
                ok: true,
                status: setStatus(statusForPlan(current.plan, 'stopping', params.nowMs())),
            };
        },
        getStatus() {
            return status;
        },
        async waitForDevToolsEndpointSource(input) {
            const current = active;
            if (!current || current.plan.sidecarId !== input.sidecarId) {
                return cdpUnavailable();
            }

            const endpointSource = endpointSourceForPreview(current.stderrPreview.value);
            if (endpointSource) {
                return {
                    ok: true,
                    endpointSource,
                };
            }

            return await new Promise<SidecarProcessEndpointSourceResult>((resolve) => {
                const waiter: EndpointWaiter = {
                    sidecarId: input.sidecarId,
                    resolve,
                    timeout: setTimeout(() => {
                        resolveEndpointWaiter(current, waiter, cdpUnavailable());
                    }, normalizeEndpointTimeoutMs(input.timeoutMs)),
                };
                current.endpointWaiters.add(waiter);
            });
        },
    };
}

export type SidecarProcessController = Readonly<{
    launch: (plan: SidecarPrivateLaunchPlan) => SidecarProcessResult;
    stop: () => SidecarProcessResult;
    getStatus: () => BrowserSidecarRuntimeStatusV1;
    waitForDevToolsEndpointSource: (input: Readonly<{
        sidecarId: string;
        timeoutMs?: number;
    }>) => Promise<SidecarProcessEndpointSourceResult>;
}>;
