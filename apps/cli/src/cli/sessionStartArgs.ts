import chalk from 'chalk';
import { isPermissionMode, type PermissionMode } from '@/api/types';
import {
  PERMISSION_INTENTS,
  getAgentSessionModesKind,
  parsePermissionIntentAlias as parsePermissionIntentAliasShared,
  type AgentId,
} from '@happier-dev/agents';

export type ParsedSessionStartArgs = {
  startedBy: 'daemon' | 'terminal' | undefined;
  permissionMode: PermissionMode | undefined;
  permissionModeUpdatedAt: number | undefined;
  agentModeId: string | undefined;
  agentModeUpdatedAt: number | undefined;
  modelId: string | undefined;
  modelUpdatedAt: number | undefined;
};

const PERMISSION_MODE_EXAMPLES = [
  '--permission-mode read-only',
  '--permission-mode yolo',
  '--permission-mode accept-edits',
] as const;

function parsePermissionModeAlias(raw: string): PermissionMode | null {
  const parsed = parsePermissionIntentAliasShared(raw);
  if (!parsed) return null;
  // Defensive: keep CLI's PermissionMode as the gate until the type is fully unified.
  return isPermissionMode(parsed) ? parsed : null;
}

export function parseSessionStartArgs(args: string[]): ParsedSessionStartArgs {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined;
  let permissionMode: PermissionMode | undefined = undefined;
  let permissionModeUpdatedAt: number | undefined = undefined;
  let agentModeId: string | undefined = undefined;
  let agentModeUpdatedAt: number | undefined = undefined;
  let modelId: string | undefined = undefined;
  let modelUpdatedAt: number | undefined = undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--started-by') {
      if (i + 1 >= args.length) {
        console.error(chalk.red('Missing value for --started-by (expected: daemon|terminal)'));
        process.exit(1);
      }
      const value = args[++i];
      if (value !== 'daemon' && value !== 'terminal') {
        console.error(chalk.red(`Invalid --started-by value: ${value}. Expected: daemon|terminal`));
        process.exit(1);
      }
      startedBy = value;
    } else if (arg === '--permission-mode') {
      if (i + 1 >= args.length) {
        console.error(
          chalk.red(
            `Missing value for --permission-mode. Valid values: ${PERMISSION_INTENTS.join(', ')}. Examples: ${PERMISSION_MODE_EXAMPLES.join(
              ' | ',
            )}`,
          ),
        );
        process.exit(1);
      }
      const value = args[++i];
      const parsed = parsePermissionModeAlias(value);
      if (!parsed) {
        console.error(
          chalk.red(
            `Invalid --permission-mode value: ${value}. Valid values: ${PERMISSION_INTENTS.join(', ')}. Examples: ${PERMISSION_MODE_EXAMPLES.join(
              ' | ',
            )}`,
          ),
        );
        process.exit(1);
      }
      permissionMode = parsed;
    } else if (arg === '--permission-mode-updated-at') {
      if (i + 1 >= args.length) {
        console.error(chalk.red('Missing value for --permission-mode-updated-at (expected: unix ms timestamp)'));
        process.exit(1);
      }
      const raw = args[++i];
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        console.error(chalk.red(`Invalid --permission-mode-updated-at value: ${raw}. Expected a positive number (unix ms)`));
        process.exit(1);
      }
      permissionModeUpdatedAt = Math.floor(parsedAt);
    } else if (arg === '--agent-mode') {
      if (i + 1 >= args.length) {
        console.error(chalk.red('Missing value for --agent-mode (expected: ACP session mode id)'));
        process.exit(1);
      }
      const raw = args[++i];
      const normalized = typeof raw === 'string' ? raw.trim() : '';
      if (!normalized) {
        console.error(chalk.red('Invalid --agent-mode value: empty'));
        process.exit(1);
      }
      agentModeId = normalized;
    } else if (arg === '--agent-mode-updated-at') {
      if (i + 1 >= args.length) {
        console.error(chalk.red('Missing value for --agent-mode-updated-at (expected: unix ms timestamp)'));
        process.exit(1);
      }
      const raw = args[++i];
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        console.error(chalk.red(`Invalid --agent-mode-updated-at value: ${raw}. Expected a positive number (unix ms)`));
        process.exit(1);
      }
      agentModeUpdatedAt = Math.floor(parsedAt);
    } else if (arg === '--model') {
      if (i + 1 >= args.length) {
        console.error(chalk.red('Missing value for --model (expected: model id)'));
        process.exit(1);
      }
      const raw = args[++i];
      const normalized = typeof raw === 'string' ? raw.trim() : '';
      if (!normalized) {
        console.error(chalk.red('Invalid --model value: empty'));
        process.exit(1);
      }
      modelId = normalized;
    } else if (arg === '--model-updated-at') {
      if (i + 1 >= args.length) {
        console.error(chalk.red('Missing value for --model-updated-at (expected: unix ms timestamp)'));
        process.exit(1);
      }
      const raw = args[++i];
      const parsedAt = Number(raw);
      if (!Number.isFinite(parsedAt) || parsedAt <= 0) {
        console.error(chalk.red(`Invalid --model-updated-at value: ${raw}. Expected a positive number (unix ms)`));
        process.exit(1);
      }
      modelUpdatedAt = Math.floor(parsedAt);
    } else if (arg === '--yolo') {
      permissionMode = 'yolo';
    }
  }

  return { startedBy, permissionMode, permissionModeUpdatedAt, agentModeId, agentModeUpdatedAt, modelId, modelUpdatedAt };
}

