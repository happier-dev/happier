import { z } from 'zod';

import { defineProtocolString } from '../../plugins/actions/protocolComposableSchema.js';
import { SessionIndexedIdentifierMaxLengthV1 } from '../idsV1.js';

/**
 * A pending localId is opaque and deliberately keeps its surrounding
 * whitespace; only a wholly blank value is rejected.
 */
const NON_BLANK_PATTERN = /\S/u;

/**
 * The canonical grammar for one opaque pending localId, authored as a
 * validator-neutral composable so schemas that must publish a portable JSON
 * Schema can embed it. `PendingLocalIdSchema` below is the incumbent Zod
 * spelling of this same grammar, not a second one.
 *
 * The ceiling is the incumbent session-indexed identifier bound rather than a
 * nearby number: a localId indexes one pending row inside one Session, is
 * carried in Session route params, and is client-generated as a UUID. Without
 * it the value is an unbounded string, so every bounded contract that embeds a
 * Composer scope — `TriageDetailSurfaceInputV1` is the first — has no derivable
 * maximum encoded size.
 */
export const PendingLocalIdProtocolSchema = defineProtocolString({
  minLength: 1,
  maxLength: SessionIndexedIdentifierMaxLengthV1,
  pattern: NON_BLANK_PATTERN.source,
});

export function isPendingLocalId(value: unknown): value is string {
  return PendingLocalIdProtocolSchema.safeParse(value).success;
}

export function readPendingLocalId(value: unknown): string | null {
  return isPendingLocalId(value) ? value : null;
}

export const PendingLocalIdSchema = z.string().refine(isPendingLocalId, {
  message: 'Pending localId must not be blank',
});

export type PendingLocalId = z.infer<typeof PendingLocalIdSchema>;
