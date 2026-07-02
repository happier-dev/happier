import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function binaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'zellij.exe' : 'zellij';
}

function readVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, ['--version'], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if ((code ?? 1) !== 0) {
        resolve(null);
        return;
      }
      resolve(`${stdout}${stderr}`.trim());
    });
  });
}

export async function resolveZellijBinary(params: Readonly<{
  toolsDir: string;
  platform?: NodeJS.Platform;
  expectedVersion: string;
}>): Promise<string | null> {
  const platform = params.platform ?? process.platform;
  const binaryPath = join(params.toolsDir, binaryName(platform));
  if (!existsSync(binaryPath)) return null;
  const version = await readVersion(binaryPath);
  return version?.includes(params.expectedVersion) ? binaryPath : null;
}
