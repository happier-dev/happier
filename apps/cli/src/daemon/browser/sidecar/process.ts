import { BrowserSidecarRuntimeStatusV1Schema } from '@happier-dev/protocol/browser/sidecar/v1';
import type { BrowserSidecarRuntimeStatusV1 } from '@happier-dev/protocol';

import { Readable, Writable, type Stream } from 'node:stream';
import type { BrowserSidecarCdpPipe } from './cdpTransport';
import type { SidecarPrivateLaunchPlan } from './runtime';

export type SidecarProcessStderr = Readonly<{
    on(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
    off?(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
    removeListener?(event: 'data', listener: (chunk: string | Uint8Array) => void): unknown;
}>;

export type SidecarSpawnedProcess = Readonly<{
    pid?: number;
    stderr?: SidecarProcessStderr | null;
    stdio?: readonly (Stream | null | undefined)[];
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    once(event: 'error', listener: (error: Error) => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
}>;

export type SpawnSidecarProcess = (executablePath: string, args: readonly string[]) => SidecarSpawnedProcess;

export type SidecarProcessResult =
    | Readonly<{ ok: true; status: BrowserSidecarRuntimeStatusV1 }>
    | Readonly<{ ok: false; status: BrowserSidecarRuntimeStatusV1; error: Error }>;

export type SidecarProcessPipeResult =
    | Readonly<{ ok: true; pipe: BrowserSidecarCdpPipe }>
    | Readonly<{
        ok: false;
        errorCode: 'cdp_unavailable';
        disabledReason: string;
        sandboxUnavailable?: boolean;
    }>;

type ActiveSidecarProcess = Readonly<{
    plan: SidecarPrivateLaunchPlan;
    process: SidecarSpawnedProcess;
    stderrPreview: { value: string };
    pipe: BrowserSidecarCdpPipe | null;
    disposeStderr: () => void;
    settled: Promise<void>;
    resolveSettled: () => void;
}>;

const MAX_STDERR_PREVIEW_CHARS = 64 * 1024;

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

function cdpUnavailable(stderr = ''): SidecarProcessPipeResult {
    return {
        ok: false,
        errorCode: 'cdp_unavailable',
        disabledReason: 'Browser sidecar CDP pipe is unavailable.',
        ...(stderr.includes('No usable sandbox!') ? { sandboxUnavailable: true } : {}),
    };
}

function appendStderrPreview(current: string, chunk: string | Uint8Array): string {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    const next = `${current}${text}`;
    return next.length > MAX_STDERR_PREVIEW_CHARS
        ? next.slice(next.length - MAX_STDERR_PREVIEW_CHARS)
        : next;
}

function createActiveSidecarProcess(
    plan: SidecarPrivateLaunchPlan,
    process: SidecarSpawnedProcess,
): ActiveSidecarProcess {
    const stderrPreview: ActiveSidecarProcess['stderrPreview'] = { value: '' };
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const stderr = process.stderr ?? null;
    const listener = (chunk: string | Uint8Array): void => {
        stderrPreview.value = appendStderrPreview(stderrPreview.value, chunk);
    };
    const disposeStderr = (): void => {
        stderr?.off?.('data', listener);
        stderr?.removeListener?.('data', listener);
    };
    const activeProcess: ActiveSidecarProcess = {
        plan,
        process,
        stderrPreview,
        pipe: process.stdio?.[3] instanceof Writable && process.stdio?.[4] instanceof Readable
            ? { writable: process.stdio[3], readable: process.stdio[4] } : null,
        disposeStderr,
        settled,
        resolveSettled,
    };

    stderr?.on('data', listener);
    return activeProcess;
}

function disposeActiveSidecarProcess(activeProcess: ActiveSidecarProcess): void {
    activeProcess.disposeStderr();
    activeProcess.pipe?.writable.destroy();
    activeProcess.pipe?.readable.destroy();
    activeProcess.resolveSettled();
}

export function createSidecarProcessController(params: Readonly<{
    nowMs: () => number;
    spawnProcess: SpawnSidecarProcess;
}>): SidecarProcessController {
    let active: ActiveSidecarProcess | null = null;
    let status = unavailableStatus(params.nowMs());
    let pipeFailure = cdpUnavailable();

    function setStatus(nextStatus: BrowserSidecarRuntimeStatusV1): BrowserSidecarRuntimeStatusV1 {
        status = nextStatus;
        return status;
    }

    function handleExit(plan: SidecarPrivateLaunchPlan, code: number | null, signal: NodeJS.Signals | null): void {
        const current = active;
        if (current?.plan.sidecarId !== plan.sidecarId) return;
        pipeFailure = cdpUnavailable(current.stderrPreview.value);
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
        // A post-spawn process error (for example a failed signal) does not prove exit.
        if (!current.process.pid) {
            disposeActiveSidecarProcess(current);
            active = null;
        }
        setStatus(statusForPlan(plan, 'crashed', params.nowMs(), 'launch_failed'));
    }

    const controller: SidecarProcessController = {
        launch(plan) {
            if (active) {
                return {
                    ok: false,
                    status,
                    error: new Error('Browser sidecar process is already running.'),
                };
            }

            try {
                pipeFailure = cdpUnavailable();
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
            setStatus(statusForPlan(current.plan, 'stopping', params.nowMs()));
            try {
                if (!current.process.kill('SIGTERM')) {
                    return { ok: false, status, error: new Error('Browser sidecar process could not be stopped.') };
                }
            } catch (error) {
                return { ok: false, status, error: error instanceof Error ? error : new Error(String(error)) };
            }
            return {
                ok: true,
                status,
            };
        },
        async stopAndWait() {
            const current = active;
            const stopped = controller.stop();
            if (!stopped.ok) throw stopped.error;
            await current?.settled;
        },
        getStatus() {
            return status;
        },
        getPid: () => active?.process.pid ?? null,
        getCdpPipe(input) {
            const current = active;
            if (!current || current.plan.sidecarId !== input.sidecarId) return pipeFailure;
            return current.pipe
                ? { ok: true, pipe: current.pipe }
                : cdpUnavailable(current.stderrPreview.value);
        },
    };
    return controller;
}

export type SidecarProcessController = Readonly<{
    launch: (plan: SidecarPrivateLaunchPlan) => SidecarProcessResult;
    stop: () => SidecarProcessResult;
    stopAndWait: () => Promise<void>;
    getStatus: () => BrowserSidecarRuntimeStatusV1;
    /** Private actual-child fact; it remains retained until the exit is observed. */
    getPid?: () => number | null;
    getCdpPipe: (input: Readonly<{ sidecarId: string }>) => SidecarProcessPipeResult;
}>;
