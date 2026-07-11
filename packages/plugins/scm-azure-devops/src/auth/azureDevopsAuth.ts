import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm';
import {
  AZ_CLI_SETUP_URL,
  AZ_DEP_ID,
} from '@happier-dev/plugin-sdk/experimental/managedDependencies';
import type { ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk';

export type AzureDevopsCliAuthDetectionResult =
  | Readonly<{
      kind: 'authenticated';
      capabilityId: typeof AZ_DEP_ID;
      binPath: string;
      source: string;
      accountName: string | null;
      tenantId: string | null;
    }>
  | Readonly<{
      kind: 'missing-auth';
      capabilityId: typeof AZ_DEP_ID;
      binPath: string;
      source: string;
      remediation: AzureDevopsAuthRemediation;
    }>
  | Readonly<{
      kind: 'missing-cli';
      capabilityId: typeof AZ_DEP_ID;
      remediation: AzureDevopsAuthRemediation;
    }>;

export type AzureDevopsAuthRemediation =
  | Readonly<{
      kind: 'install_required';
      setupUrl: typeof AZ_CLI_SETUP_URL;
    }>
  | Readonly<{
      kind: 'auth_required';
      commandPreview: readonly ['az', 'login'];
    }>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseAccount(stdout: string): Readonly<{ accountName: string | null; tenantId: string | null }> {
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

export async function detectAzureDevopsCliAuth(input: Readonly<{
  provider: ScmHostingProviderRef;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>): Promise<AzureDevopsCliAuthDetectionResult> {
  const resolution = await input.runtimeServices?.resolveInstallableCommand?.({ capabilityId: AZ_DEP_ID });
  if (!resolution || resolution.kind !== 'available') {
    return {
      kind: 'missing-cli',
      capabilityId: AZ_DEP_ID,
      remediation: {
        kind: 'install_required',
        setupUrl: AZ_CLI_SETUP_URL,
      },
    };
  }

  const result = await input.runtimeServices?.runCommand?.({
    binPath: resolution.binPath,
    args: ['account', 'show', '--output', 'json'],
    timeoutMs: 2_000,
    env: {
      AZURE_CORE_NO_COLOR: '1',
      AZURE_CORE_ONLY_SHOW_ERRORS: '1',
    },
  });
  if (!result?.ok) {
    return {
      kind: 'missing-auth',
      capabilityId: AZ_DEP_ID,
      binPath: resolution.binPath,
      source: resolution.source,
      remediation: {
        kind: 'auth_required',
        commandPreview: ['az', 'login'],
      },
    };
  }

  const account = parseAccount(result.stdout);
  return {
    kind: 'authenticated',
    capabilityId: AZ_DEP_ID,
    binPath: resolution.binPath,
    source: resolution.source,
    accountName: account.accountName,
    tenantId: account.tenantId,
  };
}
