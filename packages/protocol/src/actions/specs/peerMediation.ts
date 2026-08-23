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

const PeerMediationObservabilitySnapshotActionResultV1Schema = z.object({
  ok: z.literal(true),
  snapshot: PeerMediationObservabilitySnapshotV1Schema,
}).strict();

const PeerMediationObservabilitySubscribeActionResultV1Schema = z.object({
  ok: z.literal(true),
  snapshot: PeerMediationObservabilitySnapshotV1Schema,
  sequence: z.number().int().nonnegative(),
}).strict();

const PeerMediationObservabilityUnsubscribeActionResultV1Schema = z.object({
  ok: z.literal(true),
}).strict();

type PeerMediationRuntimeActionId = Extract<RuntimeActionIdV1, `peerMediation.${string}`>;

export const PEER_MEDIATION_RUNTIME_ACTION_TITLES: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'peerMediation.observability.snapshot': 'Get peer mediation observability snapshot',
  'peerMediation.observability.subscribe': 'Subscribe to peer mediation observability',
  'peerMediation.observability.unsubscribe': 'Unsubscribe from peer mediation observability',
});

/**
 * Honest per-id capability copy. `subscribe` is a SNAPSHOT-CURSOR contract, not a push stream: the
 * daemon control surface is request/response, so the leaf returns the current snapshot plus its
 * `sequence` and the caller advances by re-reading. A live delta push happens only when an
 * out-of-band delta sink is wired, and no dead listener is registered when one is absent. The
 * implementing owner records the same disposition at
 * `apps/cli/src/daemon/peer/mediation/observability/runtimeActionExecutor.ts`.
 */
export const PEER_MEDIATION_RUNTIME_ACTION_DESCRIPTIONS: Readonly<Partial<Record<RuntimeActionIdV1, string>>> = Object.freeze({
  'peerMediation.observability.snapshot':
    'Read the current peer mediation observability counters for an authorized machine scope.',
  'peerMediation.observability.subscribe':
    'Open a poll-backed peer mediation observability cursor: returns the current snapshot and its sequence, which the caller advances by re-reading the snapshot. Live deltas are pushed only when an out-of-band delta sink is wired.',
  'peerMediation.observability.unsubscribe':
    'Close a peer mediation observability cursor and release any wired delta listener.',
});

export const PEER_MEDIATION_RUNTIME_ACTION_INPUT_SCHEMAS = Object.freeze({
  'peerMediation.observability.snapshot': RuntimePeerMediationObservabilitySnapshotInputSchema,
  'peerMediation.observability.subscribe': PeerMediationObservabilitySubscribeRequestV1Schema,
  'peerMediation.observability.unsubscribe': PeerMediationObservabilityUnsubscribeRequestV1Schema,
} as const satisfies Readonly<Record<PeerMediationRuntimeActionId, z.ZodTypeAny>>);

export const PEER_MEDIATION_RUNTIME_ACTION_OUTPUT_SCHEMAS = Object.freeze({
  'peerMediation.observability.snapshot': PeerMediationObservabilitySnapshotActionResultV1Schema,
  'peerMediation.observability.subscribe': PeerMediationObservabilitySubscribeActionResultV1Schema,
  'peerMediation.observability.unsubscribe': PeerMediationObservabilityUnsubscribeActionResultV1Schema,
} as const satisfies Readonly<Record<PeerMediationRuntimeActionId, z.ZodTypeAny>>);

export const PEER_MEDIATION_RUNTIME_ACTION_SPEC_FAMILY = Object.freeze({
  titles: PEER_MEDIATION_RUNTIME_ACTION_TITLES,
  descriptions: PEER_MEDIATION_RUNTIME_ACTION_DESCRIPTIONS,
  inputSchemas: PEER_MEDIATION_RUNTIME_ACTION_INPUT_SCHEMAS,
  outputSchemas: PEER_MEDIATION_RUNTIME_ACTION_OUTPUT_SCHEMAS,
} satisfies RuntimeActionSpecFamily);
