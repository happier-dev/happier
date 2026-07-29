import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let ffmpegStaticPathPromise: Promise<string | null> | null = null;

function isModuleResolutionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('Cannot find module')
    || message.includes('Cannot find package')
    || message.includes('ERR_MODULE_NOT_FOUND')
  );
}

export async function resolveFfmpegStaticBinaryPath(): Promise<string | null> {
  if (!ffmpegStaticPathPromise) {
    ffmpegStaticPathPromise = (async () => {
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
      try {
        const candidateStat = await stat(candidate);
        return candidateStat.isFile() ? candidate : null;
      } catch {
        return null;
      }
    })();
  }
  return await ffmpegStaticPathPromise;
}
