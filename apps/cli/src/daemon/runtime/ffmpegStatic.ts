import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';

const require = createRequire(import.meta.url);

function isModuleResolutionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('Cannot find module')
    || message.includes('Cannot find package')
    || message.includes('ERR_MODULE_NOT_FOUND')
  );
}

export async function resolveFfmpegStaticBinaryPath(): Promise<string | null> {
  let resolvedPath: unknown;
  try {
    resolvedPath = require('ffmpeg-static');
  } catch (error) {
    if (isModuleResolutionFailure(error)) {
      return null;
    }
    throw error;
  }
  const candidate = typeof resolvedPath === 'string'
    ? resolvedPath
    : typeof (resolvedPath as { default?: unknown } | null)?.default === 'string'
      ? (resolvedPath as { default: string }).default
      : null;
  if (!candidate) {
    return null;
  }
  // Check on demand, not once per daemon: support repair/removal must be visible to
  // the next recording or audio decode request without another daemon restart.
  try {
    return await new Promise<string | null>(resolve => {
      execFile(candidate, ['-version'], { windowsHide: true }, (error, stdout) => {
        resolve(!error && /^ffmpeg version \S+/u.test(stdout) ? candidate : null);
      });
    });
  } catch {
    return null;
  }
}
