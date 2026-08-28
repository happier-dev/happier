import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

import {
  resolveAgentRuntimeControlSurface,
  resolveDefaultAgentRuntimeKind,
  type AgentRuntimeKind,
} from '../../runtimeKinds.js';
import type { AgentId } from '../../types.js';
import type { RuntimeControlSurface } from '../../runtime/engine/contracts.js';
import { readSessionMetadataRuntimeDescriptor } from '../../runtime/identity/readSessionMetadataRuntimeDescriptor.js';

function resolveAgentRuntimeSurface(agentId: AgentId, runtimeKind: AgentRuntimeKind | null): RuntimeControlSurface | null {
  return resolveAgentRuntimeControlSurface(agentId, runtimeKind as never);
}

export function resolveAgentRuntimeControlSurfaceForSession(params: Readonly<{
  agentId: AgentId;
  metadata: unknown;
}>): RuntimeControlSurface | null {
  // A current descriptor is Agent-owned. Generic controls cannot safely infer
  // an effective capability surface from its opaque fields; the focused live
  // Agent projection owns that decision. The Protocol reader also recognizes
  // the released predecessor envelope at this ingress without exposing its
  // Agent fields to this owner.
  if (readRuntimeDescriptorV1FromMetadata(params.metadata)) return null;
  const runtimeKind = readSessionMetadataRuntimeDescriptor(params.metadata, params.agentId)?.runtimeKind
    ?? resolveDefaultAgentRuntimeKind(params.agentId);
  return resolveAgentRuntimeSurface(params.agentId, runtimeKind);
}