export function readOptionalFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  if (!value || value.startsWith('-')) return undefined;
  return value;
}

export function applyDeprecatedSessionStartAliasesForAgent(params: {
  agentId: AgentId;
  startedBy: 'daemon' | 'terminal' | undefined;
  permissionMode: PermissionMode | undefined;
  permissionModeUpdatedAt: number | undefined;
  agentModeId: string | undefined;
  agentModeUpdatedAt: number | undefined;
  modelId: string | undefined;
  modelUpdatedAt: number | undefined;
}): {
  startedBy: 'daemon' | 'terminal' | undefined;
  permissionMode: PermissionMode | undefined;
  permissionModeUpdatedAt: number | undefined;
  agentModeId: string | undefined;
  agentModeUpdatedAt: number | undefined;
  modelId: string | undefined;
  modelUpdatedAt: number | undefined;
  warnings: string[];
} {
  const warnings: string[] = [];

  let permissionMode = params.permissionMode;
  let permissionModeUpdatedAt = params.permissionModeUpdatedAt;
  let agentModeId = params.agentModeId;
  let agentModeUpdatedAt = params.agentModeUpdatedAt;
  const modelId = params.modelId;
  const modelUpdatedAt = params.modelUpdatedAt;

  // Back-compat: historically "plan" was treated as a permission mode in some CLIs.
  // For ACP agents where "plan" is an agent/session mode (OpenCode plan/build), map it to --agent-mode.
  if (getAgentSessionModesKind(params.agentId) === 'acpAgentModes' && !agentModeId && permissionMode === 'plan') {
    warnings.push(`Deprecated: use --agent-mode plan instead of --permission-mode plan for ${params.agentId}.`);
    agentModeId = 'plan';
    agentModeUpdatedAt = agentModeUpdatedAt ?? permissionModeUpdatedAt;
    permissionMode = 'default';
    // permissionModeUpdatedAt is preserved: it still serves as a monotonic seed for arbitration.
  }

  return {
    startedBy: params.startedBy,
    permissionMode,
    permissionModeUpdatedAt,
    agentModeId,
    agentModeUpdatedAt,
    modelId,
    modelUpdatedAt,
    warnings,
  };
}
