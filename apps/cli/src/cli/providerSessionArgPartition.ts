import chalk from 'chalk';

import type { AgentId } from '@happier-dev/agents';
import { PERMISSION_INTENTS, parsePermissionIntentAlias } from '@happier-dev/agents';
import {
  deserializeSessionCreationCorrespondenceV1,
  deserializeSessionModelSelectionV1,
  ProviderConnectionIdSchema,
  SessionCreationTagV1Schema,
  type SessionCreationCorrespondenceV1,
  type SessionModelSelectionV1,
} from '@happier-dev/protocol';

import { isPermissionMode, type PermissionMode } from '@/api/types';
import {
  deserializeNativeForkSourceV1,
  type NativeForkSource,
} from '@/session/shared/spawnSessionContract';

/**
 * Partitions raw provider command arguments into Happier-owned session options
 * and provider-native passthrough arguments. This module is pure parsing only:
 * it performs no I/O beyond existing CLI error reporting and exits on invalid
 * Happier-owned values so callers do not launch sessions with ambiguous state.
 */
export interface ProviderSessionArgPartitionResult {
  readonly startedBy: 'daemon' | 'terminal' | undefined;
  readonly refreshSettings: boolean;
  readonly profileQuery: string | undefined;
  readonly connectedServicesAuthRaw: string | undefined;
  readonly connectedServicesAuthJsonRaw: string | undefined;
  readonly permissionMode: PermissionMode | undefined;
  readonly permissionModeUpdatedAt: number | undefined;
  readonly sessionModeId: string | undefined;
  readonly sessionModeUpdatedAt: number | undefined;
  readonly modelId: string | undefined;
  readonly providerConnectionId: string | undefined;
  readonly modelUpdatedAt: number | undefined;
  readonly modelSelection: SessionModelSelectionV1 | undefined;
  readonly existingSessionId: string | undefined;
  readonly resume: string | undefined;
  readonly nativeForkSource: NativeForkSource | undefined;
  /** Daemon-to-runner carrier; never forwarded to a provider CLI. */
  readonly sessionCreationTag: string | undefined;
  /** Daemon-to-runner immutable create-or-rejoin recipe; never provider passthrough. */
  readonly sessionCreationCorrespondence: SessionCreationCorrespondenceV1 | undefined;
  /** Daemon-to-runner mutable title for a fresh canonical Session create. */
  readonly initialTitle: string | undefined;
  readonly startingMode: string | undefined;
  readonly directory: string | undefined;
  readonly providerArgs: string[];
  readonly helpRequested: boolean;
  readonly versionRequested: boolean;
  readonly versionFlag: string | undefined;
}

export interface ProviderSessionArgPartitionOptions {
  readonly args: readonly string[];
  readonly providerSubcommand?: AgentId | string | null;
  readonly directoryFlags?: readonly string[];
  readonly forwardModelFlag?: boolean;
  readonly forwardResumeFlag?: boolean;
  readonly yoloProviderArgs?: readonly string[];
  readonly versionFlags?: readonly string[];
}

const HELP_FLAGS = new Set(['-h', '--help']);
const DEFAULT_VERSION_FLAGS = ['-v', '--version'] as const;

const PERMISSION_MODE_EXAMPLES = [
  '--permission-mode read-only',
  '--permission-mode yolo',
  '--permission-mode accept-edits',
] as const;

function parsePermissionModeAlias(raw: string): PermissionMode | null {
  const parsed = parsePermissionIntentAlias(raw);
  return parsed && isPermissionMode(parsed) ? parsed : null;
}

function exitWithMissingValue(flag: string, expected: string): never {
  console.error(chalk.red(`Missing value for ${flag} (expected: ${expected})`));
  process.exit(1);
}

function readRequiredNext(args: readonly string[], index: number, flag: string, expected: string): string {
  const next = args[index + 1];
  if (typeof next !== 'string' || next.startsWith('-')) {
    exitWithMissingValue(flag, expected);
  }
  return next;
}

function parsePositiveTimestamp(raw: string, flag: string): number {
  const parsedAt = Number(raw);
  if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
    console.error(chalk.red(`Invalid ${flag} value: ${raw}. Expected a positive number (unix ms)`));
    process.exit(1);
  }
  return Math.floor(parsedAt);
}

function splitEqualsFlag(raw: string): { flag: string; value: string } | null {
  if (!raw.startsWith('--')) return null;
  const equalsIndex = raw.indexOf('=');
  if (equalsIndex <= 2) return null;
  return {
    flag: raw.slice(0, equalsIndex),
    value: raw.slice(equalsIndex + 1),
  };
}

function normalizeOptionalValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOptionalFlagValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.startsWith('-')) return undefined;
  return normalizeOptionalValue(raw);
}

export function partitionProviderSessionArgs(
  opts: ProviderSessionArgPartitionOptions,
): ProviderSessionArgPartitionResult {
  const input =
    opts.providerSubcommand && opts.args[0] === opts.providerSubcommand
      ? opts.args.slice(1)
      : [...opts.args];
  const directoryFlags = new Set(opts.directoryFlags ?? []);
  const versionFlags = new Set(opts.versionFlags ?? DEFAULT_VERSION_FLAGS);

  let startedBy: 'daemon' | 'terminal' | undefined;
  let refreshSettings = false;
  let profileQuery: string | undefined;
  let connectedServicesAuthRaw: string | undefined;
  let connectedServicesAuthJsonRaw: string | undefined;
  let permissionMode: PermissionMode | undefined;
  let permissionModeUpdatedAt: number | undefined;
  let sessionModeId: string | undefined;
  let sessionModeUpdatedAt: number | undefined;
  let modelId: string | undefined;
  let providerConnectionId: string | undefined;
  let modelUpdatedAt: number | undefined;
  let modelSelection: SessionModelSelectionV1 | undefined;
  let existingSessionId: string | undefined;
  let resume: string | undefined;
  let nativeForkSource: NativeForkSource | undefined;
  let sessionCreationTag: string | undefined;
  let sessionCreationCorrespondence: SessionCreationCorrespondenceV1 | undefined;
  let initialTitle: string | undefined;
  let startingMode: string | undefined;
  let directory: string | undefined;
  let helpRequested = false;
  let versionFlag: string | undefined;
  const providerArgs: string[] = [];

  for (let i = 0; i < input.length; i += 1) {
    const arg = input[i];
    const equals = splitEqualsFlag(arg);
    const flag = equals?.flag ?? arg;
    const equalsValue = equals?.value;

    if (HELP_FLAGS.has(arg)) {
      helpRequested = true;
      providerArgs.push(arg);
      continue;
    }
    if (versionFlags.has(arg)) {
      versionFlag = arg;
      providerArgs.push(arg);
      continue;
    }

    if (arg === '--refresh-settings') {
      refreshSettings = true;
      continue;
    }

    if (arg === '--yolo') {
      permissionMode = 'yolo';
      providerArgs.push(...(opts.yoloProviderArgs ?? []));
      continue;
    }

    if (flag === '--started-by') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--started-by', 'daemon|terminal');
      if (!equalsValue) i += 1;
      if (raw !== 'daemon' && raw !== 'terminal') {
        console.error(chalk.red(`Invalid --started-by value: ${raw}. Expected: daemon|terminal`));
        process.exit(1);
      }
      startedBy = raw;
      continue;
    }

    if (flag === '--profile' || flag === '--launch-profile') {
      const raw = equalsValue ?? input[i + 1];
      if (!equalsValue && typeof raw === 'string' && !raw.startsWith('-')) i += 1;
      profileQuery = equalsValue !== undefined ? normalizeOptionalValue(raw) : normalizeOptionalFlagValue(raw);
      continue;
    }

    if (flag === '--auth' || flag === '--connected-services') {
      if (connectedServicesAuthRaw !== undefined) {
        console.error(chalk.red('Choose only one of --auth or --connected-services.'));
        process.exit(1);
      }
      const raw = equalsValue ?? readRequiredNext(input, i, flag, 'default|native|cs:<id>');
      if (equalsValue === undefined) i += 1;
      connectedServicesAuthRaw = normalizeOptionalValue(raw) ?? exitWithMissingValue(flag, 'default|native|cs:<id>');
      continue;
    }

    if (flag === '--auth-json' || flag === '--connected-services-json') {
      if (connectedServicesAuthJsonRaw !== undefined) {
        console.error(chalk.red('Choose only one of --auth-json or --connected-services-json.'));
        process.exit(1);
      }
      const raw = equalsValue ?? readRequiredNext(input, i, flag, 'ConnectedServiceBindingsV1 JSON');
      if (equalsValue === undefined) i += 1;
      connectedServicesAuthJsonRaw = normalizeOptionalValue(raw) ?? exitWithMissingValue(flag, 'ConnectedServiceBindingsV1 JSON');
      continue;
    }

    if (flag === '--permission-mode') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--permission-mode', PERMISSION_INTENTS.join('|'));
      if (!equalsValue) i += 1;
      const parsed = parsePermissionModeAlias(raw);
      if (!parsed) {
        console.error(
          chalk.red(
            `Invalid --permission-mode value: ${raw}. Valid values: ${PERMISSION_INTENTS.join(', ')}. Examples: ${PERMISSION_MODE_EXAMPLES.join(
              ' | ',
            )}`,
          ),
        );
        process.exit(1);
      }
      permissionMode = parsed;
      continue;
    }

    if (flag === '--permission-mode-updated-at') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--permission-mode-updated-at', 'unix ms timestamp');
      if (!equalsValue) i += 1;
      permissionModeUpdatedAt = parsePositiveTimestamp(raw, '--permission-mode-updated-at');
      continue;
    }

    if (flag === '--agent-mode') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--agent-mode', 'ACP session mode id');
      if (!equalsValue) i += 1;
      const normalized = normalizeOptionalValue(raw);
      if (!normalized) {
        console.error(chalk.red('Invalid --agent-mode value: empty'));
        process.exit(1);
      }
      sessionModeId = normalized;
      continue;
    }

    if (flag === '--agent-mode-updated-at') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--agent-mode-updated-at', 'unix ms timestamp');
      if (!equalsValue) i += 1;
      sessionModeUpdatedAt = parsePositiveTimestamp(raw, '--agent-mode-updated-at');
      continue;
    }

    if (flag === '--model') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--model', 'model id');
      if (!equalsValue) i += 1;
      const normalized = normalizeOptionalValue(raw);
      if (!normalized) {
        console.error(chalk.red('Invalid --model value: empty'));
        process.exit(1);
      }
      modelId = normalized;
      if (opts.forwardModelFlag) {
        if (equalsValue !== undefined) {
          providerArgs.push(arg);
        } else {
          providerArgs.push(arg, raw);
        }
      }
      continue;
    }

    if (flag === '--model-updated-at') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--model-updated-at', 'unix ms timestamp');
      if (!equalsValue) i += 1;
      modelUpdatedAt = parsePositiveTimestamp(raw, '--model-updated-at');
      continue;
    }

    if (flag === '--provider-connection') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--provider-connection', 'provider connection id');
      if (!equalsValue) i += 1;
      const parsed = ProviderConnectionIdSchema.safeParse(raw);
      if (!parsed.success) {
        console.error(chalk.red('Invalid --provider-connection value'));
        process.exit(1);
      }
      providerConnectionId = parsed.data;
      continue;
    }

    if (flag === '--model-selection-v1') {
      const raw = equalsValue ?? readRequiredNext(input, i, '--model-selection-v1', 'base64url model selection');
      if (!equalsValue) i += 1;
      try {
        modelSelection = deserializeSessionModelSelectionV1(raw);
      } catch {
        console.error(chalk.red('Invalid --model-selection-v1 value: expected canonical base64url model selection'));
        process.exit(1);
      }
      continue;
    }

    if (flag === '--existing-session') {
      const raw = equalsValue ?? input[i + 1];
      if (!equalsValue && typeof raw === 'string' && !raw.startsWith('-')) i += 1;
      existingSessionId = equalsValue !== undefined ? normalizeOptionalValue(raw) : normalizeOptionalFlagValue(raw);
      continue;
    }

    if (flag === '--resume' || arg === '-r') {
      const raw = equalsValue ?? input[i + 1];
      const hasValue = typeof raw === 'string' && !raw.startsWith('-');
      if (!equalsValue && hasValue) i += 1;
      resume = equalsValue !== undefined ? normalizeOptionalValue(raw) : normalizeOptionalFlagValue(raw);
      if (opts.forwardResumeFlag) {
        if (equalsValue !== undefined) {
          providerArgs.push(arg);
        } else if (hasValue) {
          providerArgs.push(arg, raw);
        } else {
          providerArgs.push(arg);
        }
      }
      continue;
    }

    if (flag === '--native-fork-source-v1') {
      if (nativeForkSource) {
        console.error(chalk.red('--native-fork-source-v1 may only be provided once'));
        process.exit(1);
      }
      const raw = equalsValue ?? readRequiredNext(
        input,
        i,
        '--native-fork-source-v1',
        'canonical native fork source',
      );
      if (!equalsValue) i += 1;
      try {
        nativeForkSource = deserializeNativeForkSourceV1(raw);
      } catch {
        console.error(chalk.red('Invalid --native-fork-source-v1 value'));
        process.exit(1);
      }
      continue;
    }

    if (flag === '--session-creation-tag-v1') {
      if (sessionCreationTag !== undefined) {
        console.error(chalk.red('--session-creation-tag-v1 may only be provided once'));
        process.exit(1);
      }
      const raw = equalsValue ?? readRequiredNext(
        input,
        i,
        '--session-creation-tag-v1',
        'canonical Session creation tag',
      );
      if (!equalsValue) i += 1;
      const parsed = SessionCreationTagV1Schema.safeParse(raw);
      if (!parsed.success) {
        console.error(chalk.red('Invalid --session-creation-tag-v1 value'));
        process.exit(1);
      }
      sessionCreationTag = parsed.data;
      continue;
    }

    if (flag === '--session-creation-correspondence-v1') {
      if (sessionCreationCorrespondence !== undefined) {
        console.error(chalk.red('--session-creation-correspondence-v1 may only be provided once'));
        process.exit(1);
      }
      const raw = equalsValue ?? readRequiredNext(
        input,
        i,
        '--session-creation-correspondence-v1',
        'canonical Session creation correspondence',
      );
      if (!equalsValue) i += 1;
      try {
        sessionCreationCorrespondence = deserializeSessionCreationCorrespondenceV1(raw);
      } catch {
        console.error(chalk.red('Invalid --session-creation-correspondence-v1 value'));
        process.exit(1);
      }
      continue;
    }

    if (flag === '--session-initial-title-v1') {
      if (initialTitle !== undefined) {
        console.error(chalk.red('--session-initial-title-v1 may only be provided once'));
        process.exit(1);
      }
      const raw = equalsValue ?? input[i + 1];
      if (!equalsValue) i += 1;
      const normalized = normalizeOptionalValue(raw);
      if (!normalized) {
        console.error(chalk.red('Invalid --session-initial-title-v1 value'));
        process.exit(1);
      }
      initialTitle = normalized;
      continue;
    }

    if (flag === '--happy-starting-mode') {
      const raw = equalsValue ?? input[i + 1];
      if (!equalsValue && typeof raw === 'string' && !raw.startsWith('-')) i += 1;
      startingMode = equalsValue !== undefined ? normalizeOptionalValue(raw) : normalizeOptionalFlagValue(raw);
      continue;
    }

    if (flag === '--account-settings-version-hint') {
      const raw = equalsValue ?? input[i + 1];
      if (!equalsValue && typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) i += 1;
      continue;
    }

    if (directoryFlags.has(flag) || directoryFlags.has(arg)) {
      const raw = equalsValue ?? input[i + 1];
      if (!equalsValue && typeof raw === 'string' && !raw.startsWith('-')) i += 1;
      directory = (equalsValue !== undefined ? normalizeOptionalValue(raw) : normalizeOptionalFlagValue(raw)) ?? directory;
      continue;
    }

    providerArgs.push(arg);
  }

  if (providerConnectionId && !modelId) {
    console.error(chalk.red('--provider-connection requires --model'));
    process.exit(1);
  }
  if (providerConnectionId && modelSelection) {
    console.error(chalk.red('--provider-connection cannot be combined with --model-selection-v1'));
    process.exit(1);
  }
  if (connectedServicesAuthRaw !== undefined && connectedServicesAuthJsonRaw !== undefined) {
    console.error(chalk.red('Choose only one connected-services auth option.'));
    process.exit(1);
  }
  if (nativeForkSource && resume) {
    console.error(chalk.red('--native-fork-source-v1 cannot be combined with --resume'));
    process.exit(1);
  }
  if (sessionCreationTag && startedBy !== 'daemon') {
    console.error(chalk.red('--session-creation-tag-v1 is only valid for daemon-started runners'));
    process.exit(1);
  }
  if (sessionCreationCorrespondence && startedBy !== 'daemon') {
    console.error(chalk.red('--session-creation-correspondence-v1 is only valid for daemon-started runners'));
    process.exit(1);
  }
  if (initialTitle && startedBy !== 'daemon') {
    console.error(chalk.red('--session-initial-title-v1 is only valid for daemon-started runners'));
    process.exit(1);
  }
  if (
    sessionCreationCorrespondence
    && sessionCreationCorrespondence.sessionCreationTag !== sessionCreationTag
  ) {
    console.error(chalk.red('--session-creation-correspondence-v1 requires its matching --session-creation-tag-v1'));
    process.exit(1);
  }
  return {
    startedBy,
    refreshSettings,
    profileQuery,
    connectedServicesAuthRaw,
    connectedServicesAuthJsonRaw,
    permissionMode,
    permissionModeUpdatedAt,
    sessionModeId,
    sessionModeUpdatedAt,
    modelId,
    providerConnectionId,
    modelUpdatedAt,
    modelSelection,
    existingSessionId,
    resume,
    nativeForkSource,
    sessionCreationTag,
    sessionCreationCorrespondence,
    initialTitle,
    startingMode,
    directory,
    providerArgs,
    helpRequested,
    versionRequested: typeof versionFlag === 'string',
    versionFlag,
  };
}
