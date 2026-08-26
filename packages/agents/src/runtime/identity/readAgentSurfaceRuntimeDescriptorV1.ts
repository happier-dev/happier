import {
  readRuntimeDescriptorV1,
  readRuntimeDescriptorV1FromMetadata,
  type RuntimeDescriptorV1,
} from '@happier-dev/protocol';

import { resolveAgentIdFromSessionMetadata } from '../../resolveAgentIdFromSessionMetadata.js';
import { getRuntimeDescriptorReader } from './runtimeDescriptorReaderRegistry.js';
import { asRecord } from './runtimeDescriptorShared.js';

function reEnvelopeGeneratedLegacyDescriptor(
  metadata: Record<string, unknown>,
): RuntimeDescriptorV1 | null {
  const agentId = resolveAgentIdFromSessionMetadata(metadata);
  if (!agentId) return null;

  const generatedReader = getRuntimeDescriptorReader(agentId);
  const legacyDescriptor = generatedReader?.(metadata);
  if (!legacyDescriptor) return null;

  const descriptor = legacyDescriptor as Readonly<Record<string, unknown>>;
  if (descriptor.agentId !== agentId) return null;
  const {
    agentId: _agentId,
    runtimeKind: _runtimeKind,
    runtimeHandle: _runtimeHandle,
    providerId: _providerId,
    rawProvider: _rawProvider,
    ...agent
  } = descriptor;
  if (Object.keys(agent).length === 0) return null;

  return readRuntimeDescriptorV1({ v: 1, agentId, agent });
}

/**
 * Agent-surface ingress with one compatibility seam for predecessor Session
 * metadata. Current writers already persist `runtimeDescriptorV1`; the
 * generated reader registry recognizes bounded legacy fields emitted by
 * `remote-dev` at `ec4d3a29defa7fb094f4eb92909ddc74f172461b` and re-envelopes
 * them before an Agent surface sees them. Remove this fallback when supported
 * released/predecessor writers no longer emit those flat fields.
 */
export function readAgentSurfaceRuntimeDescriptorV1FromSessionMetadata(
  metadata: unknown,
): RuntimeDescriptorV1 | null {
  const metadataRecord = asRecord(metadata);
  if (!metadataRecord) return null;

  return readRuntimeDescriptorV1FromMetadata(metadataRecord)
    ?? reEnvelopeGeneratedLegacyDescriptor(metadataRecord);
}
