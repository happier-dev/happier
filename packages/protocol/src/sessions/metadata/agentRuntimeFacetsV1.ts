import { z } from '../../zodRuntimePolicy.js';

export type AgentRuntimeTranscriptSourceFacetV1 = Readonly<{
  supported: true;
  followLeaseSupported?: true;
}>;

export type AgentRuntimeFacetsV1 = Readonly<{
  v: 1;
  transcriptSource?: AgentRuntimeTranscriptSourceFacetV1;
}>;

function createAgentRuntimeTranscriptSourceFacetV1Schema(zod: typeof z) {
  return zod.looseObject({
    supported: zod.literal(true),
    followLeaseSupported: zod.optional(zod.literal(true)),
  });
}

export function createAgentRuntimeFacetsV1Schema(zod: typeof z) {
  return zod.looseObject({
    v: zod.literal(1),
    transcriptSource: zod.optional(createAgentRuntimeTranscriptSourceFacetV1Schema(zod)),
  });
}

export const AgentRuntimeFacetsV1Schema = createAgentRuntimeFacetsV1Schema(z);

export function readAgentRuntimeFacetsV1(value: unknown): AgentRuntimeFacetsV1 | null {
  const parsed = AgentRuntimeFacetsV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
