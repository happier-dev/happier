import { getAgentAuthProbeConfig, type AgentAuthProbeConfig, type AgentId } from '@happier-dev/agents';

import { createCatalogCliAuthSpec } from '@/capabilities/cliAuth/createCatalogCliAuthSpec';
import { createUnknownCliAuthSpec } from '@/capabilities/cliAuth/createUnknownCliAuthSpec';
import { runCliCommandBestEffort } from '@/capabilities/cliAuth/shared';
import type { CliAuthSpec, CliAuthStatusDraft } from '@/backends/types';

function parseKiroWhoamiAccountLabel(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ['email', 'username', 'displayName', 'name']) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function detectKiroAuthStatus(resolvedPath: string, args: ReadonlyArray<string>): Promise<CliAuthStatusDraft> {
  const result = await runCliCommandBestEffort({
    resolvedPath,
    args: [...args],
    timeoutMs: 2_000,
  });

  if (!result.ok) {
    return {
      state: result.exitCode === null ? 'unknown' : 'logged_out',
      reason: result.exitCode === null ? 'probe_failed' : 'missing_credentials',
      source: 'command',
    };
  }

  const accountLabel = parseKiroWhoamiAccountLabel(result.stdout);

  return {
    state: 'logged_in',
    method: 'oauth_cli',
    source: 'command',
    ...(accountLabel ? { accountLabel } : {}),
  };
}

function reportsDevinLoggedOut(stdout: string, stderr: string): boolean {
  return /(?:^|\r?\n)\s*not logged in\.\s*(?:\r?\n|$)/iu.test(`${stdout}\n${stderr}`);
}

async function detectDevinAuthStatus(
  resolvedPath: string,
  args: ReadonlyArray<string>,
): Promise<CliAuthStatusDraft> {
  const result = await runCliCommandBestEffort({
    resolvedPath,
    args: [...args],
    timeoutMs: 2_000,
  });

  if (reportsDevinLoggedOut(result.stdout, result.stderr)) {
    return {
      state: 'logged_out',
      reason: 'missing_credentials',
      source: 'command',
    };
  }

  if (!result.ok) return { state: 'unknown', reason: 'probe_failed', source: 'command' };

  return {
    state: 'logged_in',
    method: 'oauth_cli',
    source: 'command',
  };
}

async function detectCredentialSourceJsonAuthStatus(
  resolvedPath: string,
  args: ReadonlyArray<string>,
  config: NonNullable<AgentAuthProbeConfig['jsonStatus']>,
): Promise<CliAuthStatusDraft> {
  const unknown: CliAuthStatusDraft = { state: 'unknown', reason: 'probe_failed', source: 'command' };
  const result = await runCliCommandBestEffort({ resolvedPath, args: [...args] });
  if (!result.ok || result.exitCode !== 0) return unknown;

  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return unknown;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknown;
  if (Reflect.get(value, config.discriminator.field) !== config.discriminator.value
    || config.requiredBooleanFields.some((field) => typeof Reflect.get(value, field) !== 'boolean')) return unknown;

  const credentialSource = Reflect.get(value, config.sourceField);
  const expired = Reflect.get(value, config.expiredField);
  if (typeof credentialSource !== 'string' || (expired !== undefined && typeof expired !== 'boolean')) return unknown;
  if (credentialSource === config.missingSource) {
    return { state: 'logged_out', reason: 'missing_credentials', source: 'command' };
  }
  if (credentialSource === config.unconfiguredSource) {
    return { state: 'unknown', reason: 'not_configured', source: 'command' };
  }

  const method = config.methods.find(({ source }) => typeof source === 'string'
    ? source === credentialSource : source.test(credentialSource))?.method;
  if (!method) return unknown;
  return expired
    ? { state: 'logged_out', reason: 'expired', source: 'command' }
    : { state: 'logged_in', method, source: 'command' };
}

export function createCatalogDefinedCliAuthSpec(agentId: AgentId): CliAuthSpec {
  const config = getAgentAuthProbeConfig(agentId);

  if (config.parser === 'unknown') {
    return createUnknownCliAuthSpec(agentId);
  }

  const { statusCommand, jsonStatus } = config;
  if (config.parser === 'credentialSourceJson' && statusCommand && jsonStatus) {
    return createCatalogCliAuthSpec(agentId, {
      detectAuthStatus: async ({ resolvedPath }) => detectCredentialSourceJsonAuthStatus(resolvedPath, statusCommand, jsonStatus),
    });
  }

  if (config.parser === 'kiroWhoamiJson' && config.statusCommand) {
    return createCatalogCliAuthSpec(agentId, {
      detectAuthStatus: async ({ resolvedPath }) => detectKiroAuthStatus(resolvedPath, config.statusCommand ?? []),
    });
  }

  if (config.parser === 'devinAuthStatus' && config.statusCommand) {
    return createCatalogCliAuthSpec(agentId, {
      detectAuthStatus: async ({ resolvedPath }) => detectDevinAuthStatus(resolvedPath, config.statusCommand ?? []),
    });
  }

  throw new Error(`No generic catalog CLI auth builder is available for '${agentId}' (${config.parser})`);
}
