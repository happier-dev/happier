import { createHash, randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import type { Duplex } from 'node:stream';
import { isPluginError, PluginError, projectActionFailureCauseV1 } from '@happier-dev/plugin-sdk/errors';
import { REMOTE_SHA256_FILE_FUNCTION, safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { selectRequiredAgentLaunchFiles } from '@/daemon/agentIsolation/requiredLaunchFiles';
import { relativeMaterialPath } from '@/daemon/agentIsolation/agentLaunchFrame';
import { writeManagedChannelFile } from '@/machines/managed/channelFileDelivery';
import type { SessionTargetLaunch } from './sessionTargetRelay';

/** The target publisher consumes the same selected bytes/argv as Unix native
 * isolation. Its Session directory already owns disposal of delivered files. */
export async function prepareSessionTargetLaunchFiles(input: Readonly<{
    launch: SessionTargetLaunch | undefined;
    request: Readonly<{ args: readonly string[]; requiredFiles?: readonly string[]; env?: NodeJS.ProcessEnv; signal?: AbortSignal }>;
    exec(command: string): Promise<Readonly<{ status: number }>>;
    openChannel(argv: readonly string[]): Duplex;
}>): Promise<Readonly<{ args: readonly string[]; environment?: Readonly<Record<string, string>> }>> {
    if (!input.request.requiredFiles?.length) return { args: input.request.args };
    // Old issued placements already name the same Session directory through its live lock.
    const runtimeHome = input.launch?.runtimeHome ?? (input.launch?.lockPath ? posix.dirname(input.launch.lockPath) : undefined);
    if (!runtimeHome) throw new PluginError({ code: 'agent_cli_target_unavailable', retryable: false,
        message: 'The Session target has no delivered-file directory' });
    const signal = input.request.signal ?? new AbortController().signal;
    const selected = await selectRequiredAgentLaunchFiles({ runtimeHome, args: input.request.args,
        environment: Object.fromEntries(Object.entries(input.request.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
        nativeEnvironment: input.launch?.env, selectedMaterials: [], requiredFiles: input.request.requiredFiles, signal,
        targetPathStyle: 'posix', requiredFilesDirectory: posix.join(runtimeHome, 'files', 'required', randomBytes(12).toString('hex')) });
    const q = safeBashSingleQuote;
    const run = async (command: string) => {
        signal.throwIfAborted();
        const result = await input.exec(command);
        signal.throwIfAborted();
        if (result.status !== 0) throw new PluginError({ code: 'agent_launch_required_file_unavailable', retryable: false,
            message: 'Required Agent configuration could not be published in the Session target',
            details: { phase: 'materialization', reason: 'publication_failed', exitCode: result.status } });
    };
    try {
        for (const file of selected.selectedMaterials) {
            if (!relativeMaterialPath.safeParse(file.relativePath).success) {
                throw new PluginError({ code: 'agent_launch_required_file_unavailable', retryable: false,
                    message: 'Required Agent configuration has an invalid target path',
                    details: { phase: 'materialization', reason: 'publication_failed' } });
            }
            const path = posix.join(runtimeHome, file.relativePath);
            const bytes = Buffer.from(file.contentBase64, 'base64');
            await run(`umask 077; mkdir -p ${q(posix.dirname(path))}`);
            await writeManagedChannelFile({ path, bytes, signal, openChannel: input.openChannel });
            // As in managed executable delivery, carrier closure is not guest success.
            // Verify at the external publication boundary before an Agent can consume it.
            const digest = createHash('sha256').update(bytes).digest('hex');
            await run(`${REMOTE_SHA256_FILE_FUNCTION}; [ "$(sha256_file ${q(path)})" = ${q(digest)} ] && chmod 600 ${q(path)}`);
        }
    } catch (error) {
        signal.throwIfAborted();
        if (isPluginError(error)) throw error;
        throw new PluginError({ code: 'agent_launch_required_file_unavailable', retryable: false,
            message: 'Required Agent configuration could not be published in the Session target',
            failureCause: projectActionFailureCauseV1(error), details: { phase: 'materialization', reason: 'publication_failed' } });
    }
    return { args: selected.args, environment: selected.environment };
}
