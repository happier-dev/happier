import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const BackendTargetKindSchema = lazySchema(() => z.enum(['builtInAgent', 'configuredAcpBackend']));
export type BackendTargetKind = z.infer<typeof BackendTargetKindSchema>;

const BuiltInAgentTargetSchema = lazySchema(() => z.object({
  kind: z.literal('builtInAgent'),
  agentId: z.string().min(1),
}));

const ConfiguredAcpBackendTargetSchema = lazySchema(() => z.object({
  kind: z.literal('configuredAcpBackend'),
  backendId: z.string().min(1),
}));

export const BackendTargetRefSchema = lazySchema(() => z.union([BuiltInAgentTargetSchema, ConfiguredAcpBackendTargetSchema]));
export type BackendTargetRefV1 = z.infer<typeof BackendTargetRefSchema>;

/** The 0.2 catalog placeholder identifies transport; a configured target keeps its own reference. */
export function getBackendTargetAgentId(target: BackendTargetRefV1): string {
  return target.kind === 'builtInAgent' ? target.agentId : 'customAcp';
}

export function matchesBackendTargetAgentId(target: BackendTargetRefV1, agentId: string): boolean {
  return agentId === getBackendTargetAgentId(target);
}

export const BackendTargetKeySchema = lazySchema(() => z.string().regex(/^(agent|acpBackend):.+$/, 'Invalid backend target key'));
export type BackendTargetKey = z.infer<typeof BackendTargetKeySchema>;

export function buildBackendTargetKey(target: BackendTargetRefV1): BackendTargetKey {
  return target.kind === 'builtInAgent'
    ? BackendTargetKeySchema.parse(`agent:${target.agentId}`)
    : BackendTargetKeySchema.parse(`acpBackend:${target.backendId}`);
}

export function parseBackendTargetKey(key: string): BackendTargetRefV1 {
  const parsed = BackendTargetKeySchema.parse(key);
  if (parsed.startsWith('agent:')) {
    return BackendTargetRefSchema.parse({ kind: 'builtInAgent', agentId: parsed.slice('agent:'.length) });
  }
  return BackendTargetRefSchema.parse({ kind: 'configuredAcpBackend', backendId: parsed.slice('acpBackend:'.length) });
}

export function isBuiltInAgentTarget(target: BackendTargetRefV1): target is z.infer<typeof BuiltInAgentTargetSchema> {
  return target.kind === 'builtInAgent';
}

export function isConfiguredAcpBackendTarget(
  target: BackendTargetRefV1,
): target is z.infer<typeof ConfiguredAcpBackendTargetSchema> {
  return target.kind === 'configuredAcpBackend';
}
