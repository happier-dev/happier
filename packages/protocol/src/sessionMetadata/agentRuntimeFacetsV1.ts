import { z } from 'zod';

export type AgentRuntimeTranscriptSourceFacetV1 = Readonly<{
  supported: true;
  followLeaseSupported?: true;
}>;

export type AgentRuntimeFacetsV1 = Readonly<{
  v: 1;
  transcriptSource?: AgentRuntimeTranscriptSourceFacetV1;
}>;

function createAgentRuntimeTranscriptSourceFacetV1Schema(zod: typeof z) {
  return zod.object({
    supported: zod.literal(true),
    followLeaseSupported: zod.literal(true).optional(),
  }).passthrough();
}

export function createAgentRuntimeFacetsV1Schema(zod: typeof z) {
  return zod.object({
    v: zod.literal(1),
    transcriptSource: createAgentRuntimeTranscriptSourceFacetV1Schema(zod).optional(),
  }).passthrough();
}

export const AgentRuntimeFacetsV1Schema = createAgentRuntimeFacetsV1Schema(z);

export function readAgentRuntimeFacetsV1(value: unknown): AgentRuntimeFacetsV1 | null {
  const parsed = AgentRuntimeFacetsV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
