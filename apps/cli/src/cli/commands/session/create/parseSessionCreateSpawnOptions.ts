import {
  AcpConfigOptionOverridesV1Schema,
  ConnectedServiceBindingsV1Schema,
  readBackendTargetRefV2,
  RuntimeDescriptorV1Schema,
  SessionMcpSelectionV1Schema,
  type SpawnConfigOptionValue,
} from '@happier-dev/protocol';
import { isAgentId } from '@happier-dev/agents';

import { readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { normalizeBackendTargetKeysFromCsv } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';
import {
  parseConnectedServicesLaunchAuth,
  type ConnectedServicesLaunchAuthIntent,
} from '@/cli/connectedServicesLaunchAuth';

export type SessionCreateSpawnActionInput = Record<string, unknown>;

export type ParsedSessionCreateSpawnOptions = Readonly<{
  json: boolean;
  backendRaw: string;
  backendTargetKey: string | null;
  spawnAttemptId: string | null;
  resumeSpawnAttempt: boolean;
  connectedServicesAuthIntent?: ConnectedServicesLaunchAuthIntent;
  actionInput: SessionCreateSpawnActionInput;
}>;

function readRepeatedFlagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const raw = argv[index + 1];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) values.push(trimmed);
  }
  return values;
}

function parseConfigOptionValue(raw: string): SpawnConfigOptionValue {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return trimmed;
}

function parseConfigOptionFlag(raw: string): Readonly<{ id: string; value: SpawnConfigOptionValue }> {
  const separatorIndex = raw.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error('Invalid --config-option. Expected <id=value>.');
  }
  const id = raw.slice(0, separatorIndex).trim();
  if (!id) {
    throw new Error('Invalid --config-option. Expected <id=value>.');
  }
  return { id, value: parseConfigOptionValue(raw.slice(separatorIndex + 1)) };
}

function parseConfigOptions(argv: readonly string[]): Record<string, SpawnConfigOptionValue> | null {
  const configOptions: Record<string, SpawnConfigOptionValue> = {};
  for (const raw of readRepeatedFlagValues(argv, '--config-option')) {
    const parsed = parseConfigOptionFlag(raw);
    configOptions[parsed.id] = parsed.value;
  }

  const reasoningEffort = readFlagValue(argv, '--reasoning-effort');
  if (reasoningEffort) {
    configOptions.reasoning_effort = reasoningEffort.trim();
  }

  if (hasFlag(argv, '--ultracode')) {
    configOptions.ultracode = true;
  }

  return Object.keys(configOptions).length > 0 ? configOptions : null;
}

