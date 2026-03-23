import { z } from 'zod';

export const BackendTargetKindSchema = z.enum(['builtInAgent', 'configuredAcpBackend']);
export type BackendTargetKind = z.infer<typeof BackendTargetKindSchema>;

const BuiltInAgentTargetSchema = z.object({
  kind: z.literal('builtInAgent'),
  agentId: z.string().min(1),
});

const ConfiguredAcpBackendTargetSchema = z.object({
  kind: z.literal('configuredAcpBackend'),
  backendId: z.string().min(1),
});

export const BackendTargetRefSchema = z.union([BuiltInAgentTargetSchema, ConfiguredAcpBackendTargetSchema]);
export type BackendTargetRefV1 = z.infer<typeof BackendTargetRefSchema>;

export const BackendTargetKeySchema = z.string().regex(/^(agent|acpBackend):.+$/, 'Invalid backend target key');
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
