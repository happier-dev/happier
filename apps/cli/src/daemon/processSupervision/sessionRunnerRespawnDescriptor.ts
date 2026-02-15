import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { TerminalSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import * as z from 'zod';

const TerminalTmuxSpawnOptionsSchema = z
  .object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const TerminalSpawnOptionsSchema = z
  .object({
    mode: z.enum(['plain', 'tmux']).optional(),
    tmux: TerminalTmuxSpawnOptionsSchema.optional(),
  })
  .passthrough();

export const SessionRunnerRespawnDescriptorV1Schema = z
  .object({
    version: z.literal(1),
    directory: z.string(),
    agent: z.enum(CATALOG_AGENT_IDS).optional(),
    terminal: TerminalSpawnOptionsSchema.optional(),
    windowsRemoteSessionConsole: z.enum(['hidden', 'visible']).optional(),
    profileId: z.string().optional(),
    permissionMode: z.string().optional(),
    permissionModeUpdatedAt: z.number().int().optional(),
    modelId: z.string().optional(),
    modelUpdatedAt: z.number().int().optional(),
    experimentalCodexResume: z.boolean().optional(),
    experimentalCodexAcp: z.boolean().optional(),
  })
  .strict();

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

  const descriptor: SessionRunnerRespawnDescriptorV1 = {
    version: 1,
    directory,
    ...(typeof spawnOptions.agent === 'string' ? { agent: spawnOptions.agent as any } : {}),
    ...(spawnOptions.terminal ? { terminal: spawnOptions.terminal as TerminalSpawnOptions } : {}),
    ...(spawnOptions.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: spawnOptions.windowsRemoteSessionConsole } : {}),
    ...(typeof spawnOptions.profileId === 'string' ? { profileId: spawnOptions.profileId } : {}),
    ...(typeof spawnOptions.permissionMode === 'string' ? { permissionMode: spawnOptions.permissionMode } : {}),
    ...(typeof spawnOptions.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: spawnOptions.permissionModeUpdatedAt } : {}),
    ...(typeof spawnOptions.modelId === 'string' ? { modelId: spawnOptions.modelId } : {}),
    ...(typeof spawnOptions.modelUpdatedAt === 'number' ? { modelUpdatedAt: spawnOptions.modelUpdatedAt } : {}),
    ...(spawnOptions.experimentalCodexResume === true ? { experimentalCodexResume: true } : {}),
    ...(spawnOptions.experimentalCodexAcp === true ? { experimentalCodexAcp: true } : {}),
  };

  const parsed = SessionRunnerRespawnDescriptorV1Schema.safeParse(descriptor);
  return parsed.success ? parsed.data : null;
}

export function buildSpawnSessionOptionsFromRespawnDescriptorV1(
  descriptor: SessionRunnerRespawnDescriptorV1,
): SpawnSessionOptions {
  return {
    directory: descriptor.directory,
    ...(descriptor.agent ? { agent: descriptor.agent as any } : {}),
    ...(descriptor.terminal ? { terminal: descriptor.terminal as any } : {}),
    ...(descriptor.windowsRemoteSessionConsole ? { windowsRemoteSessionConsole: descriptor.windowsRemoteSessionConsole } : {}),
    ...(typeof descriptor.profileId === 'string' ? { profileId: descriptor.profileId } : {}),
    ...(typeof descriptor.permissionMode === 'string' ? { permissionMode: descriptor.permissionMode as any } : {}),
    ...(typeof descriptor.permissionModeUpdatedAt === 'number' ? { permissionModeUpdatedAt: descriptor.permissionModeUpdatedAt } : {}),
    ...(typeof descriptor.modelId === 'string' ? { modelId: descriptor.modelId } : {}),
    ...(typeof descriptor.modelUpdatedAt === 'number' ? { modelUpdatedAt: descriptor.modelUpdatedAt } : {}),
    ...(descriptor.experimentalCodexResume === true ? { experimentalCodexResume: true } : {}),
    ...(descriptor.experimentalCodexAcp === true ? { experimentalCodexAcp: true } : {}),
    approvedNewDirectoryCreation: true,
  };
}

