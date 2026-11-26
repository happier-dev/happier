import type { CliInstallSource, CliUpdateFacts } from '@happier-dev/protocol';
import {
  describeHappierCliOrigin,
  doesCliLauncherUseInstallation,
  type HappierCliOrigin,
  readInstalledVersionMarkersSync,
  readLastCliUpdateResult,
  resolveFirstPartyInstallLayout,
  resolveManagedCliToolNameForRing,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { readCachedCliUpdateState, resolveNpmPackageNameOverride } from '@happier-dev/cli-common/update';
import { getReleaseRingCatalogEntry, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { configuration } from '@/configuration';

import packageJson from '../../../../package.json';

/**
 * Where the running CLI came from. `managed` only when this process runs a version the managed
 * install of its own ring recorded (`current.version` present and the canonical launcher owner
 * matches the executable to that install, including its home bin shortcuts) — the install the
 * one update transaction can replace and restore.
 */
function resolveRunningCliInstallSource(params: Readonly<{
  homeDir: string;
  publicReleaseRing: PublicReleaseRingId;
  execPath: string;
  invokedPath: string;
  platform: NodeJS.Platform;
  npmPackageName: string;
}>): Readonly<{ installSource: CliInstallSource; packageManagerCommand: string | null }> {
  const layout = resolveFirstPartyInstallLayout({
    componentId: 'happier-cli',
    channel: params.publicReleaseRing,
    processEnv: { HAPPIER_HOME_DIR: params.homeDir },
  });
  const { currentVersionId } = readInstalledVersionMarkersSync(layout);
  if (currentVersionId && doesCliLauncherUseInstallation({
    launcher: [params.execPath],
    installationRoots: [layout.installRoot],
  })) {
    return { installSource: 'managed', packageManagerCommand: null };
  }
  const origin = resolveRunningCliPackageManagerOrigin(params);
  return origin
    ? { installSource: origin.kind, packageManagerCommand: origin.updateCommand }
    : { installSource: 'other', packageManagerCommand: null };
}

/** This CLI's Homebrew formulae: `happier`, and its versioned/channel variants (`happier@preview`). */
function isHappierHomebrewFormula(formula: string): boolean {
  return /^happier(?:@[a-z0-9][a-z0-9.-]*)?$/u.test(formula);
}

/**
 * The package manager (npm, Homebrew) that owns the running CLI, or `null`. Both the invoked path
 * and the executable are read: a Bun-compiled `happier` reports `argv[1]` as its embedded bundle
 * (`/$bunfs/root/happier`), so only `execPath` — the resolved executable inside a Homebrew keg —
 * names where it was installed, while an npm install is named by the script node runs.
 */
export function resolveRunningCliPackageManagerOrigin(params: Readonly<{
  invokedPath: string;
  execPath: string;
  npmPackageName: string;
}>): Extract<HappierCliOrigin, { kind: 'npm' | 'brew' }> | null {
  for (const candidate of [params.invokedPath, params.execPath]) {
    const origin = describeHappierCliOrigin(candidate);
    // An origin counts only when it is this CLI's own: its npm package, or a keg of its formula
    // (not whatever launched it, e.g. Homebrew's Node at `Cellar/node/<version>/bin/node`).
    if (
      (origin.kind === 'brew' && isHappierHomebrewFormula(origin.formula))
      || (origin.kind === 'npm' && origin.packageName === params.npmPackageName)
    ) {
      return origin;
    }
  }
  return null;
}

/**
 * K5 — this CLI's update facts, from files it already keeps (no network read): the running
 * version, the ring-filtered cached daily check, the install source with the exact command that
 * updates it, whether its daemon can run the update itself, and the last update outcome.
 *
 * Windows remains manual-only: its updater must survive stopping the daemon's process tree,
 * and a remote launcher has not been validated across that service restart. systemd
 * (`KillMode=process`) and launchd (`AbandonProcessGroup`) leave a detached child running.
 */
export function readCliUpdateFacts(params: Readonly<{
  homeDir: string;
  publicReleaseRing: PublicReleaseRingId;
  currentVersion: string;
  execPath: string;
  invokedPath: string;
  platform: NodeJS.Platform;
  /** The npm package this CLI is published as (an npm origin of any other package is not this CLI). */
  npmPackageName: string;
}>): CliUpdateFacts {
  const cached = readCachedCliUpdateState({
    homeDir: params.homeDir,
    publicReleaseRing: params.publicReleaseRing,
    currentVersion: params.currentVersion,
  });
  const { installSource, packageManagerCommand } = resolveRunningCliInstallSource(params);
  const managed = installSource === 'managed';
  return {
    currentVersion: params.currentVersion,
    latestVersion: cached?.latestVersion ?? null,
    channel: getReleaseRingCatalogEntry(params.publicReleaseRing).publicLabel,
    installSource,
    updateCommand: managed ? `${resolveManagedCliToolNameForRing(params.publicReleaseRing)} self update` : packageManagerCommand,
    canUpdateRemotely: managed && params.platform !== 'win32',
    lastUpdate: managed
      ? readLastCliUpdateResult({ channel: params.publicReleaseRing, processEnv: { HAPPIER_HOME_DIR: params.homeDir } })
      : null,
  };
}

/** The npm package this CLI is published as (the update-package override, else its own name). */
export function resolveThisCliNpmPackageName(): string {
  return resolveNpmPackageNameOverride({
    envValue: process.env.HAPPIER_CLI_UPDATE_PACKAGE_NAME,
    fallback: String(packageJson.name ?? '').trim(),
  });
}

/** The running CLI's own K5 facts. */
export function readCliUpdateFactsForThisCli(): CliUpdateFacts {
  return readCliUpdateFacts({
    homeDir: configuration.happyHomeDir,
    publicReleaseRing: configuration.publicReleaseRing,
    currentVersion: configuration.currentCliVersion,
    execPath: process.execPath,
    invokedPath: process.argv[1] ?? process.execPath,
    platform: process.platform,
    npmPackageName: resolveThisCliNpmPackageName(),
  });
}
