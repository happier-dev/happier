/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn } from 'child_process';
import { requireJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/requireJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface RipgrepOptions {
    cwd?: string
    signal?: AbortSignal
}

function createRipgrepAbortError(): Error {
    const error = new Error('Ripgrep operation was aborted');
    error.name = 'AbortError';
    Object.assign(error, { code: 'RIPGREP_ABORTED' });
    return error;
}

/**
 * Run ripgrep with the given arguments
 * @param args - Array of command line arguments to pass to ripgrep
 * @param options - Options for ripgrep execution
 * @returns Promise with exit code, stdout and stderr
 */
export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    const RUNNER_PATH = resolveCliRuntimeAssetPath('scripts', 'ripgrep_launcher.cjs');
    if (options?.signal?.aborted) {
        return Promise.reject(createRipgrepAbortError());
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let child: ReturnType<typeof spawn> | null = null;

        const cleanup = () => {
            options?.signal?.removeEventListener('abort', onAbort);
        };
        const resolveOnce = (value: RipgrepResult) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onAbort = () => {
            if (settled) return;
            if (child) {
                // The launcher can own a native ripgrep child on some platform
                // paths. Delegate teardown to the canonical cross-platform tree
                // owner instead of killing only its immediate runtime process.
                void killProcessTree(child).catch(() => {});
            }
            rejectOnce(createRipgrepAbortError());
        };

        options?.signal?.addEventListener('abort', onAbort, { once: true });
        void (async () => {
            const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
                isBunRuntime: isBun(),
                targetLabel: 'ripgrep launcher',
            });
            if (settled || options?.signal?.aborted) {
                return;
            }
            const spawned = spawn(runtimeExecutable, [RUNNER_PATH, JSON.stringify(args)], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: options?.cwd,
                windowsHide: true,
            });
            child = spawned;

            let stdout = '';
            let stderr = '';

            spawned.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            spawned.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            spawned.on('close', (code) => {
                resolveOnce({
                    exitCode: code || 0,
                    stdout,
                    stderr
                });
            });

            spawned.on('error', (err) => {
                rejectOnce(err);
            });
            if (options?.signal?.aborted) {
                onAbort();
            }
        })().catch(rejectOnce);
    });
}
