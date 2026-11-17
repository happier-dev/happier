import { formatMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { projectOpenCodeServerError } from './formatOpenCodeServerPromptErrorMessage.js';
import { createHash } from 'node:crypto';

import { asRecord, normalizeString, readStringRecord } from './openCodeParsing.js';
import type { OpenCodeServerClient } from './openCodeServerClient.js';
import { isOpenCodeServerUnsupportedOperation } from './openCodeServerClient.js';
import type { OpenCodeRuntimeContext } from './runtimeContext.js';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

/** Required bridge failure is a known refusal before any provider dispatch. */
export class OpenCodeMcpRegistrationError extends Error {
  readonly code = 'opencode_mcp_registration_failed';

  constructor(cause: unknown) {
    super(`required Happier MCP registration failed: ${projectOpenCodeServerError(cause).message}`, { cause });
    this.name = 'OpenCodeMcpRegistrationError';
  }
}

export type OpenCodeMcpRegistration = Readonly<{
  originalName: string;
  projectedName: string;
  config: Readonly<Record<string, unknown>>;
  resolveToolName?: (projectedName: string) => Promise<string | null>;
  toolAliasPrefix?: string;
}>;

export type OpenCodeSessionMcpProjection = Readonly<{
  registrations: readonly OpenCodeMcpRegistration[];
  requiredHappierServerName: string | null;
  requiredHappierConfigurationPresent: boolean;
}>;

export type OpenCodeRegisteredMcpServer = Readonly<{ directory: string; name: string }>;

const OPEN_CODE_MODEL_TOOL_NAME_MAX_LENGTH = 64;
const OPEN_CODE_MCP_NAMESPACE_DIGEST_LENGTH = 7;
// Preserve the isolation prefix and its compact digest; the remaining model budget belongs to tools.
const OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH = 'happier-session-'.length + OPEN_CODE_MCP_NAMESPACE_DIGEST_LENGTH;

export function readOpenCodeMcpToolNameBudget(projectedServerName: string): number {
  return OPEN_CODE_MODEL_TOOL_NAME_MAX_LENGTH - projectedServerName.length - 1;
}

export function sanitizeOpenCodeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function projectOpenCodeMcpName(runtimeIdentity: string, originalName: string): string {
  const candidate = sanitizeOpenCodeMcpName(`happier-session-${runtimeIdentity}--${originalName}`);
  if (candidate.length <= OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH) return candidate;

  const hash = createHash('sha256')
    .update(runtimeIdentity)
    .update('\0')
    .update(originalName)
    .digest('hex');
  const digest = (parseInt(hash.slice(0, 10), 16) % 36 ** OPEN_CODE_MCP_NAMESPACE_DIGEST_LENGTH)
    .toString(36).padStart(OPEN_CODE_MCP_NAMESPACE_DIGEST_LENGTH, '0');
  const prefixLength = OPEN_CODE_MCP_NAMESPACE_MAX_LENGTH - digest.length - 1;
  return `${candidate.slice(0, prefixLength)}-${digest}`;
}

/**
 * `unsupported` is deliberately not a kind of `failed`.
 *
 * `failed` means the reachable server has a dynamic MCP registration route and
 * would not complete this registration: Happier's own tools would be silently
 * missing, so prompt admission fails closed. `unsupported` means the server
 * declares no such route at all — the standalone OpenCode V2 protocol has no
 * MCP group. Failing every ordinary prompt closed over a route that never
 * existed would remove core agent use to protect an integration that cannot
 * exist there, so the session continues without Happier's MCP-backed tools and
 * reports the exact limitation on a default-on signal.
 */
export type OpenCodeMcpRegistrationResult = Readonly<{
  requiredHappier: Readonly<
    | { status: 'ready' }
    | { status: 'not_required' } // No-tools Runs and callers without a Happier bridge have no dependency.
    | { status: 'failed'; error: unknown }
    | { status: 'unsupported'; reason: string }
  >;
  registeredServers: readonly OpenCodeRegisteredMcpServer[];
}>;

function readStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value
      .map((entry) => normalizeString(entry))
      .filter((entry) => entry.length > 0),
  );
}