function parseJsonFlagValue(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${flag} must be valid JSON`);
  }
}

function parseObjectJsonFlagValue(raw: string, flag: string): Record<string, unknown> {
  const parsed = parseJsonFlagValue(raw, flag);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readParsedJsonFlag<T>(
  argv: readonly string[],
  flag: string,
  parse: (value: unknown) => T,
): T | null {
  const raw = readFlagValue(argv, flag);
  if (!raw) return null;
  const parsed = parseJsonFlagValue(raw, flag);
  try {
    return parse(parsed);
  } catch {
    throw new Error(`Invalid ${flag}.`);
  }
}

function parseEnvironmentVariables(argv: readonly string[]): Record<string, string> | null {
  const values = readRepeatedFlagValues(argv, '--env');
  if (values.length === 0) return null;
  const environmentVariables: Record<string, string> = {};
  for (const raw of values) {
    const separatorIndex = raw.indexOf('=');
    if (separatorIndex <= 0) {
      throw new Error('Invalid --env. Expected <KEY=VALUE>.');
    }
    const key = raw.slice(0, separatorIndex).trim();
    if (!key) {
      throw new Error('Invalid --env. Expected <KEY=VALUE>.');
    }
    environmentVariables[key] = raw.slice(separatorIndex + 1);
  }
  return environmentVariables;
}

function parseTranscriptStorage(raw: string): 'persisted' | 'direct' {
  if (raw === 'persisted' || raw === 'direct') return raw;
  throw new Error('Invalid --transcript-storage.');
}

export function parseSessionCreateSpawnOptions(argv: readonly string[]): ParsedSessionCreateSpawnOptions {
  const path = resolveRequestedSessionDirectory({
    requestedDirectory: readFlagValue(argv, '--path') ?? null,
  });
  const tag = (readFlagValue(argv, '--tag') ?? '').trim();
  const title = (readFlagValue(argv, '--title') ?? '').trim();
  const initialPrompt = (readFlagValue(argv, '--message') ?? readFlagValue(argv, '--prompt') ?? '').trim();
  const backendRaw = (readFlagValue(argv, '--backend') ?? readFlagValue(argv, '--agent') ?? '').trim();
  const backendTargetKeys = normalizeBackendTargetKeysFromCsv(backendRaw);
  const backendTargetKey = backendTargetKeys.length === 1 ? backendTargetKeys[0] : null;
  const backendAgentId = (() => {
    if (!backendTargetKey) return null;
    try {
      const target = readBackendTargetRefV2(backendTargetKey);
      return target.sourceKind !== 'configured' && isAgentId(target.backendId)
        ? target.backendId
        : null;
    } catch {
      return null;
    }
  })();
  const modelId = (readFlagValue(argv, '--model') ?? '').trim();
  const providerConnectionId = (readFlagValue(argv, '--provider-connection') ?? '').trim();
  if (providerConnectionId && !modelId) {
    throw new Error('--provider-connection requires --model.');
  }
  const permissionMode = (readFlagValue(argv, '--permission-mode') ?? '').trim();
  const agentModeId = (readFlagValue(argv, '--mode') ?? '').trim();
  const launchProfileId = readFlagValue(argv, '--launch-profile');
  const legacyProfileId = readFlagValue(argv, '--profile');
  if (launchProfileId !== null && legacyProfileId !== null) {
    throw new Error('Choose only one of --launch-profile or --profile.');
  }
  const profileId = (launchProfileId ?? legacyProfileId ?? '').trim();
  const host = (readFlagValue(argv, '--host') ?? '').trim();
  const machineId = (readFlagValue(argv, '--machine-id') ?? '').trim();
  const serverId = (readFlagValue(argv, '--server-id') ?? '').trim();
  const spawnAttemptId = (readFlagValue(argv, '--spawn-attempt-id') ?? '').trim() || null;
  if (spawnAttemptId && (spawnAttemptId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(spawnAttemptId))) {
    throw new Error('Invalid --spawn-attempt-id.');
  }
  const resumeSpawnAttempt = hasFlag(argv, '--resume-spawn-attempt');
  if (resumeSpawnAttempt && !spawnAttemptId) {
    throw new Error('Invalid --resume-spawn-attempt without --spawn-attempt-id.');
  }
  const transcriptStorageRaw = (readFlagValue(argv, '--transcript-storage') ?? '').trim();
  const configOptions = parseConfigOptions(argv);
  const sessionConfigOptionOverrides = readParsedJsonFlag(
    argv,
    '--config-overrides-json',
    (value) => AcpConfigOptionOverridesV1Schema.parse(value),
  );
  const environmentVariables = parseEnvironmentVariables(argv);
  const authRaw = readFlagValue(argv, '--auth');
  const connectedServicesAliasRaw = readFlagValue(argv, '--connected-services');
  const authJsonRaw = readFlagValue(argv, '--auth-json');
  const connectedServicesJsonRaw = readFlagValue(argv, '--connected-services-json');
  if ((authRaw && connectedServicesAliasRaw) || (authJsonRaw && connectedServicesJsonRaw)) {
    throw new Error('Choose only one connected-services auth option.');
  }
  const connectedServicesAuthRaw = authRaw ?? connectedServicesAliasRaw;
  const connectedServicesRaw = authJsonRaw ?? connectedServicesJsonRaw;
  if (connectedServicesAuthRaw && connectedServicesRaw) {
    throw new Error('Choose only one connected-services auth option.');
  }
  const connectedServices = connectedServicesRaw ? (() => {
    const flag = authJsonRaw ? '--auth-json' : '--connected-services-json';
    const parsed = parseJsonFlagValue(connectedServicesRaw, flag);
    try {
      return ConnectedServiceBindingsV1Schema.parse(parsed);
    } catch {
      throw new Error(`Invalid ${flag}.`);
    }
  })() : null;
  const connectedServicesAuthIntent = connectedServicesAuthRaw
    ? parseConnectedServicesLaunchAuth(connectedServicesAuthRaw)
    : undefined;
  const mcpSelection = readParsedJsonFlag(
    argv,
    '--mcp-selection-json',
    (value) => SessionMcpSelectionV1Schema.parse(value),
  );
  const terminalRaw = readFlagValue(argv, '--terminal-json');
  const terminal = terminalRaw ? parseObjectJsonFlagValue(terminalRaw, '--terminal-json') : null;
  const runtimeDescriptorRaw =
    readFlagValue(argv, '--runtime-descriptor-json')
    ?? readFlagValue(argv, '--agent-runtime-descriptor-json');
  const runtimeDescriptorV1 = runtimeDescriptorRaw
    ? RuntimeDescriptorV1Schema.parse(parseJsonFlagValue(runtimeDescriptorRaw, '--runtime-descriptor-json'))
    : null;
  const transcriptStorage = transcriptStorageRaw ? parseTranscriptStorage(transcriptStorageRaw) : null;

  return {
    json: hasFlag(argv, '--json'),
    backendRaw,
    backendTargetKey,
    spawnAttemptId,
    resumeSpawnAttempt,
    ...(connectedServicesAuthIntent ? { connectedServicesAuthIntent } : {}),
    actionInput: {
      path,
      ...(backendTargetKey ? { backendTargetKey } : {}),
      ...(backendAgentId ? { agentId: backendAgentId } : {}),
      ...(title ? { title } : {}),
      ...(tag ? { tag } : {}),
      ...(initialPrompt ? { initialMessage: initialPrompt } : {}),
      ...(modelId ? { modelId } : {}),
      ...(providerConnectionId ? { providerConnectionId } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(agentModeId ? { agentModeId } : {}),
      ...(sessionConfigOptionOverrides ? { sessionConfigOptionOverrides } : {}),
      ...(configOptions ? { configOptions } : {}),
      ...(profileId ? { profileId } : {}),
      ...(environmentVariables ? { environmentVariables } : {}),
      ...(connectedServices ? { connectedServices } : {}),
      ...(mcpSelection ? { mcpSelection } : {}),
      ...(transcriptStorage ? { transcriptStorage } : {}),
      ...(terminal ? { terminal } : {}),
      ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
      ...(host ? { host } : {}),
      ...(machineId ? { machineId } : {}),
      ...(serverId ? { serverId } : {}),
    },
  };
}
