import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ScmCommandRunner } from '@/scm/runtime';
import {
    RunnerDaemonScmCommandV1Schema,
    RunnerDaemonScmCommandResultV1Schema,
    type RunnerDaemonPluginServiceOperationV1,
} from './agentRuntimeDaemonPluginServicesProtocol';
import type { RunnerDaemonPluginServicesDispatchV1 } from './runnerDaemonPluginServices';

/** Uses the incumbent invocation's preparation, cancellation and non-replay rules. */
export function createRunnerDaemonScmCommandRunner(input: Readonly<{
    dispatch: RunnerDaemonPluginServicesDispatchV1;
    requestBase(): Pick<RunnerDaemonPluginServiceOperationV1, 'requestId' | 'invocationId'>;
}>): ScmCommandRunner {
    return async command => {
        const unavailable = { success: false, stdout: '', stderr: 'scm_exec_unavailable', exitCode: -1 };
        // These callers use ordinary stdin, ls-tree file output and cat-file --batch.
        // Interactive stdin and early-settling consumers cannot be carried by this RPC.
        if (command.stdinInteraction || (command.stdoutFilePath && command.stdoutConsumer)) return unavailable;
        let spoolDirectory: string | undefined;
        try {
            if (command.stdoutConsumer) spoolDirectory = await mkdtemp(join(tmpdir(), 'happier-scm-batch-'));
            const output = spoolDirectory ? { kind: 'batch' as const, path: join(spoolDirectory, 'stdout') }
                : command.stdoutFilePath ? { kind: 'file' as const, path: command.stdoutFilePath } : undefined;
            const wireCommand = RunnerDaemonScmCommandV1Schema.parse({
                bin: command.bin, cwd: command.cwd, args: command.args,
                ...(command.stdin !== undefined ? { stdin: command.stdin } : {}),
                ...(command.env ? { env: Object.fromEntries(Object.entries(command.env).map(([key, value]) => [key, value ?? null])) } : {}),
                ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
                ...(command.maxOutputBytes !== undefined ? { maxOutputBytes: command.maxOutputBytes } : {}),
                ...(output ? { output } : {}),
            });
            const result = RunnerDaemonScmCommandResultV1Schema.parse(await input.dispatch({
                kind: 'host_scm.run_v1', ...input.requestBase(), command: wireCommand,
            }, { signal: command.signal, timeoutMs: null }));
            // The daemon owns execution and spool writes; the runner owns the consumer
            // and its binary parser. No output bytes are decoded into JSON text.
            if (result.success && command.stdoutConsumer && output) {
                for await (const chunk of createReadStream(output.path, { signal: command.signal })) {
                    if (command.stdoutConsumer(chunk) !== 'continue') return unavailable;
                }
                return { ...result, stoppedEarly: false };
            }
            return result;
        } catch {
            // Missing/old daemon operations, authority changes and malformed responses
            // never borrow plugin Exec or silently fall back to the runner's OS user.
            return unavailable;
        } finally {
            if (spoolDirectory) await rm(spoolDirectory, { recursive: true, force: true });
        }
    };
}
