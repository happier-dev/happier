import { DEFAULT_AGENT_ID } from '@happier-dev/agents';
import {
  SessionSpawnNewInputV2Schema,
  buildBackendTargetKeyV2,
  findSpawnConfigOptionAliasConflicts,
  mergeSpawnConfigOptionAliases,
  readBackendTargetRefV2,
  parseAgentPermissionIntentV1Alias,
  resolveSessionModelSelectionInputRefV1,
  type SessionSpawnNewInputV2,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';
import { readSettings, type Settings } from '@/persistence';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';

import type { SessionCreateSpawnRequest } from './parseSessionCreateSpawnOptions';

type SpawnAgentDefinition = Readonly<{
  id: string;
  identity?: SessionSpawnNewInputV2['agentTarget']['identity'];
}>;

type SessionCreateMachineSettings = Pick<
  Settings,
  'machineId' | 'machineIdByServerId' | 'machineIdByServerIdByAccountId' | 'lastTokenSubByServerId'
>;

export type SessionCreateSpawnRequestNormalizerDeps = Readonly<{
  activeServerId: string;
  defaultAgentId: string;
  readSettings: () => Promise<SessionCreateMachineSettings>;
  readAgentDefinitions: () => Iterable<SpawnAgentDefinition>;
  now: () => number;
}>;

export type NormalizedSessionCreateSpawnRequest = Readonly<{
  input: SessionSpawnNewInputV2;
  agentId: string;
}>;

function nonEmptyString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function invalidSessionCreateArgument(message: string): never {
  throw new Error(`Invalid session create argument: ${message}`);
}

function defaultNormalizerDeps(): SessionCreateSpawnRequestNormalizerDeps {
  return {
    activeServerId: configuration.activeServerId,
    defaultAgentId: DEFAULT_AGENT_ID,
    readSettings,
    readAgentDefinitions: () => readAgentCatalogSnapshot().agentDefinitionsById.values(),
    now: () => Date.now(),
  };
}

function resolveConfiguration(
  request: SessionCreateSpawnRequest,
  updatedAtMs: number,
): SessionSpawnNewInputV2['configuration'] | undefined {
  if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
    invalidSessionCreateArgument('configuration timestamp is invalid.');
  }
  if (findSpawnConfigOptionAliasConflicts({
    sessionConfigOptionOverrides: request.sessionConfigOptionOverrides,
    configOptions: request.configOptions,
  }).length > 0) {
    invalidSessionCreateArgument('--config-option conflicts with --config-overrides-json.');
  }

  const merged = mergeSpawnConfigOptionAliases({
    sessionConfigOptionOverrides: request.sessionConfigOptionOverrides,
    configOptions: request.configOptions,
    updatedAt: updatedAtMs,
  });
  if (!merged) return undefined;
  if (
    !Number.isSafeInteger(merged.updatedAt)
    || merged.updatedAt < 0
    || !Object.values(merged.overrides).every((override) => (
      Number.isSafeInteger(override.updatedAt)
      && override.updatedAt >= 0
    ))
  ) {
    invalidSessionCreateArgument('configuration overrides are invalid.');
  }

  return {
    mode: { value: null, updatedAtMs },
    model: { value: null, updatedAtMs },
    permissionIntent: { value: null, updatedAtMs },
    options: Object.fromEntries(Object.entries(merged.overrides).map(([id, override]) => [
      id,
      { value: override.value, updatedAtMs: override.updatedAt },
    ])),
  };
}

function resolveAgentTarget(
  request: SessionCreateSpawnRequest,
  deps: SessionCreateSpawnRequestNormalizerDeps,
): Readonly<{
  agentId: string;
  agentTarget: SessionSpawnNewInputV2['agentTarget'];
  backendTargetKey: string;
}> {
  const requestedBackendTarget = request.backendTargetKey
    ? (() => {
        try {
          return readBackendTargetRefV2(request.backendTargetKey);
        } catch {
          return invalidSessionCreateArgument('--backend does not identify an executable Agent.');
        }
      })()
    : null;
  const selectedAgentId = requestedBackendTarget?.backendId ?? nonEmptyString(deps.defaultAgentId);
  if (!selectedAgentId) {
    invalidSessionCreateArgument('the default Agent is unavailable.');
  }
  const agent = [...deps.readAgentDefinitions()].find((candidate) => candidate.id === selectedAgentId);
  if (!agent?.identity) {
    invalidSessionCreateArgument('--backend does not resolve to a current qualified Agent identity.');
  }
  const backendTarget = readBackendTargetRefV2({
    kind: 'backend',
    backendId: agent.id,
    sourceKind: 'built_in',
  });
  return {
    agentId: agent.id,
    agentTarget: { kind: 'agent', identity: agent.identity },
    backendTargetKey: buildBackendTargetKeyV2(backendTarget),
  };
}

