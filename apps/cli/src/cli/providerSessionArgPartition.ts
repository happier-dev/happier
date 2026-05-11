/**
 * Partitions Happier-owned session flags from provider-native CLI arguments.
 *
 * The parser validates shared session metadata such as permission modes,
 * profiles, model hints, resume flags, and provider-specific aliases, then
 * leaves unrecognized tokens in providerArgs for the provider executable.
 * Invalid Happier-owned values use the CLI failure path so provider wrappers
 * stop before launching a session with ambiguous intent.
 */
import chalk from 'chalk';

import { isPermissionMode, type PermissionMode } from '@/api/types';
import {
  PERMISSION_INTENTS,
  parsePermissionModeAlias as parsePermissionModeAliasShared,
} from '@happier-dev/agents';

export interface ProviderSessionArgPartitionResult {
  readonly startedBy?: 'daemon' | 'terminal';
  readonly refreshSettings: boolean;
  readonly profileQuery?: string;
  readonly permissionMode?: PermissionMode;
  readonly permissionModeUpdatedAt?: number;
  readonly agentModeId?: string;
  readonly agentModeUpdatedAt?: number;
  readonly modelId?: string;
  readonly modelUpdatedAt?: number;
  readonly existingSessionId?: string;
  readonly resume?: string;
  readonly startingMode?: 'local' | 'remote' | string;
  readonly directory?: string;
  readonly providerArgs: string[];
  readonly helpRequested: boolean;
  readonly versionRequested: boolean;
  readonly versionFlag?: string;
}

export interface ProviderSessionArgPartitionOptions {
  readonly args: readonly string[];
  readonly providerSubcommand?: string | null;
  readonly directoryFlags?: readonly string[];
  readonly forwardModelFlag?: boolean;
  readonly forwardResumeFlag?: boolean;
  readonly yoloProviderArgs?: readonly string[];
  readonly versionFlags?: readonly string[];
}

const PERMISSION_MODE_EXAMPLES = [
  '--permission-mode read-only',
  '--permission-mode yolo',
  '--permission-mode accept-edits',
] as const;

function parsePermissionModeAlias(raw: string): PermissionMode | null {
  const parsed = parsePermissionModeAliasShared(raw);
  if (!parsed) return null;
  return isPermissionMode(parsed) ? parsed : null;
}

function fail(message: string): never {
  console.error(chalk.red(message));
  process.exit(1);
}

function readRequiredValue(args: readonly string[], index: number, label: string): string {
  if (index + 1 >= args.length) {
    fail(`Missing value for ${label}`);
  }
  const value = args[index + 1];
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) {
    fail(`Missing value for ${label}`);
  }
  return value;
}

function isNumericOptionValue(value: string | undefined): boolean {
  return typeof value === 'string' && /^-?\d+$/.test(value.trim());
}

function readOptionalValue(args: readonly string[], index: number): string | undefined {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) return undefined;
  return value;
}

