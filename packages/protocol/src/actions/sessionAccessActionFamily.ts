import type { z } from '../zodRuntimePolicy.js';

import { isSessionAccessActionId, type SessionAccessActionId } from './actionIds.js';
import { getActionSpec } from './actionSpecs.js';
import { bindHomeDomainHttpRequestV1, type HomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';
import { SessionPublicLinkCreateActionInputV1Schema } from '../sessions/access/sessionAccessActionsV1.js';

/**
 * The Session-access family's transport and codec lookup.
 *
 * It lives in the Action layer rather than beside the Session-access schemas
 * for the same reason the Home family's does: the Action id registry and the
 * feature graph already import each other, and pulling the registry into a
 * domain schema leaf makes that graph evaluate before the leaf finishes. Ids and
 * schemas stay dependency-light; the registry-aware lookup lives here.
 *
 * Every value is read from the registered Action row, which is the single
 * declaration of each intent's transport and codecs. This module holds no path
 * or schema table of its own.
 */
export type { SessionAccessActionId };

export function isSessionAccessActionIdV1(value: string): value is SessionAccessActionId {
  return isSessionAccessActionId(value);
}

/** The strict domain input this intent declared on its Action row. */
export function sessionAccessActionInputSchemaV1(actionId: SessionAccessActionId): z.ZodMiniType {
  return getActionSpec(actionId).inputSchema;
}

/** The strict domain result this intent declared on its Action row. */
export function sessionAccessActionOutputSchemaV1(actionId: SessionAccessActionId): z.ZodMiniType {
  const outputSchema = getActionSpec(actionId).outputSchema;
  if (!outputSchema) {
    // A registered family row without a result schema is a registry defect, not
    // a runtime condition a caller could recover from.
    throw new TypeError(`Session access Action declares no result schema: ${actionId}`);
  }
  return outputSchema;
}

/**
 * Binds one Session-access intent to the exact HTTP request its row declared.
 *
 * Typed on the family id so a caller cannot bind an Action from another family
 * through this seam, and so the descriptor binder — not a client-side route
 * table — stays the only place that turns an Action input into a request.
 */
export function bindSessionAccessActionHttpRequestV1(
  actionId: SessionAccessActionId,
  input: unknown,
): HomeDomainHttpRequestV1 {
  const spec = getActionSpec(actionId);
  if (!spec.serverTransport) {
    throw new TypeError(`Session access Action declares no server transport: ${actionId}`);
  }
  if (actionId === 'session.public_link.create') {
    // Current fragment-wrapped keys must never reach the released token writer:
    // a predecessor can strip new fields while retaining its legacy token hash.
    const { sessionId, networkOff, ...settings } = SessionPublicLinkCreateActionInputV1Schema.parse(input);
    return { method: spec.serverTransport.method, path: spec.serverTransport.path,
      body: { subject: { kind: 'session', id: sessionId }, ...settings,
        ...(networkOff === true ? { networkOff: true } : {}) } };
  }
  return bindHomeDomainHttpRequestV1({
    transport: spec.serverTransport,
    inputSchema: spec.inputSchema,
    input,
  });
}
