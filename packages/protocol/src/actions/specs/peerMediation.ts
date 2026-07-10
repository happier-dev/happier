import { z } from 'zod';

import type { RuntimeActionIdV1 } from '../actionIds.js';
import {
  PeerMediationObservabilitySnapshotV1Schema,
  PeerMediationObservabilitySubscribeRequestV1Schema,
  PeerMediationObservabilityUnsubscribeRequestV1Schema,
} from '../../machines/peer/mediation/observability/v1.js';
import type { RuntimeActionSpecFamily } from './common.js';

const RuntimePeerMediationObservabilitySnapshotInputSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(256).optional(),
    machineId: z.string().trim().min(1).max(256).optional(),
  })
  .passthrough();

export const PEER_MEDIATION_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'peerMediation.observability.snapshot': 'Get peer mediation observability snapshot',
  'peerMediation.observability.subscribe': 'Subscribe to peer mediation observability',
  'peerMediation.observability.unsubscribe': 'Unsubscribe from peer mediation observability',
});

function peerMediationRuntimeActionInputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny | null {
  if (actionId === 'peerMediation.observability.subscribe') return PeerMediationObservabilitySubscribeRequestV1Schema;
  if (actionId === 'peerMediation.observability.unsubscribe') return PeerMediationObservabilityUnsubscribeRequestV1Schema;
  if (actionId === 'peerMediation.observability.snapshot') return RuntimePeerMediationObservabilitySnapshotInputSchema;
  return null;
}

function peerMediationRuntimeActionOutputSchema(actionId: RuntimeActionIdV1): z.ZodTypeAny | null {
  if (actionId.startsWith('peerMediation.observability.')) return PeerMediationObservabilitySnapshotV1Schema.or(z.unknown());
  return null;
}

export const PEER_MEDIATION_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: PEER_MEDIATION_RUNTIME_ACTION_TITLES,
  inputSchemaForAction: peerMediationRuntimeActionInputSchema,
  outputSchemaForAction: peerMediationRuntimeActionOutputSchema,
} satisfies RuntimeActionSpecFamily);
