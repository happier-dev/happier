/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn } from 'child_process';
import { requireJavaScriptRuntimeExecutable } from '@/runtime/js/requireJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { resolveCliRuntimeAssetPath } from '@/runtime/assets/resolveCliRuntimeAssetPath';

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface RipgrepOptions {
    cwd?: string
}

/**
 * Run ripgrep with the given arguments
 * @param args - Array of command line arguments to pass to ripgrep
 * @param options - Options for ripgrep execution
 * @returns Promise with exit code, stdout and stderr
 */
export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    const RUNNER_PATH = resolveCliRuntimeAssetPath('scripts', 'ripgrep_launcher.cjs');
    return new Promise((resolve, reject) => {
        void (async () => {
            const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
                isBunRuntime: isBun(),
                targetLabel: 'ripgrep launcher',
            });
            const child = spawn(runtimeExecutable, [RUNNER_PATH, JSON.stringify(args)], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: options?.cwd,
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                resolve({
                    exitCode: code || 0,
                    stdout,
                    stderr
                });
            });

            child.on('error', (err) => {
                reject(err);
            });
        })().catch(reject);
    });
}
