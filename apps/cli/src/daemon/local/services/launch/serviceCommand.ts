import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createHash } from 'node:crypto';
import type { DeploymentExecEnvPortV1, ExecService } from '@happier-dev/plugin-sdk/exec';
import type { TerminalProcessExitObservation } from '@/terminal/pty/sessions';
import { spawnAuthorizedHostExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import { machineNativeEffectAdmission, type MachineNativeEffectContext } from './machineNativeEffectAdmission';
import { executeServiceCommandStream } from './serviceCommandStream';

export type ServiceCommandV1 = Readonly<{ mode: 'exec' | 'run'; argv: readonly string[] }>;
export type ServiceCommandResultV1 = Readonly<{ kind: 'completed'; exitCode: number; stdout: string; stderr: string;
    stdoutTruncated: boolean; stderrTruncated: boolean;
    stdoutBytes?: number; stdoutChecksumSha256?: string;
    producer?: Readonly<{ exitCode: number; bytes: number; checksumSha256: string; stderr: string; stderrTruncated: boolean }> }>
    | Readonly<{ kind: 'outcome_unknown' }>;
export type ServiceCommandRuntimeForHost = Readonly<{ exec: ExecService; envPort: DeploymentExecEnvPortV1;
    assertCurrent(): Promise<void>; settleNative(): Promise<void> }>;
declare const admittedCommand: unique symbol;
export type AdmittedServiceExecContextV1 = Readonly<{ [admittedCommand]: true }>;

export type NativeServiceCommandCaptureForHost = Readonly<{ context: MachineNativeEffectContext;
    signal?: AbortSignal; assertCurrent(): Promise<void>; launch(): Promise<HostAuthorizedPluginExecLaunch>;
    /** P45's raw read-back/dump output is measured, never diagnostic text. */
    rawStdout?: true;
    /** Native helper termination precedes Docker-client/pipe teardown. */
    stopNative?(): Promise<void>;
    observeNativeSettlement?(signal?: AbortSignal): Promise<boolean> }>;
type CommandCapture = NativeServiceCommandCaptureForHost;
export type ServiceShellObservation<TTerminal> =
    | Readonly<{ kind: 'not_started'; terminal: TTerminal }>
    | Readonly<{ kind: 'client_exit'; terminal: TTerminal; clientExit: TerminalProcessExitObservation }>;

/** The current native owner lends one exact launch inside its existing effect
 * admission. Owner ruling 2026-10-29T16:20Z: observed Docker-client exit settles
 * this shell session, including deliberate detach; it does not certify that
 * the in-container process exited. Unconfirmed local custody remains unknown.
 */
export async function withAdmittedServiceShellForHost<TTerminal>(capture: CommandCapture,
    consume: (launch: HostAuthorizedPluginExecLaunch) => Promise<ServiceShellObservation<TTerminal>>): Promise<ServiceShellObservation<TTerminal>> {
    capture.signal?.throwIfAborted();
    await capture.assertCurrent();
    const launch = await capture.launch();
    let handedOff = false;
    let retained = false;
    try {
        await launch.recheckInputs?.();
        await capture.assertCurrent();
        capture.signal?.throwIfAborted();
        if (!launch.secretRedactionLease?.isActive()) throw new PluginError({ code: 'secret_redaction_unavailable', message: 'Service shell redaction is unavailable' });
        handedOff = true;
        const observed = await consume(Object.freeze({ ...launch, recheckInputs: async () => {
            capture.signal?.throwIfAborted();
            await launch.recheckInputs?.();
            await capture.assertCurrent();
            capture.signal?.throwIfAborted();
        } }));
        if (observed.kind === 'client_exit' && observed.clientExit.kind === 'unavailable') {
            machineNativeEffectAdmission.markUnsettled(capture.context, { releaseAfterNativeSettlement: launch.release });
            retained = true;
        }
        return observed;
    } catch (error) {
        if (handedOff) {
            machineNativeEffectAdmission.markUnsettled(capture.context, { releaseAfterNativeSettlement: launch.release });
            retained = true;
        }
        throw error;
    } finally {
        if (!retained) {
            try { await launch.release(); }
            catch (error) {
                machineNativeEffectAdmission.markUnsettled(capture.context, { releaseAfterNativeSettlement: launch.release });
                throw error;
            }
        }
    }
}
const commands = new WeakMap<AdmittedServiceExecContextV1, CommandCapture | Readonly<{
    producer: CommandCapture; consumer: CommandCapture;
}>>();

/** Docker Compose v2.39.4 exec/run codec. Only the native generation owner supplies the prefix and service. */
export function nativeServiceCommandArgs(prefix: readonly string[], service: string, command: ServiceCommandV1): readonly string[] {
    if (!service || !command.argv.length || command.argv.some(arg => arg.includes('\0'))) {
        throw new PluginError({ code: 'invalid_request', message: 'A literal service command is required' });
    }
    return [...prefix, ...(command.mode === 'exec' ? ['exec', '-T']
        : ['run', '--rm', '-T', '--no-build', '--pull', 'never', '--no-deps']), service, ...command.argv];
}

/** Host-private factory: invoked only by the actual native render/current-generation owner. */
export function admitNativeServiceCommandForHost(capture: CommandCapture): AdmittedServiceExecContextV1 {
    const context = Object.freeze({}) as AdmittedServiceExecContextV1;
    commands.set(context, { ...capture, get signal() {
        // Resolve at execution inside runStage's real async scope, not at
        // capture time: only the protected boundary defers parent Stop.
        const parentSignal = capture.context.operation.signal;
        return parentSignal && capture.signal && parentSignal !== capture.signal
            ? AbortSignal.any([parentSignal, capture.signal]) : parentSignal ?? capture.signal;
    } });
    return context;
}

/** Both already-admitted children belong to the same native parent. */
export function admitServiceCommandStreamForHost(input: Readonly<{
    producer: AdmittedServiceExecContextV1; consumer: AdmittedServiceExecContextV1;
}>): AdmittedServiceExecContextV1 {
    const producer = commands.get(input.producer);
    const consumer = commands.get(input.consumer);
    if (!producer || !consumer || !('context' in producer) || !('context' in consumer)
        || input.producer === input.consumer || producer.context !== consumer.context) {
        throw new PluginError({ code: 'service_admission_unavailable', message: 'Service stream admission is unavailable' });
    }
    const stream = Object.freeze({}) as AdmittedServiceExecContextV1;
    commands.set(stream, { producer, consumer });
    return stream;
}

/** The existing Action operation owns dispatch and replay. */
export function executeAdmittedServiceCommand(context: AdmittedServiceExecContextV1): Promise<ServiceCommandResultV1> {
    const capture = commands.get(context);
    if (!capture) return Promise.reject(new PluginError({ code: 'service_admission_unavailable', message: 'Service command admission is unavailable' }));
    const parent = 'context' in capture ? capture.context : capture.producer.context;
    return machineNativeEffectAdmission.runStage(parent, () => 'context' in capture
        ? execute(capture) : executeServiceCommandStream(capture));
}

async function execute(capture: CommandCapture): Promise<ServiceCommandResultV1> {
    const signal = capture.signal;
    signal?.throwIfAborted();
    await capture.assertCurrent();
    const launch = await capture.launch();
    let release: HostAuthorizedPluginExecLaunch['release'] = launch.release;
    let dispatched = false;
    let process: ReturnType<typeof spawnAuthorizedHostExecLaunchForHost> | undefined;
    let cancelling: Promise<void> | undefined;
    const onAbort = () => {
        cancelling ??= (async () => { await capture.stopNative?.(); await process?.dispose(); })();
        void cancelling.catch(() => {}); // Joined below; failed native stop retains custody.
    };
    const retireHelperFiles = async () => {
        // A closed child seals its result; the incumbent supervisor's disposal
        // settles native subtree custody before helper-file cleanup.
        await cancelling;
        await process?.dispose();
        await process?.waitForSettlement();
        await launch.retireDeploymentRuntimeFiles?.();
    };
    try {
        signal?.throwIfAborted();
        await launch.recheckInputs?.();
        await capture.assertCurrent();
        signal?.throwIfAborted();
        if (!launch.secretRedactionLease?.isActive()) throw new PluginError({ code: 'secret_redaction_unavailable', message: 'Service command redaction is unavailable' });
        process = spawnAuthorizedHostExecLaunchForHost(launch, { ...(!capture.stopNative ? { signal } : {}),
            ...(capture.rawStdout ? { pipeStdout: true } : {}),
            retainLaunch(value) { release = value; } });
        dispatched = true;
        if (capture.stopNative) {
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
        }
        const raw = capture.rawStdout ? (async () => {
            const checksum = createHash('sha256');
            let bytes = 0;
            for await (const chunk of process!.child.stdout) {
                const data: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                checksum.update(data);
                bytes += data.byteLength;
            }
            return { stdoutBytes: bytes, stdoutChecksumSha256: checksum.digest('hex') };
        })() : undefined;
        const [result, measurement] = await Promise.all([process.handle.wait(), raw]);
        await retireHelperFiles();
        // Docker client termination does not prove that an in-container command ended.
        if (result.termination.requestedBy.kind !== 'none' || result.termination.observed.kind !== 'exit') {
            machineNativeEffectAdmission.markUnsettled(capture.context, { releaseAfterNativeSettlement: release,
                ...(capture.observeNativeSettlement ? { observeNativeSettlement: capture.observeNativeSettlement } : {}) });
            return { kind: 'outcome_unknown' };
        }
        const completed = { kind: 'completed' as const, exitCode: result.termination.observed.exitCode,
            stdout: Buffer.from(result.stdout).toString('utf8'), stderr: Buffer.from(result.stderr).toString('utf8'),
            stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, ...measurement };
        await release();
        return completed;
    } catch (error) {
        if (dispatched) {
            try { await retireHelperFiles(); }
            catch {
                // Lost physical settlement or private cleanup retains the same
                // native lease/redactor; it is not successful cancellation.
            }
            machineNativeEffectAdmission.markUnsettled(capture.context, { releaseAfterNativeSettlement: release,
                ...(capture.observeNativeSettlement ? { observeNativeSettlement: capture.observeNativeSettlement } : {}) });
            return { kind: 'outcome_unknown' };
        }
        await release();
        throw error;
    } finally { signal?.removeEventListener('abort', onAbort); }
}
