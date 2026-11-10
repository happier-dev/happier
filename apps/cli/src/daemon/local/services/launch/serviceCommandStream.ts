import { createHash } from 'node:crypto';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';
import { spawnAuthorizedHostExecLaunchForHost, type HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import { machineNativeEffectAdmission } from './machineNativeEffectAdmission';
import type { NativeServiceCommandCaptureForHost, ServiceCommandResultV1 } from './serviceCommand';
import { assertServiceOutputRedactionForHost } from './serviceOutputRedaction';

type Child = ReturnType<typeof spawnAuthorizedHostExecLaunchForHost>;
type ChildOutcome = Awaited<ReturnType<Child['handle']['wait']>>;

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
    let producerOutcome: ChildOutcome | undefined;
    let consumerOutcome: ChildOutcome | undefined;
    const checksum = createHash('sha256');
    let bytes = 0;
    const naturalExit = (outcome: ChildOutcome | undefined) => outcome?.termination.requestedBy.kind === 'none'
        && outcome.termination.observed.kind === 'exit';
    const result = (exitCode: number, diagnostic: ChildOutcome): ServiceCommandResultV1 => {
        if (!producerOutcome || producerOutcome.termination.observed.kind !== 'exit' || !consumerOutcome) return { kind: 'outcome_unknown' };
        return { kind: 'completed', exitCode,
            stdout: Buffer.from(consumerOutcome.stdout).toString('utf8'), stderr: Buffer.from(diagnostic.stderr).toString('utf8'),
            stdoutTruncated: consumerOutcome.stdoutTruncated, stderrTruncated: diagnostic.stderrTruncated,
            producer: { exitCode: producerOutcome.termination.observed.exitCode, bytes, checksumSha256: checksum.copy().digest('hex'),
                stderr: Buffer.from(producerOutcome.stderr).toString('utf8'), stderrTruncated: producerOutcome.stderrTruncated } };
    };
    let producerSettled = false;
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
        // Consumer first, with stdin still open. Native helper stop must finish
        // before terminating its Docker client can close the transport.
        for (const [index, child] of children.entries()) {
            await captures[index]!.stopNative?.();
            await child.dispose();
            await child.waitForSettlement();
            const outcome = await child.handle.wait();
            if (index === 0) consumerOutcome = outcome;
            else producerOutcome = outcome;
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
            assertServiceOutputRedactionForHost(launch);
        }
        for (const [index, launch] of launches.entries()) children.push(spawnAuthorizedHostExecLaunchForHost(launch, {
            ...(index === 1 ? { pipeStdout: true } : {}), retainLaunch(release) { releases[index] = release; },
        }));
        const [consumer, producer] = children as [Child, Child];
        // The supervisor has no diagnostic subscription to raw stdout in this
        // mode. Each awaited write provides OS-stream backpressure.
        const consumerExit = consumer.handle.wait().then(outcome => { consumerOutcome = outcome; return outcome; });
        const transfer = (async () => {
            for await (const chunk of producer.child.stdout) {
                signal.throwIfAborted();
                const data: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                // A custom-archive reader may finish before pipe EOF. Drain the
                // producer anyway: its complete bytes/checksum and exit own success.
                if (!naturalExit(consumerOutcome)) {
                    try { await consumer.handle.write(data); }
                    catch (error) { if (!naturalExit(await consumerExit)) throw error; }
                }
                checksum.update(data);
                bytes += data.byteLength;
            }
        })();
        const producerExit = producer.handle.wait().then(outcome => { producerOutcome = outcome; return outcome; });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        const [, produced] = await Promise.race([Promise.all([transfer, producerExit]), cancelled]);
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
        if (consumed.termination.requestedBy.kind !== 'none' || consumed.termination.observed.kind !== 'exit') {
            throw new Error('Service stream consumer did not settle');
        }
        await consumer.dispose();
        await consumer.waitForSettlement();
        for (const launch of launches) await launch.retireDeploymentRuntimeFiles?.();
        for (const release of releases) await release();
        return result(consumed.termination.observed.exitCode, consumed);
    } catch (error) {
        if (!children.length) {
            for (const release of releases) await release();
            throw error;
        }
        let nativeCleanupSettled = false;
        try {
            await stop();
            for (const launch of launches) await launch.retireDeploymentRuntimeFiles?.();
            nativeCleanupSettled = true;
        } catch (cleanupError) {
            // Native custody remains unknown; preserve its typed cause without
            // releasing it or pretending the consumer received a valid EOF.
            logger.warnLocalFile('[Service command stream] Native cleanup failed', {
                operationId: input.producer.context.operation.operationId,
                failureCause: projectActionFailureCauseV1(cleanupError, 'service.stream.cleanup'),
            });
        }
        // Join cleanup before recording termination, otherwise the producer's
        // observation is lost on an early reader exit. Never log native bytes.
        logger.warnLocalFile('[Service command stream] Native stream failed', {
            operationId: input.producer.context.operation.operationId,
            failureCause: projectActionFailureCauseV1(error, 'service.stream'),
            producerExitCode: producerOutcome?.termination.observed.kind === 'exit' ? producerOutcome.termination.observed.exitCode : null,
            consumerExitCode: consumerOutcome?.termination.observed.kind === 'exit' ? consumerOutcome.termination.observed.exitCode : null,
            producerTerminationKind: producerOutcome?.termination.observed.kind,
            consumerTerminationKind: consumerOutcome?.termination.observed.kind,
        });
        let allReleased = true;
        for (const [index, release] of releases.entries()) {
            // A natural producer exit or the native owner's successful stop,
            // followed by physical child settlement, already proves custody.
            // A naturally exited consumer is the same positive proof. A killed
            // ordinary Docker exec still has no native-stop proof; keep it unknown.
            const outcome = index === 0 ? consumerOutcome : producerOutcome;
            if ((index === 1 && producerSettled) || (nativeCleanupSettled && (naturalExit(outcome) || captures[index]!.stopNative))) {
                try { await release(); continue; } catch (releaseError) {
                    logger.warnLocalFile('[Service command stream] Native release failed', {
                        operationId: input.producer.context.operation.operationId,
                        failureCause: projectActionFailureCauseV1(releaseError, 'service.stream.release'),
                    });
                }
            }
            allReleased = false;
            const observeNativeSettlement = captures[index]!.observeNativeSettlement;
            machineNativeEffectAdmission.markUnsettled(input.producer.context, { releaseAfterNativeSettlement: release,
                ...(observeNativeSettlement ? { observeNativeSettlement } : {}) });
        }
        if (allReleased) {
            const failed = [consumerOutcome, producerOutcome].find(outcome => naturalExit(outcome)
                && outcome?.termination.observed.kind === 'exit' && outcome.termination.observed.exitCode !== 0);
            if (failed?.termination.observed.kind === 'exit') return result(failed.termination.observed.exitCode, failed);
        }
        return { kind: 'outcome_unknown' };
    } finally { signal.removeEventListener('abort', onAbort); }
}
