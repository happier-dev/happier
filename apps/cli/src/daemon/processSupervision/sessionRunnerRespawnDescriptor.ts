import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { resolveCanonicalCodexBackendMode } from '@/rpc/handlers/registerSessionHandlers';
import type { TerminalMode, TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { AgentRuntimeDescriptorV1Schema, BackendTargetRefSchema, SessionMcpSelectionV1Schema } from '@happier-dev/protocol';
import * as z from 'zod';

const TERMINAL_MODES = ['plain', 'tmux', 'windows_terminal', 'windows_console'] as const satisfies readonly TerminalMode[];

const TerminalTmuxSpawnOptionsSchema: z.ZodType<NonNullable<TerminalSpawnOptions['tmux']>> = z
  .object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const TerminalSpawnOptionsSchema: z.ZodType<TerminalSpawnOptions> = z
  .object({
    mode: z.enum(TERMINAL_MODES).optional(),
    tmux: TerminalTmuxSpawnOptionsSchema.optional(),
  })
  .passthrough();

export const SessionRunnerRespawnDescriptorV1Schema = z
  .preprocess((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return value;
    }

    const candidate = value as Record<string, unknown>;
    const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
      codexBackendMode: candidate.codexBackendMode,
      experimentalCodexAcp: candidate.experimentalCodexAcp === true,
      agentRuntimeDescriptorV1: candidate.agentRuntimeDescriptorV1,
    }) ?? (candidate.experimentalCodexResume === true ? 'acp' : undefined);
    const { experimentalCodexAcp: _legacyExperimentalCodexAcp, experimentalCodexResume: _legacyExperimentalCodexResume, ...rest } = candidate;

    return canonicalCodexBackendMode
      ? {
          ...rest,
          codexBackendMode: canonicalCodexBackendMode,
        }
      : rest;
  }, z
  .object({
    version: z.literal(1),
    directory: z.string(),
    backendTarget: BackendTargetRefSchema.optional(),
    resume: z.string().optional(),
    transcriptStorage: z.enum(['persisted', 'direct']).optional(),
    terminal: TerminalSpawnOptionsSchema.optional(),
    windowsRemoteSessionLaunchMode: z.enum(['hidden', 'windows_terminal', 'console']).optional(),
    windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
    profileId: z.string().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().int().optional(),
    agentModeId: z.string().optional(),
    agentModeUpdatedAt: z.number().int().optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().int().optional(),
    sessionConfigOptionOverrides: z.unknown().optional(),
    connectedServices: z.unknown().optional(),
    mcpSelection: SessionMcpSelectionV1Schema.optional(),
    agentRuntimeDescriptorV1: AgentRuntimeDescriptorV1Schema.optional(),
    codexBackendMode: z.enum(['mcp', 'acp', 'appServer']).optional(),
  })
  .passthrough());

