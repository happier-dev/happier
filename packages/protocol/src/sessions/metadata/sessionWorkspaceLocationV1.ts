import { z } from 'zod';

export const SESSION_WORKSPACE_LOCATION_METADATA_KEY = 'sessionWorkspaceLocationV1' as const;

function createNonBlankPathSchema(zod: typeof z) {
  return zod.string().refine((value) => value.trim().length > 0, {
    message: 'Workspace path must not be blank',
  });
}

export function createSessionWorkspaceLocationV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    machineId: zod.string().trim().min(1),
    agentPath: createNonBlankPathSchema(zod),
    machinePath: createNonBlankPathSchema(zod),
  }).passthrough();
}

export const SessionWorkspaceLocationV1Schema = createSessionWorkspaceLocationV1Schema(z);
export type SessionWorkspaceLocationV1 = z.infer<typeof SessionWorkspaceLocationV1Schema>;

export function buildSessionWorkspaceLocationV1(params: Readonly<{
  machineId: string;
  agentPath: string;
  machinePath: string;
}>): SessionWorkspaceLocationV1 {
  return SessionWorkspaceLocationV1Schema.parse({
    v: 1,
    machineId: params.machineId,
    agentPath: params.agentPath,
    machinePath: params.machinePath,
  });
}

export function readSessionWorkspaceLocationFromMetadata(params: Readonly<{
  metadata: unknown;
}>): SessionWorkspaceLocationV1 | null {
  if (!params.metadata || typeof params.metadata !== 'object' || Array.isArray(params.metadata)) return null;
  const parsed = SessionWorkspaceLocationV1Schema.safeParse(
    (params.metadata as Record<string, unknown>)[SESSION_WORKSPACE_LOCATION_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Resolves only a workspace root proven to be the published agent root for the
 * same machine. Missing, malformed, stale, or replacement-machine mappings
 * preserve the caller's existing path.
 */
export function resolveSessionWorkspaceRootForMachine(params: Readonly<{
  metadata: unknown;
  machineId: string;
  candidatePath: string;
}>): Readonly<{ machinePath: string; agentPath?: string }> {
  const location = readSessionWorkspaceLocationFromMetadata({ metadata: params.metadata });
  if (
    !location
    || location.machineId !== params.machineId.trim()
    || location.agentPath !== params.candidatePath
  ) {
    return { machinePath: params.candidatePath };
  }
  return {
    machinePath: location.machinePath,
    agentPath: location.agentPath,
  };
}
