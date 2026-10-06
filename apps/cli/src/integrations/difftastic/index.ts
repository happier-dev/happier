/**
 * Low-level difftastic wrapper - just arguments in, string out
 */

import { spawn } from 'child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'path';
import { platform } from 'os';
import { projectPath } from '@/projectPath';
import { INSTALLABLE_KEYS } from '@happier-dev/protocol/installables/codexAcp';
import { ensureOptionalRuntime } from '@/packagedRuntime/installables/optionalRuntimes';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';

export interface DifftasticResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface DifftasticOptions {
    cwd?: string
}

/**
 * Get the platform-specific binary path
 */
async function getBinaryPath(): Promise<string> {
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
    const binaryPath = await getBinaryPath();
    
    return new Promise((resolve, reject) => {
        const child = spawn(binaryPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: options?.cwd,
            env: {
                ...process.env,
                // Force color output when needed
                FORCE_COLOR: '1'
            },
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
                exitCode: typeof code === 'number' ? code : -1,
                stdout,
                stderr
            });
        });

        child.on('error', (err) => {
            reject(err);
        });
    });
}