async function resolveExecutionTarget(
  request: SessionCreateSpawnRequest,
  deps: SessionCreateSpawnRequestNormalizerDeps,
): Promise<SessionSpawnNewInputV2['executionTarget']> {
  const activeServerId = nonEmptyString(deps.activeServerId);
  if (!activeServerId) {
    invalidSessionCreateArgument('the active server is unavailable.');
  }
  const requestedServerId = nonEmptyString(request.serverId);
  if (requestedServerId && requestedServerId !== activeServerId) {
    invalidSessionCreateArgument('--server-id must match the active server.');
  }
  const settings = await deps.readSettings();
  const accountId = nonEmptyString(settings.lastTokenSubByServerId?.[activeServerId]);
  const configuredMachineId = resolveMachineIdForServerFromSettings(settings, activeServerId, accountId)
    ?? nonEmptyString(settings.machineId);
  const machineId = nonEmptyString(request.machineId) ?? configuredMachineId;
  if (!machineId) {
    throw new Error('Missing machine id. Start the local daemon or pass --machine-id.');
  }
  return { serverId: activeServerId, machineId };
}

/**
 * The sole CLI argv-to-Action adapter for ordinary Session creation. It keeps
 * legacy spellings at the CLI boundary and emits the strict canonical V2
 * payload consumed by `session.spawn_new`. The public API transport projects
 * its host-owned execution target at the Action-surface owner.
 */
export async function normalizeSessionCreateSpawnRequest(
  request: SessionCreateSpawnRequest,
  suppliedDeps?: SessionCreateSpawnRequestNormalizerDeps,
): Promise<NormalizedSessionCreateSpawnRequest> {
  const deps = suppliedDeps ?? defaultNormalizerDeps();

  const directory = nonEmptyString(request.directory);
  if (!directory) {
    invalidSessionCreateArgument('--path is required.');
  }
  const updatedAtMs = deps.now();
  const [executionTarget, resolvedAgent] = await Promise.all([
    resolveExecutionTarget(request, deps),
    Promise.resolve(resolveAgentTarget(request, deps)),
  ]);
  const modelId = nonEmptyString(request.modelId);
  const providerConnectionId = nonEmptyString(request.providerConnectionId);
  if (providerConnectionId && !modelId) {
    invalidSessionCreateArgument('--provider-connection requires --model.');
  }
  const configuration = resolveConfiguration(request, updatedAtMs);
  const title = nonEmptyString(request.title);
  const initialInputText = nonEmptyString(request.initialInput?.text);
  const permissionModeRaw = nonEmptyString(request.permissionMode);
  const permissionMode = permissionModeRaw
    ? parseAgentPermissionIntentV1Alias(permissionModeRaw)
    : null;
  if (permissionModeRaw && !permissionMode) {
    invalidSessionCreateArgument(`permission mode "${permissionModeRaw}" is invalid.`);
  }
  const agentModeId = nonEmptyString(request.agentModeId);
  const profileId = nonEmptyString(request.profileId);
  // The `default` reset sentinel is native-only: a Provider connection may serve
  // a model literally named `default`, so the canonical resolver — not this
  // adapter — decides whether a flat argv pair is a real structured selection.
  const modelSelectionRef = (() => {
    if (!modelId) return null;
    try {
      return resolveSessionModelSelectionInputRefV1({
        agentTargetKey: resolvedAgent.backendTargetKey,
        providerConnectionId,
        modelId,
      });
    } catch {
      return invalidSessionCreateArgument('the requested model selection is invalid.');
    }
  })();
  const candidate = {
    executionTarget,
    directory,
    agentTarget: resolvedAgent.agentTarget,
    ...(modelSelectionRef
      ? {
          modelSelection: {
            v: 1 as const,
            updatedAt: updatedAtMs,
            ref: modelSelectionRef,
          },
        }
      : {}),
    ...(title ? { title } : {}),
    ...(initialInputText ? { initialInput: { text: initialInputText } } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(agentModeId ? { agentModeId } : {}),
    ...(configuration ? { configuration } : {}),
    ...(request.connectedServices ? { connectedServices: request.connectedServices } : {}),
    ...(request.mcpSelection ? { mcpSelection: request.mcpSelection } : {}),
    ...(request.transcriptStorage ? { transcriptStorage: request.transcriptStorage } : {}),
    ...(request.terminal ? { terminal: request.terminal } : {}),
    ...(profileId ? { profileId } : {}),
    ...(request.environmentVariables ? { environmentVariables: request.environmentVariables } : {}),
  };
  const parsed = SessionSpawnNewInputV2Schema.safeParse(candidate);
  if (!parsed.success) {
    invalidSessionCreateArgument('the requested Session creation fields are invalid.');
  }
  return { input: parsed.data, agentId: resolvedAgent.agentId };
}
