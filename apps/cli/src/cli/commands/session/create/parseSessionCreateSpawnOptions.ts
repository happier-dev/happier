import {
  AcpConfigOptionOverridesV1Schema,
  AgentRuntimeDescriptorV1Schema,
  ConnectedServiceBindingsV1Schema,
  SESSION_PERMISSION_MODES,
  SessionMcpSelectionV1Schema,
  parseSessionPermissionModeAlias,
  type SpawnConfigOptionValue,
} from '@happier-dev/protocol';
import { readNonBlankSessionControlIdentifier } from '@/agent/runtime/sessionControlIdentifiers';

import { DEFAULT_CATALOG_AGENT_ID } from '@/backends/types';
import { readFlagValue, hasFlag } from '@/cli/commands/shared/argvFlags';
import { normalizeBackendTargetKeysFromCsv } from '@/cli/commands/session/shared/normalizeBackendTargetKeys';
import { resolveRequestedSessionDirectory } from '@/agent/runtime/resolveRequestedSessionDirectory';
import {
  parseConnectedServicesLaunchAuth,
  type ConnectedServicesLaunchAuthIntent,
} from '@/cli/connectedServicesLaunchAuth';

export type SessionCreateSpawnActionInput = Record<string, unknown>;

export type ParsedSessionCreateSpawnOptions = Readonly<{
  backendRaw: string;
  backendTargetKey: string | null;
  spawnAttemptId: string | null;
  resumeSpawnAttempt: boolean;
  connectedServicesAuthIntent?: ConnectedServicesLaunchAuthIntent;
  actionInput: SessionCreateSpawnActionInput;
}>;

export const SESSION_CREATE_USAGE = [
  'happier session create [options]',
  '',
  'Options:',
  '  [--path <path>] [--backend <backend-target>]',
  '  [--title <title>] [--tag <tag>]',
  '  [--prompt <text>|--message <text>]',
  `  [--model <model-id>] [--permission-mode <${SESSION_PERMISSION_MODES.join('|')}>]`,
  '    Aliases include read_only, ro, safe, full-access, accept-edits, and bypass-permissions.',
  '  [--mode <agent-mode-id>] [--config-option <id=value>]',
  '  [--reasoning-effort <value>] [--ultracode]',
  '  [--config-overrides-json <json>] [--launch-profile <profile-id>]',
  '  [--env <KEY=VALUE>]',
  '  [--auth <default|native|cs:<id>>|--connected-services <selector>|--auth-json <json>]',
  '  [--mcp-selection-json <json>] [--transcript-storage <persisted|direct>]',
  '  [--terminal-json <json>] [--codex-backend-mode <mcp|acp|appServer>]',
  '  [--runtime-descriptor-json <json>|--agent-runtime-descriptor-json <json>]',
  '  [--host <host>] [--machine-id <machineId>]',
  '  [--spawn-attempt-id <id>] [--resume-spawn-attempt]',
  '  [--json]',
].join('\n');

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

function readRepeatedOpaqueFlagValues(argv: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== flag) continue;
    const raw = argv[index + 1];
    if (typeof raw === 'string' && raw.trim().length > 0) values.push(raw);
  }
  return values;
}

function readOpaqueFlagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.findIndex((value) => value === flag);
  if (index < 0) return null;
  const raw = argv[index + 1];
  return readNonBlankSessionControlIdentifier(raw);
}

function parseConfigOptionValue(raw: string): SpawnConfigOptionValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return raw;
}

function parseConfigOptionFlag(raw: string): Readonly<{ id: string; value: SpawnConfigOptionValue }> {
  const separatorIndex = raw.indexOf('=');
  if (separatorIndex <= 0) {
    throw new Error('Invalid --config-option. Expected <id=value>.');
  }
  const id = raw.slice(0, separatorIndex);
  if (!readNonBlankSessionControlIdentifier(id)) {
    throw new Error('Invalid --config-option. Expected <id=value>.');
  }
  return {
    id,
    value: parseConfigOptionValue(raw.slice(separatorIndex + 1)),
  };
}

function parseJsonFlagValue(raw: string, flag: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ${flag}.`);
  }
}

function parseObjectJsonFlagValue(raw: string, flag: string): Record<string, unknown> {
  const parsed = parseJsonFlagValue(raw, flag);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid ${flag}.`);
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

function parseCodexBackendMode(raw: string): 'mcp' | 'acp' | 'appServer' {
  if (raw === 'mcp' || raw === 'acp' || raw === 'appServer') return raw;
  throw new Error('Invalid --codex-backend-mode.');
}

