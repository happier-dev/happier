// @ts-check

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string | undefined} raw
 * @returns {string}
 */
function normalizeToken(raw) {
  return String(raw ?? '').trim();
}

/**
 * @param {{ env: NodeJS.ProcessEnv; uiDir: string; distDir: string }} input
 * @returns {{ enabled: boolean; reason?: string }}
 */
export function shouldUploadSentryExpoSourceMaps(input) {
  const token = normalizeToken(input.env.SENTRY_AUTH_TOKEN);
  if (!token) return { enabled: false, reason: 'missing SENTRY_AUTH_TOKEN' };

  const distAbs = path.resolve(input.uiDir, input.distDir);
  if (!fs.existsSync(distAbs)) return { enabled: false, reason: `missing dist at ${distAbs}` };

  return { enabled: true };
}

/**
 * @param {{ distDir: string }} input
 * @returns {{ cmd: string; args: string[] }}
 */
export function buildSentryExpoUploadCommand(input) {
  return {
    cmd: 'npx',
    args: ['--yes', 'sentry-expo-upload-sourcemaps', input.distDir],
  };
}

/**
 * @param {{
 *   dryRun: boolean;
 *   uiDir: string;
 *   distDir: string;
 *   env: NodeJS.ProcessEnv;
 *   run: (cmd: string, args: string[], extra?: { cwd?: string; stdio?: 'inherit' | 'pipe' }) => void;
 * }} input
 * @returns {{ status: 'uploaded' | 'skipped'; reason?: string }}
 */
export function maybeUploadSentryExpoSourceMaps(input) {
  const should = shouldUploadSentryExpoSourceMaps({ env: input.env, uiDir: input.uiDir, distDir: input.distDir });
  if (!should.enabled) return { status: 'skipped', reason: should.reason };
  if (input.dryRun) return { status: 'skipped', reason: 'dry run' };

  const { cmd, args } = buildSentryExpoUploadCommand({ distDir: input.distDir });
  input.run(cmd, args, { cwd: input.uiDir, stdio: 'inherit' });
  return { status: 'uploaded' };
}
