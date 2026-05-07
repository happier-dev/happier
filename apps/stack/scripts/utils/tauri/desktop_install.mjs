import { cp, mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
function sanitizeMacAppName(productName) {
  const value = String(productName ?? '').trim() || 'Happier';
  return value.replace(/[/:]/g, '-');
}

export function resolveMacOsDesktopInstallPlan({
  productName,
  sourceAppPath,
  installDir = '',
  env = process.env,
  homeDir = homedir(),
} = {}) {
  const resolvedInstallDir =
    String(installDir || env.HAPPIER_STACK_DESKTOP_INSTALL_DIR || '').trim() ||
    join(homeDir, 'Applications');
  const appName = `${sanitizeMacAppName(productName)}.app`;
  return {
    productName: sanitizeMacAppName(productName),
    sourceAppPath: String(sourceAppPath ?? '').trim(),
    installDir: resolvedInstallDir,
    targetAppPath: join(resolvedInstallDir, appName),
  };
}

export async function installMacOsDesktopApp({
  productName,
  sourceAppPath,
  installDir = '',
  env = process.env,
  homeDir = homedir(),
} = {}) {
  const plan = resolveMacOsDesktopInstallPlan({ productName, sourceAppPath, installDir, env, homeDir });
  if (!plan.sourceAppPath) {
    throw new Error('[stack install] missing desktop app source path.');
  }

  let sourceStats;
  try {
    sourceStats = await stat(plan.sourceAppPath);
  } catch {
    throw new Error(`[stack install] desktop app bundle not found: ${plan.sourceAppPath}`);
  }
  if (!sourceStats.isDirectory()) {
    throw new Error(`[stack install] desktop app source is not an app bundle directory: ${plan.sourceAppPath}`);
  }

  await mkdir(plan.installDir, { recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const tmpAppPath = join(plan.installDir, `.${plan.productName}.tmp-${suffix}.app`);
  const backupAppPath = join(plan.installDir, `.${plan.productName}.backup-${suffix}.app`);
  await rm(tmpAppPath, { recursive: true, force: true });
  await cp(plan.sourceAppPath, tmpAppPath, { recursive: true, force: true });

  let movedExistingToBackup = false;
  try {
    if (existsSync(plan.targetAppPath)) {
      await rm(backupAppPath, { recursive: true, force: true });
      await rename(plan.targetAppPath, backupAppPath);
      movedExistingToBackup = true;
    }
    await rename(tmpAppPath, plan.targetAppPath);
    if (movedExistingToBackup) {
      await rm(backupAppPath, { recursive: true, force: true });
    }
  } catch (error) {
    await rm(tmpAppPath, { recursive: true, force: true }).catch(() => {});
    if (movedExistingToBackup && !existsSync(plan.targetAppPath) && existsSync(backupAppPath)) {
      await rename(backupAppPath, plan.targetAppPath).catch(() => {});
    }
    throw error;
  }

  return {
    ok: true,
    ...plan,
  };
}
