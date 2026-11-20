import { posix } from 'node:path';
import { addAbortSignal, type Duplex } from 'node:stream';
import { safeBashSingleQuote } from '@happier-dev/cli-common/ssh';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { writeManagedChannelFile } from './channelFileDelivery';

function serializeManagedChannelEnvironment(environment: Readonly<NodeJS.ProcessEnv>): string {
    const entries = Object.entries(environment);
    // Names are shell syntax at this boundary. Values travel only as quoted data.
    if (entries.some(([name]) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) {
        throw new PluginError({ code: 'agent_launch_required_file_unavailable', retryable: false,
            message: 'The admitted Agent environment contains an invalid name' });
    }
    return entries.map(([name, value]) => value === undefined ? `unset ${name}` : `export ${name}=${safeBashSingleQuote(value)}`).join('\n');
}

/** Starts the holder over its existing guest stream. Values go straight from stdin to the guest environment. */
export async function launchWithManagedChannelEnvironment(input: Readonly<{
    environment: Readonly<NodeJS.ProcessEnv>;
    renderLaunch(environmentSetup: string): string;
    signal?: AbortSignal;
    openChannel(argv: readonly string[]): Duplex;
}>): Promise<string> {
    const script = `${input.renderLaunch(serializeManagedChannelEnvironment(input.environment))}\n`;
    input.signal?.throwIfAborted();
    const channel = input.openChannel(['sh', '-s']);
    if (input.signal) addAbortSignal(input.signal, channel);
    const stdout = (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of channel) chunks.push(Buffer.from(chunk));
        return Buffer.concat(chunks).toString('utf8');
    })();
    channel.end(script);
    return await stdout;
}

/** Admitted launch values travel as private stdin bytes, never provider command arguments. */
export async function execWithManagedChannelEnvironment<T extends Readonly<{ status: number }>>(input: Readonly<{
    path: string;
    environment: Readonly<NodeJS.ProcessEnv>;
    command: string;
    signal?: AbortSignal;
    exec(command: string): Promise<T>;
    openChannel(argv: readonly string[]): Duplex;
}>): Promise<T> {
    const environment = serializeManagedChannelEnvironment(input.environment);
    if (!environment) return input.exec(input.command);
    const q = safeBashSingleQuote;
    const remove = `rm -f -- ${q(input.path)}`;
    try {
        input.signal?.throwIfAborted();
        const directory = posix.dirname(input.path);
        const prepared = await input.exec(`umask 077; mkdir -p ${q(directory)} && chmod 700 ${q(directory)}`);
        if (prepared.status !== 0) throw new PluginError({ code: 'agent_launch_required_file_unavailable', retryable: false,
            message: 'The private Agent environment directory could not be prepared' });
        await writeManagedChannelFile({ path: input.path, signal: input.signal, openChannel: input.openChannel,
            bytes: Buffer.from(`${environment}\n`) });
        input.signal?.throwIfAborted();
        // The shell's trap also covers a source/removal failure, before any holder or Agent starts.
        return await input.exec(`trap ${q(remove)} EXIT\nchmod 600 ${q(input.path)} && . ${q(input.path)} && ${remove} || exit 1\ntrap - EXIT\n${input.command}`);
    } catch (error) {
        // The provider may refuse exec before its shell ever runs the trap.
        await input.exec(remove);
        throw error;
    }
}