function parseConfigOptions(argv: readonly string[]): Record<string, SpawnConfigOptionValue> | null {
  const configOptions: Record<string, SpawnConfigOptionValue> = {};
  for (const raw of readRepeatedOpaqueFlagValues(argv, '--config-option')) {
    const parsed = parseConfigOptionFlag(raw);
    configOptions[parsed.id] = parsed.value;
  }

  const reasoningEffort = readOpaqueFlagValue(argv, '--reasoning-effort');
  if (reasoningEffort !== null) {
    configOptions.reasoning_effort = reasoningEffort;
  }

  if (hasFlag(argv, '--ultracode')) {
    configOptions.ultracode = true;
  }

  return Object.keys(configOptions).length > 0 ? configOptions : null;
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
  const modelId = readOpaqueFlagValue(argv, '--model') ?? '';
  const permissionModeRaw = (readFlagValue(argv, '--permission-mode') ?? '').trim();
  const permissionMode = permissionModeRaw ? parseSessionPermissionModeAlias(permissionModeRaw) : null;
  if (permissionModeRaw && !permissionMode) {
    throw new Error(
      `Invalid --permission-mode "${permissionModeRaw}". Expected one of: ${SESSION_PERMISSION_MODES.join(', ')}.`,
    );
  }
  const agentModeId = readOpaqueFlagValue(argv, '--mode') ?? '';
  const launchProfileId = readFlagValue(argv, '--launch-profile');
  const legacyProfileId = readFlagValue(argv, '--profile');
  if (launchProfileId !== null && legacyProfileId !== null) {
    throw new Error('Choose only one of --launch-profile or --profile.');
  }
  const profileId = (launchProfileId ?? legacyProfileId ?? '').trim();
  const host = (readFlagValue(argv, '--host') ?? '').trim();
  const machineId = (readFlagValue(argv, '--machine-id') ?? '').trim();
  const spawnAttemptId = (readFlagValue(argv, '--spawn-attempt-id') ?? '').trim() || null;
  if (spawnAttemptId && (spawnAttemptId.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(spawnAttemptId))) {
    throw new Error('Invalid --spawn-attempt-id.');
  }
  const resumeSpawnAttempt = hasFlag(argv, '--resume-spawn-attempt');
  if (resumeSpawnAttempt && !spawnAttemptId) {
    throw new Error('Invalid --resume-spawn-attempt without --spawn-attempt-id.');
  }
  const transcriptStorageRaw = (readFlagValue(argv, '--transcript-storage') ?? '').trim();
  const codexBackendModeRaw = (readFlagValue(argv, '--codex-backend-mode') ?? '').trim();
  const sessionConfigOptionOverrides = readParsedJsonFlag(
    argv,
    '--config-overrides-json',
    (value) => AcpConfigOptionOverridesV1Schema.parse(value),
  );
  const configOptions = parseConfigOptions(argv);
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
  const agentRuntimeDescriptorRaw =
    readFlagValue(argv, '--agent-runtime-descriptor-json')
    ?? readFlagValue(argv, '--runtime-descriptor-json');
  const agentRuntimeDescriptorV1 = agentRuntimeDescriptorRaw
    ? AgentRuntimeDescriptorV1Schema.parse(parseJsonFlagValue(agentRuntimeDescriptorRaw, '--agent-runtime-descriptor-json'))
    : null;
  const transcriptStorage = transcriptStorageRaw ? parseTranscriptStorage(transcriptStorageRaw) : null;
  const codexBackendMode = codexBackendModeRaw ? parseCodexBackendMode(codexBackendModeRaw) : null;

  return {
    backendRaw,
    backendTargetKey,
    spawnAttemptId,
    resumeSpawnAttempt,
    ...(connectedServicesAuthIntent ? { connectedServicesAuthIntent } : {}),
    actionInput: {
      path,
      ...(backendTargetKey ? { backendTargetKey } : { agentId: DEFAULT_CATALOG_AGENT_ID }),
      ...(title ? { title } : {}),
      ...(tag ? { tag } : {}),
      ...(initialPrompt ? { initialMessage: initialPrompt } : {}),
      ...(modelId ? { modelId } : {}),
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
      ...(codexBackendMode ? { codexBackendMode } : {}),
      ...(agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1 } : {}),
      ...(host ? { host } : {}),
      ...(machineId ? { machineId } : {}),
    },
  };
}
