/**
 * Tailscale CLI subprocess helpers (system boundary).
 *
 * IMPORTANT:
 * - These helpers must be best-effort and bounded by timeouts.
 * - Do not throw user-facing errors from generic probes; callers decide whether to surface.
 */

import { execFile } from 'node:child_process';

export async function runTailscaleServeStatus(params: Readonly<{
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  tailscaleBin: string;
}>): Promise<string> {
  const timeoutMs = Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? Math.trunc(params.timeoutMs) : 750;
  const tailscaleBin = String(params.tailscaleBin ?? '').trim() || 'tailscale';
  const env: NodeJS.ProcessEnv = { ...params.env };
  // LaunchAgents can inherit `XPC_SERVICE_NAME`, which has been observed to cause some CLIs to hang.
  delete env.XPC_SERVICE_NAME;

  return await new Promise<string>((resolve, reject) => {
    execFile(
      tailscaleBin,
      ['serve', 'status'],
      { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err: any = new Error(error instanceof Error ? error.message : String(error));
          err.cause = error;
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve(String(stdout ?? ''));
      },
    );
  });
}