export type SessionRunnerRespawnDescriptorV1 = z.infer<typeof SessionRunnerRespawnDescriptorV1Schema>;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function buildSessionRunnerRespawnDescriptorV1FromSpawnOptions(
  spawnOptions: SpawnSessionOptions,
): SessionRunnerRespawnDescriptorV1 | null {
  const directory = normalizeOptionalString(spawnOptions.directory);
  if (!directory) return null;
  const resume = normalizeOptionalString(spawnOptions.resume);
  const transcriptStorage = spawnOptions.transcriptStorage === 'direct' ? 'direct' : undefined;
  const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode: spawnOptions.codexBackendMode,
    experimentalCodexAcp: spawnOptions.experimentalCodexAcp,
    agentRuntimeDescriptorV1: spawnOptions.agentRuntimeDescriptorV1,
  });

  const descriptor: SessionRunnerRespawnDescriptorV1 = {
    version: 1,
    directory,
    ...(spawnOptions.backendTarget ? { backendTarget: spawnOptions.backendTarget } : {}),
    ...(resume ? { resume } : {}),
    ...(transcriptStorage ? { transcriptStorage } : {}),
    ...(spawnOptions.terminal ? { terminal: spawnOptions.terminal } : {}),
    ...(spawnOptions.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: spawnOptions.windowsRemoteSessionLaunchMode } : {}),
    ...(spawnOptions.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: spawnOptions.windowsRemoteSessionConsole } : {}),
    ...(typeof spawnOptions.profileId === 'string' ? { profileId: spawnOptions.profileId } : {}),
    ...(typeof spawnOptions.permissionMode === 'string' ? { permissionMode: spawnOptions.permissionMode } : {}),
    ...(typeof spawnOptions.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: spawnOptions.permissionModeUpdatedAt } : {}),
    ...(typeof spawnOptions.agentModeId === 'string' ? { agentModeId: spawnOptions.agentModeId } : {}),
    ...(typeof spawnOptions.agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt: spawnOptions.agentModeUpdatedAt } : {}),
    ...(typeof spawnOptions.modelId === 'string' ? { modelId: spawnOptions.modelId } : {}),
    ...(typeof spawnOptions.modelUpdatedAt === 'number' ? { modelUpdatedAt: spawnOptions.modelUpdatedAt } : {}),
    ...(spawnOptions.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: spawnOptions.sessionConfigOptionOverrides } : {}),
    ...(spawnOptions.connectedServices ? { connectedServices: spawnOptions.connectedServices } : {}),
    ...(spawnOptions.mcpSelection ? { mcpSelection: spawnOptions.mcpSelection } : {}),
    ...(spawnOptions.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: spawnOptions.agentRuntimeDescriptorV1 } : {}),
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
  };

  const parsed = SessionRunnerRespawnDescriptorV1Schema.safeParse(descriptor);
  return parsed.success ? parsed.data : null;
}

export function buildSpawnSessionOptionsFromRespawnDescriptorV1(
  descriptor: SessionRunnerRespawnDescriptorV1,
): SpawnSessionOptions {
  const canonicalCodexBackendMode = resolveCanonicalCodexBackendMode({
    codexBackendMode: descriptor.codexBackendMode,
    agentRuntimeDescriptorV1: descriptor.agentRuntimeDescriptorV1,
  });

  return {
    directory: descriptor.directory,
    ...(descriptor.backendTarget ? { backendTarget: descriptor.backendTarget } : {}),
    ...(typeof descriptor.resume === 'string' ? { resume: descriptor.resume } : {}),
    ...(descriptor.transcriptStorage === 'direct' ? { transcriptStorage: 'direct' } : {}),
    ...(descriptor.terminal ? { terminal: descriptor.terminal } : {}),
    ...(descriptor.windowsRemoteSessionLaunchMode ? { windowsRemoteSessionLaunchMode: descriptor.windowsRemoteSessionLaunchMode } : {}),
    ...(descriptor.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: descriptor.windowsRemoteSessionConsole } : {}),
    ...(typeof descriptor.profileId === 'string' ? { profileId: descriptor.profileId } : {}),
    ...(typeof descriptor.permissionMode === 'string' ? { permissionMode: descriptor.permissionMode as any } : {}),
    ...(typeof descriptor.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: descriptor.permissionModeUpdatedAt } : {}),
    ...(typeof descriptor.agentModeId === 'string' ? { agentModeId: descriptor.agentModeId } : {}),
    ...(typeof descriptor.agentModeUpdatedAt === 'number' ? { agentModeUpdatedAt: descriptor.agentModeUpdatedAt } : {}),
    ...(typeof descriptor.modelId === 'string' ? { modelId: descriptor.modelId } : {}),
    ...(typeof descriptor.modelUpdatedAt === 'number' ? { modelUpdatedAt: descriptor.modelUpdatedAt } : {}),
    ...(descriptor.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: descriptor.sessionConfigOptionOverrides as any } : {}),
    ...(descriptor.connectedServices ? { connectedServices: descriptor.connectedServices } : {}),
    ...(descriptor.mcpSelection ? { mcpSelection: descriptor.mcpSelection } : {}),
    ...(descriptor.agentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: descriptor.agentRuntimeDescriptorV1 } : {}),
    ...(canonicalCodexBackendMode ? { codexBackendMode: canonicalCodexBackendMode } : {}),
    approvedNewDirectoryCreation: true,
  };
}
