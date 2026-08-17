import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type { HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';

const AZ_CLI_SETUP_URL = 'https://learn.microsoft.com/cli/azure/install-azure-cli' as const;
const AZURE_CLI_LOCAL_ID = 'azure-cli' as const;
const AZURE_CLI_EXECUTABLE = Object.freeze({ kind: 'systemTool' as const, id: AZURE_CLI_LOCAL_ID });

export type AzureDevopsCliAuthDetectionResult =
  | Readonly<{
      kind: 'authenticated';
      capabilityId: typeof AZURE_CLI_LOCAL_ID;
      accountName: string | null;
      tenantId: string | null;
    }>
  | Readonly<{
      kind: 'missing-auth';
      capabilityId: typeof AZURE_CLI_LOCAL_ID;
      remediation: AzureDevopsAuthRemediation;
    }>
  | Readonly<{
      kind: 'missing-cli';
      capabilityId: typeof AZURE_CLI_LOCAL_ID;
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
  const executeCommand = input.runtimeServices?.executeCommand;
  if (!executeCommand) {
    return {
      kind: 'missing-cli',
      capabilityId: AZURE_CLI_LOCAL_ID,
      remediation: {
        kind: 'install_required',
        setupUrl: AZ_CLI_SETUP_URL,
      },
    };
  }

  const result = await executeCommand({
    executable: AZURE_CLI_EXECUTABLE,
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
      capabilityId: AZURE_CLI_LOCAL_ID,
      remediation: {
        kind: 'auth_required',
        commandPreview: ['az', 'login'],
      },
    };
  }

  const account = parseAccount(result.stdout);
  return {
    kind: 'authenticated',
    capabilityId: AZURE_CLI_LOCAL_ID,
    accountName: account.accountName,
    tenantId: account.tenantId,
  };
}