function readEnvironment(value: unknown): Readonly<Record<string, string>> | null {
  const record = readStringRecord(value);
  const entries = Object.entries(record)
    .filter(([key, entry]) => key.length > 0 && typeof entry === 'string');
  if (entries.length === 0) return null;
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

function readOpenCodeMcpRegistrations(raw: unknown): readonly Readonly<{
  name: string;
  config: Readonly<Record<string, unknown>>;
}>[] {
  const servers = asRecord(raw);
  if (!servers) return Object.freeze([]);

  const registrations: Array<Readonly<{
    name: string;
    config: Readonly<Record<string, unknown>>;
  }>> = [];
  for (const [rawName, rawConfig] of Object.entries(servers)) {
    const name = normalizeString(rawName);
    const config = asRecord(rawConfig);
    const command = normalizeString(config?.command);
    if (!name || !command) continue;

    const args = readStringArray(config?.args);
    const environment = readEnvironment(config?.env);
    registrations.push(Object.freeze({
      name,
      config: Object.freeze({
        type: 'local',
        enabled: true,
        command: Object.freeze([command, ...args]),
        ...(environment ? { environment } : {}),
      }),
    }));
  }

  return Object.freeze(registrations);
}

export function buildOpenCodeSessionMcpProjection(
  runtimeIdentity: string,
  raw: unknown,
  resolveToolNames?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionMcpService['resolveToolNaming'],
  toolAliasPrefix?: string,
): OpenCodeSessionMcpProjection {
  const identity = sanitizeOpenCodeMcpName(runtimeIdentity.trim());
  if (!identity) throw new Error('OpenCode MCP projection requires a runtime identity');
  const registrations = readOpenCodeMcpRegistrations(raw).map(({ name, config }) => Object.freeze({
    originalName: name,
    projectedName: projectOpenCodeMcpName(identity, name),
    config,
    ...(resolveToolNames && toolAliasPrefix && name === 'happier' ? {
      toolAliasPrefix,
      resolveToolName: async (projectedName: string) => {
        const projectedServerName = projectOpenCodeMcpName(identity, name);
        const naming = await resolveToolNames({ serverName: name,
          toolNameMaxLength: readOpenCodeMcpToolNameBudget(projectedServerName) });
        return naming?.tools.find(tool => tool.projectedName === projectedName)?.originalName ?? null;
      },
    } : {}),
  }));
  return Object.freeze({
    registrations: Object.freeze(registrations),
    requiredHappierServerName:
      registrations.find(({ originalName }) => originalName === 'happier')?.projectedName ?? null,
    requiredHappierConfigurationPresent:
      Object.keys(asRecord(raw) ?? {}).some((name) => normalizeString(name) === 'happier'),
  });
}

function readOpenCodeProjectedMcpToolName<T extends Readonly<{ originalName: string; projectedName: string }>>(
  rawToolName: string,
  registrations: readonly T[],
) {
  const trimmed = rawToolName.trim();
  const match = registrations.map(registration => ({ registration, alias: sanitizeOpenCodeMcpName(registration.projectedName) }))
    .filter(({ alias }) => trimmed.startsWith(`${alias}_`))
    .sort((left, right) => right.alias.length - left.alias.length)[0];
  return match ? { registration: match.registration, suffix: trimmed.slice(match.alias.length + 1).trim() } : null;
}

export function canonicalizeOpenCodeProjectedMcpToolName(
  rawToolName: string,
  projection: Readonly<{ registrations: readonly Readonly<{ originalName: string; projectedName: string }>[] }>,
  policy?: AgentSessionOpenRequest['mcpToolPolicy'],
): string {
  const parsed = readOpenCodeProjectedMcpToolName(rawToolName, projection.registrations);
  if (!parsed) return rawToolName;
  const { registration, suffix } = parsed;
  const knownTools = Object.prototype.hasOwnProperty.call(policy ?? {}, registration.originalName)
    ? Object.keys(policy![registration.originalName]!.tools).filter(name => sanitizeOpenCodeMcpName(name) === suffix)
    : [];
  if (knownTools.length > 1) return rawToolName;
  return suffix ? formatMcpToolWireNameV1(registration.originalName, knownTools[0] ?? suffix) : rawToolName;
}

/** Resolve only transport aliases; ordinary tools retain their local canonical path. */
export function resolveOpenCodeProjectedMcpToolName(
  rawToolName: string,
  projection: OpenCodeSessionMcpProjection,
  policy?: AgentSessionOpenRequest['mcpToolPolicy'],
): string | Promise<string> {
  const parsed = readOpenCodeProjectedMcpToolName(rawToolName, projection.registrations);
  const registration = parsed?.registration;
  if (parsed && registration?.resolveToolName && registration.toolAliasPrefix && parsed.suffix.startsWith(registration.toolAliasPrefix)) {
    return registration.resolveToolName(parsed.suffix).then(original =>
      original === null ? rawToolName : formatMcpToolWireNameV1(registration.originalName, original));
  }
  return canonicalizeOpenCodeProjectedMcpToolName(rawToolName, projection, policy);
}

export async function registerOpenCodeMcpServers(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  client: OpenCodeServerClient;
  directory: string;
  mcpProjection: OpenCodeSessionMcpProjection;
  configuration?: AgentSessionOpenRequest['configuration'];
}>): Promise<OpenCodeMcpRegistrationResult> {
  if (params.configuration?.unlistedTools === 'deny' && params.configuration.allowedTools?.length === 0) {
    return { requiredHappier: { status: 'not_required' }, registeredServers: [] };
  }
  const registrations = params.mcpProjection.registrations;
  const registeredServers: OpenCodeRegisteredMcpServer[] = [];
  // The open-request MCP record is optional, including for detached Runs.
  // Only an explicitly supplied Happier bridge establishes this dependency.
  let requiredHappier: OpenCodeMcpRegistrationResult['requiredHappier'] =
    params.mcpProjection.requiredHappierConfigurationPresent
      ? { status: 'failed', error: new Error('required Happier MCP server command is missing') }
      : { status: 'not_required' };
  for (const registration of registrations) {
    try {
      const registrationStatus = await params.client.mcpAdd({
        directory: params.directory,
        name: registration.projectedName,
        config: registration.config,
      });
      if (registrationStatus.status !== 'connected') {
        const detail = 'error' in registrationStatus ? `: ${registrationStatus.error}` : '';
        throw new Error(
          `OpenCode MCP server "${registration.originalName}" returned status "${registrationStatus.status}"${detail}`,
        );
      }
      registeredServers.push({ directory: params.directory, name: registration.projectedName });
      if (registration.originalName === 'happier') {
        requiredHappier = { status: 'ready' };
      }
    } catch (error) {
      if (isOpenCodeServerUnsupportedOperation(error, 'mcp_registration')) {
        const reason = error instanceof Error
          ? error.message
          : 'the reachable OpenCode server has no dynamic MCP registration route';
        if (registration.originalName === 'happier') {
          requiredHappier = { status: 'unsupported', reason };
        }
        // Default-on, because this silently removes every Happier MCP-backed
        // tool (including title updates) from an otherwise working session.
        params.ctx.logger.warn(
          '[OpenCodeServer] this server supports no dynamic MCP registration; continuing without Happier MCP tools',
          {
            serverName: registration.projectedName,
            dialect: error.dialect,
            reason,
          },
        );
        continue;
      }
      if (registration.originalName === 'happier') {
        requiredHappier = { status: 'failed', error };
      }
      params.ctx.logger.debug(
        registration.originalName === 'happier'
          ? '[OpenCodeServer] Required Happier MCP server registration failed; prompt admission will fail closed'
          : '[OpenCodeServer] Failed to register MCP server (non-fatal)',
        {
          serverName: registration.projectedName,
          error: projectOpenCodeServerError(error),
        },
      );
    }
  }
  return Object.freeze({
    requiredHappier: Object.freeze(requiredHappier),
    registeredServers: Object.freeze(registeredServers),
  });
}