export function partitionProviderSessionArgs(options: ProviderSessionArgPartitionOptions): ProviderSessionArgPartitionResult {
  const args = [...options.args];
  if (options.providerSubcommand && args[0] === options.providerSubcommand) {
    args.shift();
  }

  let startedBy: 'daemon' | 'terminal' | undefined;
  let refreshSettings = false;
  let profileQuery: string | undefined;
  let permissionMode: PermissionMode | undefined;
  let permissionModeUpdatedAt: number | undefined;
  let agentModeId: string | undefined;
  let agentModeUpdatedAt: number | undefined;
  let modelId: string | undefined;
  let modelUpdatedAt: number | undefined;
  let existingSessionId: string | undefined;
  let resume: string | undefined;
  let startingMode: 'local' | 'remote' | string | undefined;
  let directory: string | undefined;
  let helpRequested = false;
  let versionRequested = false;
  let versionFlag: string | undefined;
  const providerArgs: string[] = [];
  const directoryFlags = new Set(options.directoryFlags ?? []);
  const versionFlags = new Set(options.versionFlags ?? ['-v', '--version']);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      helpRequested = true;
      continue;
    }
    if (versionFlags.has(arg)) {
      versionRequested = true;
      versionFlag = arg;
      continue;
    }
    if (arg === '--refresh-settings') {
      refreshSettings = true;
      continue;
    }
    if (arg === '--profile') {
      const raw = readRequiredValue(args, i, '--profile (expected: profile id or name)');
      const normalized = raw.trim();
      if (!normalized) fail('Invalid --profile value: empty');
      profileQuery = normalized;
      i += 1;
      continue;
    }
    if (arg.startsWith('--profile=')) {
      const normalized = arg.slice('--profile='.length).trim();
      if (!normalized) fail('Invalid --profile value: empty');
      profileQuery = normalized;
      continue;
    }
    if (arg === '--happy-starting-mode') {
      startingMode = readRequiredValue(args, i, '--happy-starting-mode');
      i += 1;
      continue;
    }
    if (arg === '--started-by') {
      const value = readRequiredValue(args, i, '--started-by (expected: daemon|terminal)');
      if (value !== 'daemon' && value !== 'terminal') {
        fail(`Invalid --started-by value: ${value}. Expected: daemon|terminal`);
      }
      startedBy = value;
      i += 1;
      continue;
    }
    if (arg === '--permission-mode') {
      const value = readRequiredValue(
        args,
        i,
        `--permission-mode. Valid values: ${PERMISSION_INTENTS.join(', ')}. Examples: ${PERMISSION_MODE_EXAMPLES.join(' | ')}`,
      );
      const parsed = parsePermissionModeAlias(value);
      if (!parsed) {
        fail(
          `Invalid --permission-mode value: ${value}. Valid values: ${PERMISSION_INTENTS.join(', ')}. Examples: ${PERMISSION_MODE_EXAMPLES.join(' | ')}`,
        );
      }
      permissionMode = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--permission-mode=')) {
      const value = arg.slice('--permission-mode='.length).trim();
      if (!value) {
        fail(`Missing value for --permission-mode. Valid values: ${PERMISSION_INTENTS.join(', ')}`);
      }
      const parsed = parsePermissionModeAlias(value);
      if (!parsed) {
        fail(
          `Invalid --permission-mode value: ${value}. Valid values: ${PERMISSION_INTENTS.join(', ')}. Examples: ${PERMISSION_MODE_EXAMPLES.join(' | ')}`,
        );
      }
      permissionMode = parsed;
      continue;
    }
    if (arg === '--permission-mode-updated-at') {
      const raw = readRequiredValue(args, i, '--permission-mode-updated-at (expected: unix ms timestamp)');
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        fail(`Invalid --permission-mode-updated-at value: ${raw}. Expected a positive number (unix ms)`);
      }
      permissionModeUpdatedAt = Math.floor(parsedAt);
      i += 1;
      continue;
    }
    if (arg === '--agent-mode') {
      const raw = readRequiredValue(args, i, '--agent-mode (expected: ACP session mode id)');
      const normalized = raw.trim();
      if (!normalized) fail('Invalid --agent-mode value: empty');
      agentModeId = normalized;
      i += 1;
      continue;
    }
    if (arg === '--agent-mode-updated-at') {
      const raw = readRequiredValue(args, i, '--agent-mode-updated-at (expected: unix ms timestamp)');
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        fail(`Invalid --agent-mode-updated-at value: ${raw}. Expected a positive number (unix ms)`);
      }
      agentModeUpdatedAt = Math.floor(parsedAt);
      i += 1;
      continue;
    }
    if (arg === '--model') {
      const raw = readRequiredValue(args, i, '--model (expected: model id)');
      const normalized = raw.trim();
      if (!normalized) fail('Invalid --model value: empty');
      modelId = normalized;
      if (options.forwardModelFlag) {
        providerArgs.push(arg, normalized);
      }
      i += 1;
      continue;
    }
    if (arg === '--model-updated-at') {
      const raw = readRequiredValue(args, i, '--model-updated-at (expected: unix ms timestamp)');
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        fail(`Invalid --model-updated-at value: ${raw}. Expected a positive number (unix ms)`);
      }
      modelUpdatedAt = Math.floor(parsedAt);
      i += 1;
      continue;
    }
    if (arg === '--account-settings-version-hint') {
      if (isNumericOptionValue(args[i + 1])) {
        i += 1;
      }
      continue;
    }
    if (arg === '--existing-session') {
      const value = readOptionalValue(args, i);
      if (value) {
        existingSessionId = value;
        i += 1;
      }
      continue;
    }
    if (arg === '--resume' || arg === '-r') {
      const value = readOptionalValue(args, i);
      if (options.forwardResumeFlag) {
        providerArgs.push(arg);
      }
      if (value) {
        resume = value;
        if (options.forwardResumeFlag) {
          providerArgs.push(value);
        }
        i += 1;
      }
      continue;
    }
    if (arg === '--yolo') {
      permissionMode = 'yolo';
      if (options.yoloProviderArgs) {
        providerArgs.push(...options.yoloProviderArgs);
      }
      continue;
    }
    if (directoryFlags.has(arg)) {
      const value = readOptionalValue(args, i);
      if (value) {
        directory = value.trim() || undefined;
        i += 1;
      }
      continue;
    }

    providerArgs.push(arg);
  }

  return {
    ...(startedBy ? { startedBy } : {}),
    refreshSettings,
    ...(profileQuery ? { profileQuery } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(typeof permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt } : {}),
    ...(agentModeId ? { agentModeId } : {}),
    ...(typeof agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt } : {}),
    ...(modelId ? { modelId } : {}),
    ...(typeof modelUpdatedAt === 'number' ? { modelUpdatedAt } : {}),
    ...(existingSessionId ? { existingSessionId } : {}),
    ...(resume ? { resume } : {}),
    ...(startingMode ? { startingMode } : {}),
    ...(directory ? { directory } : {}),
    helpRequested,
    versionRequested,
    ...(versionFlag ? { versionFlag } : {}),
    providerArgs,
  };
}
