import {
  AcpConfigOptionOverridesV1Schema,
  ConnectedServiceBindingsV1Schema,
  SessionMcpSelectionV1Schema,
  type AcpConfigOptionOverridesV1,
  type ConnectedServiceBindingsV1,
  type SessionMcpSelectionV1,
  type SpawnConfigOptionValue,
} from '@happier-dev/protocol';

import { readCommandPositionals, readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { normalizeBackendTargetKeysFromCsv } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';
import {
  parseConnectedServicesLaunchAuth,
  type ConnectedServicesLaunchAuthIntent,
} from '@/cli/connectedServicesLaunchAuth';
import { assertSessionCommandArguments } from '../shared/assertSessionCommandArguments';

/**
 * CLI argv projection only. `normalizeSessionCreateSpawnRequest` owns its
 * conversion into the strict canonical `SessionSpawnNewInputV2` Action input.
 */
export type SessionCreateSpawnRequest = Readonly<{
  directory: string;
  backendTargetKey: string | null;
  title?: string;
  initialInput?: Readonly<{ text: string }>;
  modelId?: string;
  providerConnectionId?: string;
  permissionMode?: string;
  agentModeId?: string;
  sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
  configOptions?: Readonly<Record<string, SpawnConfigOptionValue>>;
  profileId?: string;
  environmentVariables?: Readonly<Record<string, string>>;
  connectedServices?: ConnectedServiceBindingsV1;
  mcpSelection?: SessionMcpSelectionV1;
  transcriptStorage?: 'persisted' | 'direct';
  terminal?: Readonly<Record<string, unknown>>;
  machineId?: string;
  serverId?: string;
}>;

export type ParsedSessionCreateSpawnOptions = Readonly<{
  json: boolean;
  backendRaw: string;
  backendTargetKey: string | null;
  spawnAttemptId: string | null;
  resumeSpawnAttempt: boolean;
  connectedServicesAuthIntent?: ConnectedServicesLaunchAuthIntent;
  spawnRequest: SessionCreateSpawnRequest;
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

function rejectRetiredSessionCreateFlags(argv: readonly string[]): void {
  for (const raw of argv) {
    if (raw === '--') return;
    if (raw === '--host' || raw.startsWith('--host=')) {
      throw new Error(
        'Invalid session create argument: --host is no longer accepted; select the configured root server and use --machine-id.',
      );
    }
    if (raw === '--tag' || raw.startsWith('--tag=')) {
      throw new Error(
        'Invalid session create argument: --tag is no longer accepted; use --title and the returned Session id instead.',
      );
    }
    if (
      raw === '--runtime-descriptor-json'
      || raw.startsWith('--runtime-descriptor-json=')
      || raw === '--agent-runtime-descriptor-json'
      || raw.startsWith('--agent-runtime-descriptor-json=')
    ) {
      throw new Error(
        'Invalid session create argument: runtime descriptors are no longer accepted; use --agent, --model, and --mode.',
      );
    }
  }
}

export function parseSessionCreateSpawnOptions(argv: readonly string[]): ParsedSessionCreateSpawnOptions {
  rejectRetiredSessionCreateFlags(argv);
  assertSessionCommandArguments(argv, {
    usage: 'Usage: happier session create [options]',
    startIndex: 1,
    booleanFlags: ['--json', '--wait', '--follow', '--jsonl', '--resume-spawn-attempt'],
    valueFlags: [
      '--path', '--title', '--message', '--prompt', '--backend', '--agent', '--model',
      '--provider-connection', '--permission-mode', '--mode', '--launch-profile', '--profile',
      '--machine-id', '--server-id', '--spawn-attempt-id', '--transcript-storage', '--timeout',
      '--config-option', '--reasoning-effort', '--config-overrides-json', '--env', '--auth',
      '--connected-services', '--auth-json', '--connected-services-json', '--mcp-selection-json',
      '--terminal-json',
    ],
    maxPositionals: 1,
    inlineValueFlags: [
      '--path', '--title', '--message', '--prompt', '--backend', '--agent', '--model',
      '--provider-connection', '--permission-mode', '--mode', '--launch-profile', '--profile',
      '--machine-id', '--server-id', '--spawn-attempt-id', '--transcript-storage', '--timeout',
      '--reasoning-effort', '--config-overrides-json', '--auth', '--connected-services', '--auth-json',
      '--connected-services-json', '--mcp-selection-json', '--terminal-json',
    ],
  });
  if (readFlagValue(argv, '--timeout') !== null && !hasFlag(argv, '--wait')) {
    throw Object.assign(new Error('--timeout requires --wait.'), { code: 'invalid_arguments' });
  }
  const [positionalInitialPrompt = ''] = readCommandPositionals(argv, {
    startIndex: 1,
    valueFlags: [
      '--path', '--title', '--message', '--prompt', '--backend', '--agent', '--model',
      '--provider-connection', '--permission-mode', '--mode', '--launch-profile', '--profile',
      '--machine-id', '--server-id', '--spawn-attempt-id', '--transcript-storage',
      '--timeout',
      '--config-option', '--reasoning-effort', '--config-overrides-json', '--env', '--auth',
      '--connected-services', '--auth-json', '--connected-services-json', '--mcp-selection-json',
      '--terminal-json',
    ],
  });
  const path = resolveRequestedSessionDirectory({
    requestedDirectory: readFlagValue(argv, '--path') ?? null,
  });
  const title = (readFlagValue(argv, '--title') ?? '').trim();
  const flagInitialPrompt = (readFlagValue(argv, '--message') ?? readFlagValue(argv, '--prompt') ?? '').trim();
  if (flagInitialPrompt && positionalInitialPrompt) {
    throw new Error('Choose only one of a positional prompt, --message, or --prompt.');
  }
  const initialPrompt = flagInitialPrompt || positionalInitialPrompt;
  const backendRaw = (readFlagValue(argv, '--backend') ?? readFlagValue(argv, '--agent') ?? '').trim();
  const backendTargetKeys = normalizeBackendTargetKeysFromCsv(backendRaw);
  const backendTargetKey = backendTargetKeys.length === 1 ? backendTargetKeys[0] : null;
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
  const transcriptStorage = transcriptStorageRaw ? parseTranscriptStorage(transcriptStorageRaw) : null;

  return {
    json: hasFlag(argv, '--json'),
    backendRaw,
    backendTargetKey,
    spawnAttemptId,
    resumeSpawnAttempt,
    ...(connectedServicesAuthIntent ? { connectedServicesAuthIntent } : {}),
    spawnRequest: {
      directory: path,
      backendTargetKey,
      ...(title ? { title } : {}),
      ...(initialPrompt ? { initialInput: { text: initialPrompt } } : {}),
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
      ...(machineId ? { machineId } : {}),
      ...(serverId ? { serverId } : {}),
    },
  };
}
