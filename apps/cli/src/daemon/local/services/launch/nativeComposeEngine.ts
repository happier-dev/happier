import { hostname } from 'node:os';
import { parseNativeDockerEngineInfo, type NativeDockerEngineFacts } from '@happier-dev/cli-common/machineSetup';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { LocalServiceNativePrerequisiteV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import type { ProjectNativeToolchainIo } from '@/workspaces/toolchain/prepareProjectNativeToolchain';

export type NativeComposeEngineFacts = NativeDockerEngineFacts;

export class NativeComposePrerequisiteError extends PluginError {
    constructor(cause: LocalServiceNativePrerequisiteV1['cause']) {
        const prerequisite: LocalServiceNativePrerequisiteV1 = { tool: 'docker', machineName: hostname(), cause };
        super({ code: 'native_tool_unavailable', message: 'Docker is unavailable on this machine', details: { prerequisite } });
    }
}

function dockerFailureCause(stderr: string, code?: unknown): LocalServiceNativePrerequisiteV1['cause'] {
    // Permission precedes Docker's generic "daemon is not running" advice on Windows.
    if (code === 'EACCES' || code === 'EPERM' || /permission denied|access is denied|operation not permitted/iu.test(stderr)) return 'permission_denied';
    if (code === 'ENOENT') return 'not_installed';
    if (code === 'ECONNREFUSED' || /cannot connect to the docker daemon|connection refused|no such file or directory|the system cannot find the file specified/iu.test(stderr)) return 'not_running';
    return 'unavailable';
}

type EngineReadInput = Readonly<{
    io: Pick<ProjectNativeToolchainIo, 'run'>;
    command: string;
    prefix: readonly string[];
    cwd: string;
    env: Readonly<Record<string, string>>;
    signal?: AbortSignal;
}>;

/** One current native read supplies both admission identity and target disclosure. */
export async function readNativeComposeEngine(input: EngineReadInput): Promise<NativeComposeEngineFacts> {
    const assertNotCancelled = () => {
        if (input.signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    };
    assertNotCancelled();
    let output: Awaited<ReturnType<ProjectNativeToolchainIo['run']>>;
    try {
        output = await input.io.run({ command: input.command, args: [...input.prefix, 'info', '--format', '{{json .}}'],
            cwd: input.cwd, env: input.env, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
        const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
        // Unsettled probe-process custody is not a native prerequisite refusal.
        if (code === 'plugin_exec_termination_incomplete') throw error;
        assertNotCancelled();
        throw new NativeComposePrerequisiteError(dockerFailureCause('', code));
    }
    assertNotCancelled();
    if (output.exitCode !== 0) throw new NativeComposePrerequisiteError(dockerFailureCause(output.stderr ?? ''));
    const facts = parseNativeDockerEngineInfo(output.stdout);
    if (!facts) throw new NativeComposePrerequisiteError('unavailable');
    return facts;
}

/** Existing workspace prerequisite consumes the same read without deployment policy. */
export async function assertNativeComposeAvailable(input: EngineReadInput): Promise<string> {
    return (await readNativeComposeEngine(input)).id;
}
