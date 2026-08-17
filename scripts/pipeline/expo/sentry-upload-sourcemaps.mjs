// @ts-check

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * @param {{ distDir: string; uploaderScriptPath: string }} input
 * @returns {{ cmd: string; args: string[] }}
 */
export function buildSentryExpoUploadCommand(input) {
  return {
    cmd: process.execPath,
    args: [input.uploaderScriptPath, input.distDir],
  };
}

export function resolveSentryExpoUploaderScript(uiDir) {
  const requireFromUi = createRequire(path.join(path.resolve(uiDir), 'package.json'));
  return requireFromUi.resolve('@sentry/react-native/scripts/expo-upload-sourcemaps.js');
}

function runCommand(cmd, args, extra = {}) {
  const result = spawnSync(cmd, args, {
    cwd: extra.cwd,
    env: process.env,
    encoding: 'utf8',
    stdio: extra.stdio ?? 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Sentry source-map upload failed with exit code ${result.status ?? 'unknown'}`);
  }
}

/**
 * @param {{
 *   dryRun: boolean;
 *   uiDir: string;
 *   distDir: string;
 *   env: NodeJS.ProcessEnv;
 *   resolveUploaderScript?: (uiDir: string) => string;
 *   run: (cmd: string, args: string[], extra?: { cwd?: string; stdio?: 'inherit' | 'pipe' }) => void;
 * }} input
 * @returns {{ status: 'uploaded' | 'skipped'; reason?: string }}
 */
export function maybeUploadSentryExpoSourceMaps(input) {
  const should = shouldUploadSentryExpoSourceMaps({ env: input.env, uiDir: input.uiDir, distDir: input.distDir });
  if (!should.enabled) return { status: 'skipped', reason: should.reason };
  if (input.dryRun) return { status: 'skipped', reason: 'dry run' };

  const uploaderScriptPath = (input.resolveUploaderScript ?? resolveSentryExpoUploaderScript)(input.uiDir);
  const { cmd, args } = buildSentryExpoUploadCommand({ distDir: input.distDir, uploaderScriptPath });
  input.run(cmd, args, { cwd: input.uiDir, stdio: 'inherit' });
  return { status: 'uploaded' };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) continue;
    values.set(key, value);
    index += 1;
  }
  return values;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const uiDir = String(args.get('--ui-dir') ?? '').trim();
  const distDir = String(args.get('--dist-dir') ?? '').trim();
  if (!uiDir || !distDir) throw new Error('Sentry source-map upload requires --ui-dir and --dist-dir');
  const result = maybeUploadSentryExpoSourceMaps({
    dryRun: false,
    uiDir,
    distDir,
    env: process.env,
    run: runCommand,
  });
  console.log(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
