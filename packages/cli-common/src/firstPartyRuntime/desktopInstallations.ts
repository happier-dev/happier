import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { resolveHappyHomeDirFromEnvironment } from '../providers/resolveHappyHomeDir.js';
import { normalizePathForComparison } from '../path/pathShape.js';
import { validateDesktopBundleId } from './desktopResourceOwnership.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { withFirstPartyActivationLock } from './withFirstPartyPayloadMutationLock.js';

export type DesktopInstallationContext = Readonly<{ bundleId: string; stateDir: string }>;
export type DesktopInstallation = Readonly<{
  happyHomeDir: string;
  firstPartyInstallHome: string;
  cliPath?: string;
  /** Successful service teardown/audit, persisted before deleting its CLI executor. */
  serviceCleanupLaunchers?: readonly (readonly string[])[];
}>;

/** Native supplies both values from its own bundle identity and platform application-data path. */
export function readDesktopInstallationContext(processEnv: NodeJS.ProcessEnv = process.env): DesktopInstallationContext | null {
  const bundleId = processEnv.HAPPIER_DESKTOP_BUNDLE_ID?.trim();
  const stateDir = processEnv.HAPPIER_DESKTOP_STATE_DIR?.trim();
  if (!bundleId || !stateDir) return null;
  if (!isAbsolute(stateDir)) throw new Error('Desktop installation state directory must be absolute.');
  return { bundleId: validateDesktopBundleId(bundleId), stateDir: resolve(stateDir) };
}

function statePath(context: DesktopInstallationContext): string {
  validateDesktopBundleId(context.bundleId);
  if (!isAbsolute(context.stateDir)) throw new Error('Desktop installation state directory must be absolute.');
  return join(context.stateDir, 'desktop-installations.json');
}

/** Missing records predate ownership tracking; corrupt records require repair, never a reset. */
export async function readDesktopInstallations(context: DesktopInstallationContext): Promise<readonly DesktopInstallation[]> {
  let raw: string;
  try {
    raw = await readFile(statePath(context), 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Desktop installation record.');
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1 || record.bundleId !== context.bundleId || !Array.isArray(record.installations)) {
    throw new Error('Desktop installation record has an unsupported format or bundle identity.');
  }
  return record.installations.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid Desktop installation target.');
    const target = entry as Record<string, unknown>;
    if (typeof target.happyHomeDir !== 'string' || !isAbsolute(target.happyHomeDir)
      || typeof target.firstPartyInstallHome !== 'string' || !isAbsolute(target.firstPartyInstallHome)) {
      throw new Error('Desktop installation target paths must be absolute.');
    }
    if (target.cliPath !== undefined && (typeof target.cliPath !== 'string' || !isAbsolute(target.cliPath))) {
      throw new Error('Desktop CLI executor path must be absolute.');
    }
    if (target.serviceCleanupLaunchers !== undefined && !isDesktopServiceLauncherInventory(target.serviceCleanupLaunchers)) {
      throw new Error('Desktop service cleanup checkpoint is not recognized.');
    }
    return { happyHomeDir: resolve(target.happyHomeDir), firstPartyInstallHome: resolve(target.firstPartyInstallHome),
      ...(typeof target.cliPath === 'string' ? { cliPath: resolve(target.cliPath) } : {}),
      ...(target.serviceCleanupLaunchers !== undefined ? { serviceCleanupLaunchers: target.serviceCleanupLaunchers } : {}),
    };
  });
}

/** Record before acquisition so an OS-launched uninstaller can find custom homes without scanning. */
export async function recordDesktopInstallation(processEnv: NodeJS.ProcessEnv = process.env, cliPath?: string): Promise<DesktopInstallationContext | null> {
  const context = readDesktopInstallationContext(processEnv);
  if (!context) return null;
  const installation: DesktopInstallation = {
    happyHomeDir: resolve(resolveHappyHomeDirFromEnvironment(processEnv)),
    firstPartyInstallHome: resolve(resolveFirstPartyInstallLayout({ componentId: 'happier-cli', processEnv }).happyHomeDir),
    ...(cliPath && isAbsolute(cliPath) ? { cliPath: resolve(cliPath) } : {}),
  };
  await mutateInstallations(context, (installations) => {
    const existing = installations.find((entry) => sameInstallation(entry, installation));
    if (!existing) return [...installations, installation];
    if (existing.serviceCleanupLaunchers === undefined && (!installation.cliPath || existing.cliPath === installation.cliPath)) return installations;
    const { serviceCleanupLaunchers: _checkpoint, ...current } = existing;
    return installations.map((entry) => entry === existing ? { ...current, ...(installation.cliPath ? { cliPath: installation.cliPath } : {}) } : entry);
  });
  return context;
}

export function isDesktopServiceLauncherInventory(value: unknown): value is readonly (readonly string[])[] {
  return Array.isArray(value) && value.every((launcher: unknown) => Array.isArray(launcher)
    && launcher.length > 0 && launcher.every((argument: unknown) => typeof argument === 'string'));
}

/** A successful service phase stays retryable after the last CLI executable is removed. */
export async function checkpointDesktopInstallationServiceCleanup(
  context: DesktopInstallationContext,
  installation: DesktopInstallation,
  serviceCleanupLaunchers: readonly (readonly string[])[],
): Promise<void> {
  if (!isDesktopServiceLauncherInventory(serviceCleanupLaunchers)) throw new Error('Desktop service cleanup checkpoint is not recognized.');
  await mutateInstallations(context, (installations) => installations.map((entry) => sameInstallation(entry, installation)
    ? { ...entry, serviceCleanupLaunchers } : entry));
}

/** Clear only successfully cleaned targets; failed and other-home targets remain retryable. */
export async function forgetDesktopInstallation(context: DesktopInstallationContext, installation: DesktopInstallation): Promise<void> {
  await mutateInstallations(context, (installations) => installations.filter((entry) => !sameInstallation(entry, installation)));
}

function sameInstallation(left: DesktopInstallation, right: DesktopInstallation): boolean {
  return normalizePathForComparison(left.happyHomeDir) === normalizePathForComparison(right.happyHomeDir)
    && desktopInstallationsShareInstallHome(left, right);
}

export function desktopInstallationsShareInstallHome(left: DesktopInstallation, right: DesktopInstallation): boolean {
  return normalizePathForComparison(left.firstPartyInstallHome) === normalizePathForComparison(right.firstPartyInstallHome);
}

async function mutateInstallations(
  context: DesktopInstallationContext,
  update: (installations: readonly DesktopInstallation[]) => readonly DesktopInstallation[],
): Promise<void> {
  await withFirstPartyActivationLock({
    happyHomeDir: context.stateDir,
    operation: async () => {
      const installations = await readDesktopInstallations(context);
      const next = update(installations);
      if (next === installations) return;
      const path = statePath(context);
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      await mkdir(context.stateDir, { recursive: true });
      try {
        await writeFile(temporaryPath, `${JSON.stringify({ version: 1, bundleId: context.bundleId, installations: next })}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporaryPath, path);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    },
  });
}
