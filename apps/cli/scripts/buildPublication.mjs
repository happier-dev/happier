// @ts-check

/**
 * Canonical CLI publication build.
 *
 * A CLI tarball may only ship outputs this exact sequence produced:
 *
 * 1. `buildSharedDeps.mjs --artifact` compiles every included generator-owned plugin from
 *    current source and refuses the publication when one fails. A live/development shared
 *    build isolates that failure instead and keeps the plugin's last-green package
 *    installed, so a pack that follows it ships bytes current source cannot produce.
 *    That step also regenerates the bundled plugin inventory
 *    (`src/plugins/projection/registry/sources/generatedBundledPluginArtifacts.ts`).
 * 2. The CLI dist build runs AFTER that regeneration, so the dist runtime-input
 *    fingerprint covers the inventory this publication produced. Running it first is what
 *    makes `assertCliPackInputCurrentness` in `packTarball.mjs` trip on its own inputs.
 *
 * Every producer of a CLI tarball runs these steps, in this order, through this module:
 * the npm `prepack` lifecycle, the release packager, the release-validation `cli-update`
 * gate and the CLI smoke gate. `packTarball.mjs` packs what this build produced; it does
 * not re-derive the sequence.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// A publication build recompiles the complete bundled closure from source rather than
// reusing published outputs, so it is bounded by that build, not by an incremental one.
const DEFAULT_PUBLICATION_BUILD_TIMEOUT_MS = 30 * 60_000;
const MAX_PUBLICATION_BUILD_TIMEOUT_MS = 2 * 60 * 60_000;

function resolveCliPublicationBuildTimeoutMs({ env, timeoutMs }) {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)) {
    return timeoutMs;
  }
  const raw = String(env?.HAPPIER_CLI_PUBLICATION_BUILD_TIMEOUT_MS ?? '').trim();
  if (!raw) return DEFAULT_PUBLICATION_BUILD_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PUBLICATION_BUILD_TIMEOUT_MS;
  return Math.min(
    MAX_PUBLICATION_BUILD_TIMEOUT_MS,
    Math.max(DEFAULT_PUBLICATION_BUILD_TIMEOUT_MS, parsed),
  );
}

/**
 * @param {{ repoRoot?: string; packageRoot?: string }} [options]
 * @returns {string}
 */
function resolveCliPublicationPackageRoot(options = {}) {
  if (options.packageRoot) return resolve(String(options.packageRoot));
  if (options.repoRoot) return resolve(String(options.repoRoot), 'apps', 'cli');
  return resolve(__dirname, '..');
}

/**
 * The ordered steps of the canonical CLI publication build. Callers that own their own
 * spawn conventions (dry-run rendering, Windows command resolution, pipeline logging)
 * consume this list directly instead of restating the sequence.
 *
 * @param {{ repoRoot?: string; packageRoot?: string; processExecPath?: string }} [options]
 * @returns {Array<{ name: string; command: string; args: string[]; cwd: string }>}
 */
export function resolveCliPublicationBuildSteps(options = {}) {
  const packageRoot = resolveCliPublicationPackageRoot(options);
  const scriptDir = resolve(packageRoot, 'scripts');
  const command = String(options.processExecPath ?? process.execPath);
  return [
    {
      name: 'shared-deps',
      command,
      args: [resolve(scriptDir, 'buildSharedDeps.mjs'), '--artifact'],
      cwd: packageRoot,
    },
    {
      name: 'dist',
      command,
      args: [resolve(scriptDir, 'build.mjs')],
      cwd: packageRoot,
    },
  ];
}

/**
 * @param {{
 *   repoRoot?: string;
 *   packageRoot?: string;
 *   processExecPath?: string;
 *   exec?: (command: string, args: string[], options?: import('node:child_process').ExecFileSyncOptions) => unknown;
 *   env?: NodeJS.ProcessEnv;
 *   stdio?: import('node:child_process').StdioOptions;
 *   timeoutMs?: number;
 * }} [options]
 */
export function buildCliPublication(options = {}) {
  const exec = options.exec ?? execFileSync;
  const env = options.env ?? process.env;
  const stdio = options.stdio ?? 'inherit';
  const timeout = resolveCliPublicationBuildTimeoutMs({
    env,
    timeoutMs: options.timeoutMs,
  });
  for (const step of resolveCliPublicationBuildSteps(options)) {
    exec(step.command, step.args, {
      cwd: step.cwd,
      env,
      stdio,
      timeout,
    });
  }
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    buildCliPublication();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
