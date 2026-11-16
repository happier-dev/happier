import { AZ_BINARY_NAME, AZ_CLI_SETUP_URL, AZ_DEP_ID } from '@happier-dev/protocol/installables/definitions/az';
import { resolveExecutableCommand } from '@happier-dev/cli-common/process';

import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

type AzCommandResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}>;

type AzStatusDeps = Readonly<{
  resolveSystemAzBinPath: (env?: NodeJS.ProcessEnv, cwd?: string) => Promise<string | null>;
  runAzCommand: (params: Readonly<{ binPath: string; args: readonly string[]; timeoutMs?: number; processEnv?: NodeJS.ProcessEnv; cwd?: string }>) => Promise<AzCommandResult>;
}>;

export type AzDepData = Readonly<{
  installed: boolean;
  capabilityId: typeof AZ_DEP_ID;
  installDir: null;
  binPath: string | null;
  managedBinPath: null;
  installedVersion: string | null;
  sourceKind: 'manual_only';
  resolvedSource: 'system' | null;
  authenticated: boolean | null;
  authStatus: 'authenticated' | 'missing_auth' | 'unknown';
  remediationReason: 'install_required' | 'auth_required' | null;
  setupUrl: typeof AZ_CLI_SETUP_URL;
  loginCommand: readonly ['az', 'login'];
  accountName: string | null;
  tenantId: string | null;
  lastInstallLogPath: null;
  lastBackgroundUpdateCheckAtMs: null;
}>;

function parseAzVersion(stdout: string): string | null {
  const match = /\bazure-cli\s+([0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9.-]+)?)/i.exec(stdout);
  return match?.[1] ?? null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseAccountMetadata(stdout: string): Readonly<{ accountName: string | null; tenantId: string | null }> {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const user = parsed.user && typeof parsed.user === 'object' && !Array.isArray(parsed.user)
      ? parsed.user as Record<string, unknown>
      : {};
    return {
      accountName: readString(user.name) ?? readString(parsed.name),
      tenantId: readString(parsed.tenantId),
    };
  } catch {
    return { accountName: null, tenantId: null };
  }
}

async function resolveSystemAzBinPath(env: NodeJS.ProcessEnv = process.env, cwd?: string): Promise<string | null> {
  return resolveExecutableCommand(AZ_BINARY_NAME, { env, cwd });
}

async function runAzCommand(params: Readonly<{ binPath: string; args: readonly string[]; timeoutMs?: number; processEnv?: NodeJS.ProcessEnv; cwd?: string }>): Promise<AzCommandResult> {
  return runCliCommandBestEffort({
    resolvedPath: params.binPath,
    args: [...params.args],
    timeoutMs: params.timeoutMs ?? 2_000,
    processEnv: params.processEnv,
    cwd: params.cwd,
    env: {
      AZURE_CORE_NO_COLOR: '1',
      AZURE_CORE_ONLY_SHOW_ERRORS: '1',
    },
  });
}

export async function getAzDepStatus(
  opts: Readonly<{ includeLatestVersion?: boolean; onlyIfInstalled?: boolean; env?: NodeJS.ProcessEnv; cwd?: string }> = {},
  depsOverrides: Partial<AzStatusDeps> = {},
): Promise<AzDepData> {
  const environment = opts.env ?? sessionProcessEnvironment();
  const cwd = opts.cwd ?? sessionWorkingDirectory();
  const deps: AzStatusDeps = {
    resolveSystemAzBinPath: depsOverrides.resolveSystemAzBinPath ?? resolveSystemAzBinPath,
    runAzCommand: depsOverrides.runAzCommand ?? runAzCommand,
  };

  const binPath = await deps.resolveSystemAzBinPath(environment, cwd);
  if (!binPath) {
    return {
      installed: false,
      capabilityId: AZ_DEP_ID,
      installDir: null,
      binPath: null,
      managedBinPath: null,
      installedVersion: null,
      sourceKind: 'manual_only',
      resolvedSource: null,
      authenticated: null,
      authStatus: 'unknown',
      remediationReason: 'install_required',
      setupUrl: AZ_CLI_SETUP_URL,
      loginCommand: ['az', 'login'],
      accountName: null,
      tenantId: null,
      lastInstallLogPath: null,
      lastBackgroundUpdateCheckAtMs: null,
    };
  }

  const [versionResult, accountResult] = await Promise.all([
    deps.runAzCommand({ binPath, args: ['--version'], processEnv: environment, cwd }),
    deps.runAzCommand({ binPath, args: ['account', 'show', '--output', 'json'], processEnv: environment, cwd }),
  ]);
  // `az account show` answers only when it exits. A probe the deadline killed — or one that never
  // launched — comes back `ok: false` with `exitCode: null`, and reading that as "signed out"
  // prints an `az login` instruction to a user who may well be signed in.
  const authStatus: AzDepData['authStatus'] = accountResult.ok
    ? 'authenticated'
    : typeof accountResult.exitCode === 'number' ? 'missing_auth' : 'unknown';
  const authenticated = authStatus === 'unknown' ? null : authStatus === 'authenticated';
  const account = authenticated === true
    ? parseAccountMetadata(accountResult.stdout)
    : { accountName: null, tenantId: null };

  return {
    installed: true,
    capabilityId: AZ_DEP_ID,
    installDir: null,
    binPath,
    managedBinPath: null,
    installedVersion: parseAzVersion(versionResult.stdout),
    sourceKind: 'manual_only',
    resolvedSource: 'system',
    authenticated,
    authStatus,
    remediationReason: authStatus === 'missing_auth' ? 'auth_required' : null,
    setupUrl: AZ_CLI_SETUP_URL,
    loginCommand: ['az', 'login'],
    accountName: account.accountName,
    tenantId: account.tenantId,
    lastInstallLogPath: null,
    lastBackgroundUpdateCheckAtMs: null,
  };
}