export function scheduleOpenCodeMcpServerRegistration(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  client: OpenCodeServerClient;
  directory: string;
  mcpProjection: OpenCodeSessionMcpProjection;
  configuration?: AgentSessionOpenRequest['configuration'];
}>): Promise<OpenCodeMcpRegistrationResult> {
  return (async () => {
    return await registerOpenCodeMcpServers({
      ctx: params.ctx,
      client: params.client,
      directory: params.directory,
      mcpProjection: params.mcpProjection,
      configuration: params.configuration,
    });
  })().catch((error: unknown) => {
    params.ctx.logger.debug(
      '[OpenCodeServer] MCP server registration setup failed; prompt admission will fail closed',
      { error: projectOpenCodeServerError(error) },
    );
    return {
      requiredHappier: { status: 'failed', error },
      registeredServers: Object.freeze([]),
    } satisfies OpenCodeMcpRegistrationResult;
  });
}

export async function disconnectOpenCodeMcpServers(params: Readonly<{
  ctx: OpenCodeRuntimeContext;
  client: OpenCodeServerClient;
  registration: Promise<OpenCodeMcpRegistrationResult>;
}>): Promise<void> {
  const result = await params.registration;
  for (const server of result.registeredServers) {
    try {
      await params.client.mcpRemove(server);
    } catch (error) {
      params.ctx.logger.debug('[OpenCodeServer] Failed to disconnect session-scoped MCP server (non-fatal)', {
        ...server,
        error: projectOpenCodeServerError(error),
      });
    }
  }
}
