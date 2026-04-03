import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(join(fileURLToPath(import.meta.url), '../../../../'));

async function defaultEnsureUiWorkspacePackagesBuilt({ env } = {}) {
  const scriptPath = join(repoRoot, 'apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs');
  if (!existsSync(scriptPath)) {
    throw new Error(`[eas-postinstall] missing script: ${scriptPath}`);
  }

  const mod = await import(pathToFileURL(scriptPath).href);
  if (typeof mod.ensureUiWorkspacePackagesBuilt !== 'function') {
    throw new Error('[eas-postinstall] ensureUiWorkspacePackagesBuilt export missing');
  }

  await mod.ensureUiWorkspacePackagesBuilt({ env });
}

export async function runEasPostinstall({
  env = process.env,
  ensureUiWorkspacePackagesBuilt = defaultEnsureUiWorkspacePackagesBuilt,
} = {}) {
  const enabled = env.HAPPIER_EAS_ENSURE_UI_WORKSPACES_BUILT === '1' || env.HAPPIER_EAS_ENSURE_UI_WORKSPACES_BUILT === 'true';
  if (!enabled) return;

  await ensureUiWorkspacePackagesBuilt({ env });
}

async function main() {
  await runEasPostinstall();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

