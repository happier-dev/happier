import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';
/**
 * Low-level difftastic wrapper - just arguments in, string out
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'path';
import { platform } from 'os';
import { projectPath } from '@/projectPath';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/keys';
import { ensureOptionalRuntime } from '@/packagedRuntime/installables/optionalRuntimes';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { currentWorkspaceSource } from '@/workspaces/source/workspaceSource';

export interface DifftasticResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface DifftasticOptions {
    cwd?: string
    /** The admitted request's cancellation; aborting tears the child tree down. */
    signal?: AbortSignal
}

function createDifftasticAbortError(): Error {
    return Object.assign(new Error('Difftastic operation was aborted'), { name: 'AbortError', code: 'DIFFTASTIC_ABORTED' });
}

/**
 * Get the platform-specific binary path
 */
export async function resolveDifftasticBinaryPath(): Promise<string> {
    const platformName = platform();
    const binaryName = platformName === 'win32' ? 'difft.exe' : 'difft';
    const bundled = resolveCliRuntimeAssetPath('tools', 'unpacked', binaryName);
    if (existsSync(bundled)) return bundled;
    const projectBinary = resolve(join(projectPath(), 'tools', 'unpacked', binaryName));
    if (existsSync(projectBinary)) return projectBinary;
    return await ensureOptionalRuntime(INSTALLABLE_KEYS.DIFFTASTIC);
}

/**
 * Run difftastic with the given arguments
 * @param args - Array of command line arguments to pass to difftastic
 * @param options - Options for difftastic execution
 * @returns Promise with exit code, stdout and stderr
 */
export async function run(args: string[], options?: DifftasticOptions): Promise<DifftasticResult> {
    // The admitted request's workspace source owns where difftastic runs.
    const source = currentWorkspaceSource();
    const signal = options?.signal;
    if (signal?.aborted) throw createDifftasticAbortError();
    const launch = await source.toolLaunch({ tool: 'difftastic', args });
    if (signal?.aborted) throw createDifftasticAbortError();

    return new Promise((resolve, reject) => {
        const child = source.spawn({ command: launch.command, args: launch.args,
            ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
            // Force color output when needed
            env: { ...sessionProcessEnvironment(), FORCE_COLOR: '1' } });
        if (launch.stdin !== undefined) child.stdin.end(launch.stdin);

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        const onAbort = () => {
            // A cancelled request stops the diff it no longer consumes.
            void child.terminateTree().catch(() => {});
            reject(createDifftasticAbortError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });

        child.on('close', (code) => {
            signal?.removeEventListener('abort', onAbort);
            resolve({
                exitCode: typeof code === 'number' ? code : -1,
                stdout,
                stderr
            });
        });

        child.on('error', (err) => {
            signal?.removeEventListener('abort', onAbort);
            reject(err);
        });
    });
}
