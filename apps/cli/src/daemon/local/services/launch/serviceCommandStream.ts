import { createHash } from 'node:crypto';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { spawnAuthorizedHostExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import type { NativeServiceCommandCaptureForHost, ServiceCommandResultV1 } from './serviceCommand';

type Child = ReturnType<typeof spawnAuthorizedHostExecLaunchForHost>;

/** One raw pipe beneath the existing command owner and process supervisor.
 * Stdout EOF alone never gives the consumer permission to commit a snapshot. */
export async function executeServiceCommandStream(input: Readonly<{
    producer: NativeServiceCommandCaptureForHost; consumer: NativeServiceCommandCaptureForHost;
}>): Promise<ServiceCommandResultV1> {
    const captures = [input.consumer, input.producer];
    const signals = captures.flatMap(capture => [capture.signal, capture.context.operation.signal].filter(
        (signal): signal is AbortSignal => signal !== undefined));
    const signal = AbortSignal.any(signals);
    const launches: HostAuthorizedPluginExecLaunch[] = [];
    const children: Child[] = [];
    const releases: HostAuthorizedPluginExecLaunch['release'][] = [];
    let producerSettled = false;
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
        // Consumer first, with stdin still open. Native helper stop must finish
        // before terminating its Docker client can close the transport.
        for (const [index, child] of children.entries()) {
            await captures[index]!.stopNative?.();
            await child.dispose();
            await child.waitForSettlement();
        }
    })();
    let rejectCancellation!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const onAbort = () => {
        rejectCancellation(signal.reason);
        void stop().catch(() => {}); // The effect's terminal path joins this same cleanup.
    };
    try {
        signal.throwIfAborted();
        // Validate and acquire BOTH captures before either child starts.
        for (const capture of captures) {
            await capture.assertCurrent();
            const launch = await capture.launch();
            launches.push(launch);
            releases.push(launch.release);
            await launch.recheckInputs?.();
            await capture.assertCurrent();
            signal.throwIfAborted();
            if (!launch.secretRedactionLease?.isActive()) throw new PluginError({
                code: 'secret_redaction_unavailable', message: 'Service stream redaction is unavailable' });
        }
        for (const [index, launch] of launches.entries()) children.push(spawnAuthorizedHostExecLaunchForHost(launch, {
            ...(index === 1 ? { pipeStdout: true } : {}), retainLaunch(release) { releases[index] = release; },
        }));
        const [consumer, producer] = children as [Child, Child];
        // The supervisor has no diagnostic subscription to raw stdout in this
        // mode. Each awaited write provides OS-stream backpressure.
        const checksum = createHash('sha256');
        let bytes = 0;
        const transfer = (async () => {
            for await (const chunk of producer.child.stdout) {
                signal.throwIfAborted();
                const data: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                await consumer.handle.write(data);
                checksum.update(data);
                bytes += data.byteLength;
            }
        })();
        const consumerExit = consumer.handle.wait();
        const prematureExit = consumerExit.then(() => { throw new Error('Service stream consumer exited before producer success'); });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        const [, produced] = await Promise.race([Promise.all([transfer, producer.handle.wait()]), prematureExit, cancelled]);
        if (produced.termination.requestedBy.kind !== 'none' || produced.termination.observed.kind !== 'exit') {
            throw new Error('Service stream producer did not settle');
        }
        await producer.dispose();
        await producer.waitForSettlement();
        producerSettled = true;
        if (produced.termination.observed.exitCode !== 0) throw new Error('Service stream producer did not succeed');
        signal.throwIfAborted();
        await consumer.handle.closeStdin();
        const consumed = await Promise.race([consumerExit, cancelled]);
        if (consumed.termination.requestedBy.kind !== 'none' || consumed.termination.observed.kind !== 'exit'
            || consumed.termination.observed.exitCode !== 0) throw new Error('Service stream consumer did not succeed');
        await consumer.dispose();
        await consumer.waitForSettlement();
        for (const launch of launches) await launch.retireDeploymentRuntimeFiles?.();
        for (const release of releases) await release();
        return { kind: 'completed', exitCode: consumed.termination.observed.exitCode,
            stdout: Buffer.from(consumed.stdout).toString('utf8'), stderr: Buffer.from(consumed.stderr).toString('utf8'),
            stdoutTruncated: consumed.stdoutTruncated, stderrTruncated: consumed.stderrTruncated,
            producer: { exitCode: 0, bytes, checksumSha256: checksum.digest('hex'),
                stderr: Buffer.from(produced.stderr).toString('utf8'), stderrTruncated: produced.stderrTruncated } };
    } catch (error) {
        if (!children.length) {
            for (const release of releases) await release();
            throw error;
        }
        try {
            await stop();
            for (const launch of launches) await launch.retireDeploymentRuntimeFiles?.();
        } catch { /* Native custody remains unknown; do not release or pretend EOF succeeded. */ }
        for (const [index, release] of releases.entries()) {
            // A reported native exit (including nonzero) already settled the
            // producer, just as for a finite command. Retaining it as unknown
            // would make the consumer's later native proof unreconcilable.
            if (index === 1 && producerSettled) {
                try { await release(); continue; } catch { /* Retain failed release below. */ }
            }
            const observeNativeSettlement = captures[index]!.observeNativeSettlement;
            machineNativeEffectAdmission.markUnsettled(input.producer.context, { releaseAfterNativeSettlement: release,
                ...(observeNativeSettlement ? { observeNativeSettlement } : {}) });
        }
        return { kind: 'outcome_unknown' };
    } finally { signal.removeEventListener('abort', onAbort); }
}
