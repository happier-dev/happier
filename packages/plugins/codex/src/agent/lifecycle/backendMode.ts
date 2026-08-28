import {
  type CodexBackendMode,
  normalizeCodexBackendMode,
  readCanonicalCodexAgentRuntimeDescriptorV1,
} from '../../protocol/runtimeDescriptorV1.js';

export class CodexLegacyMcpBackendModeUnsupportedError extends Error {
  readonly code = 'codex_legacy_mcp_backend_mode_unsupported';

  constructor() {
    super('The legacy Codex MCP runtime is no longer available. Select App Server or ACP explicitly.');
    this.name = 'CodexLegacyMcpBackendModeUnsupportedError';
  }
}

function isLegacyMcpBackendMode(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === 'mcp';
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function runtimeDescriptorDeclaresLegacyMcp(value: unknown): boolean {
  const descriptor = readRecord(value);
  if (!descriptor) return false;
  const agent = readRecord(descriptor.agent) ?? readRecord(descriptor.provider);
  if (!agent) return false;
  if (isLegacyMcpBackendMode(agent.backendMode)) return true;

  // Released descriptors may retain the same provider-owned fact in their
  // bounded extra carrier. It remains readable only to reject the unavailable
  // runtime; it is never reinterpreted as App Server.
  const extra = readRecord(agent.agentExtra) ?? readRecord(agent.providerExtra);
  const runtimeHandle = readRecord(extra?.runtimeHandle) ?? readRecord(extra?.runtimeAffinity);
  return isLegacyMcpBackendMode(runtimeHandle?.backendMode);
}

function assertNoLegacyMcpBackendMode(params: Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  defaultBackendMode?: unknown;
  runtimeDescriptorV1?: unknown;
}>): void {
  if (
    isLegacyMcpBackendMode(params.backendMode)
    || isLegacyMcpBackendMode(params.codexBackendMode)
    || isLegacyMcpBackendMode(params.defaultBackendMode)
    || runtimeDescriptorDeclaresLegacyMcp(params.runtimeDescriptorV1)
  ) {
    throw new CodexLegacyMcpBackendModeUnsupportedError();
  }
}

export function resolveCanonicalCodexBackendMode(params: Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  runtimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
  assertNoLegacyMcpBackendMode(params);
  const runtimeDescriptor = readCanonicalCodexAgentRuntimeDescriptorV1(
    params.runtimeDescriptorV1,
  );
  const runtimeBackendMode = normalizeCodexBackendMode(runtimeDescriptor?.backendMode);
  if (runtimeBackendMode) {
    return runtimeBackendMode;
  }

  const requestedBackendMode =
    normalizeCodexBackendMode(params.backendMode)
    ?? normalizeCodexBackendMode(params.codexBackendMode);
  if (requestedBackendMode) {
    return requestedBackendMode;
  }

  return undefined;
}

export function resolveCanonicalCodexBackendModeFromCompatInput(params: Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  experimentalCodexAcp?: boolean;
  runtimeDescriptorV1?: unknown;
}>): CodexBackendMode | undefined {
  return resolveCanonicalCodexBackendMode({
    backendMode: params.backendMode,
    codexBackendMode: params.codexBackendMode ?? (params.experimentalCodexAcp === true ? 'acp' : undefined),
    runtimeDescriptorV1: params.runtimeDescriptorV1,
  });
}

export function resolveCodexBackendModeForRun(opts: Readonly<{
  backendMode?: unknown;
  codexBackendMode?: unknown;
  defaultBackendMode?: unknown;
}>): CodexBackendMode {
  assertNoLegacyMcpBackendMode(opts);
  const explicitMode =
    normalizeCodexBackendMode(opts.backendMode)
    ?? normalizeCodexBackendMode(opts.codexBackendMode);
  if (explicitMode) return explicitMode;

  const defaultMode = normalizeCodexBackendMode(opts.defaultBackendMode);
  return defaultMode ?? 'appServer';
}

export function resolveCodexSessionBackendMode(params: Readonly<{
  accountSettings?: Readonly<Record<string, unknown>> | null;
}>): CodexBackendMode | null {
  const settings = params.accountSettings ?? {};
  return resolveCodexBackendModeForRun({
    codexBackendMode: settings.codexBackendMode,
    defaultBackendMode: settings.experimentalCodexAcp === true ? 'acp' : 'appServer',
  });
}
