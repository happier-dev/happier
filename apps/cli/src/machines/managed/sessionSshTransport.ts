import { writeManagedChannelFile } from './channelFileDelivery';
import { openOpenSshRemoteChannel, runOpenSshRemoteCommand, safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import type { ManagedNativeBootstrapIO } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import { SystemTaskExecutionError } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import type { ManagedBootstrapCarrierV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';

/** The admitted carrier, row-scoped trust and credential lease come from their existing owners. */
export function createManagedSshSessionTransport(input: Readonly<{
    carrier: Extract<ManagedBootstrapCarrierV1, { kind: 'ssh' }>;
    credentialPath: string;
    knownHostsPath: string;
    lifetime: AbortSignal;
}>) {
    const connection = { target: `${input.carrier.user}@${input.carrier.address}`, port: input.carrier.port,
        auth: { mode: 'keyFile' as const, privateKeyPath: input.credentialPath },
        knownHostsPath: input.knownHostsPath, knownHostsMode: 'app' as const };
    const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([input.lifetime, signal]) : input.lifetime;
    const openChannel = (argv: readonly string[], signal?: AbortSignal) => openOpenSshRemoteChannel({ ...connection,
        remoteCommand: argv.map(safeBashSingleQuote), signal: signalFor(signal) });
    const io: ManagedNativeBootstrapIO = {
        exec: request => runOpenSshRemoteCommand({ ...connection,
            remoteCommand: ['sh', '-c', safeBashSingleQuote(request.command)],
            input: request.input, signal: signalFor(request.signal), timeoutMs: request.timeoutMs,
            onStdoutChunk: request.onStdoutChunk, rejectOnNonZero: false, includeStdoutInError: false }),
        putFile: async request => {
            await writeManagedChannelFile({ ...request, openChannel: argv => openChannel(argv, request.signal),
                waitForCompletion: async channel => {
                    const completion = await channel.completion;
                    if (completion.status !== 0) throw new SystemTaskExecutionError('remote_command_failed', 'SSH guest file transfer failed.');
                } });
        },
    };
    return { io, openChannel };
}
