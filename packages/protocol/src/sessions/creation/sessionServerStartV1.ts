import { z } from 'zod';

import {
  AutomationAccountCurrentnessWitnessV1Schema,
} from '../../automations/automationAccountCurrentnessV1.js';
import {
  AutomationSessionStartRequestEnvelopeV1Schema,
  validateAutomationSessionStartRequestEnvelopeOuterForModeV1,
} from '../../automations/automationSessionStartRequestEnvelopeV1.js';
import {
  SessionServerStartSpawnDraftV1Schema,
  SessionSpawnNewInputV2Schema,
  type SessionServerStartSpawnDraftV1,
  type SessionSpawnNewInputV2,
} from './sessionSpawnNewInputV2.js';
import {
  SessionSpawnNewResultV1Schema,
  type SessionSpawnNewResultV1,
} from './sessionSpawnNewResultV1.js';

const SessionServerStartHostIdV1Schema = z.string().min(1).max(256).refine(
  (value) => value === value.trim(),
  'Session server-start identifiers must not have surrounding whitespace',
);

/**
 * Internal exact-machine method reserved for the server-stamped Session start
 * transport. It is never a public Action, SDK, or plugin RPC method.
 */
export const SESSION_SERVER_START_DAEMON_RPC_METHOD_V1 =
  'daemon.sessions.serverStart.dispatch' as const;

/**
 * Machine-authenticated Automation-to-server entrypoint for a strict Session
 * start. The caller proves only its Run correspondence; the server derives
 * every authority and target fact before it produces a dispatch request.
 */
export const SESSION_SERVER_START_INGRESS_EVENT_V1 =
  'session-server-start-ingress-v1' as const;

export { SessionServerStartSpawnDraftV1Schema };
export type { SessionServerStartSpawnDraftV1 };

/**
 * Server-held routing facts. `serverId` remains the authenticated server
 * scope, so it is intentionally not repeated as mutable payload data.
 */
export const SessionServerStartTargetV1Schema = z.object({
  accountId: SessionServerStartHostIdV1Schema,
  machineId: SessionServerStartHostIdV1Schema,
  machineInstallationId: SessionServerStartHostIdV1Schema,
}).strict();
export type SessionServerStartTargetV1 = z.infer<typeof SessionServerStartTargetV1Schema>;

/**
 * The server validates only frozen correspondence, currentness, and the
 * bounded mode-tagged envelope. It deliberately does not parse an inner
 * Session V2 request; the Automation-owned wrapper validates only the outer
 * E2EE purpose tag here, and the exact target opens it later.
 */
export const SessionServerStartClaimV1Schema = z.object({
  automationId: SessionServerStartHostIdV1Schema,
  runId: SessionServerStartHostIdV1Schema,
  origin: z.enum(['schedule', 'manual', 'event', 'conversation']),
  accountCurrentness: AutomationAccountCurrentnessWitnessV1Schema,
  requestEnvelope: AutomationSessionStartRequestEnvelopeV1Schema,
}).strict().superRefine((value, context) => {
  const outer = validateAutomationSessionStartRequestEnvelopeOuterForModeV1({
    mode: value.accountCurrentness.mode,
    envelope: value.requestEnvelope,
  });
  if (outer.kind !== 'available') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestEnvelope', 't'],
      message: 'Session server-start request envelope is not valid for the current Account mode',
    });
  }
});
export type SessionServerStartClaimV1 = z.infer<typeof SessionServerStartClaimV1Schema>;

/**
 * Closed server-to-daemon framing for the authorized plain or E2EE path.
 * The target performs exact V2 parsing only after closed-origin, target,
 * currentness, and cancellation revalidation.
 */
export const SessionServerStartDispatchRequestV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('session.serverStart.dispatch'),
  target: SessionServerStartTargetV1Schema,
  start: SessionServerStartClaimV1Schema,
}).strict();
export type SessionServerStartDispatchRequestV1 = z.infer<
  typeof SessionServerStartDispatchRequestV1Schema
>;

/** The target returns only canonical Session create-or-rejoin truth. */
export const SessionServerStartDispatchResultV1Schema = SessionSpawnNewResultV1Schema;
export type SessionServerStartDispatchResultV1 = SessionSpawnNewResultV1;

/**
 * The untrusted machine request deliberately excludes Account, Automation,
 * origin, target, installation, and currentness facts. The server reconstructs
 * those from the authenticated source socket and the active durable Run.
 */
export const SessionServerStartIngressRequestV1Schema = z.object({
  v: z.literal(1),
  kind: z.literal('session.serverStart.ingress'),
  runId: SessionServerStartHostIdV1Schema,
  attempt: z.number().int().positive().safe(),
  requestEnvelope: AutomationSessionStartRequestEnvelopeV1Schema,
}).strict();
export type SessionServerStartIngressRequestV1 = z.infer<
  typeof SessionServerStartIngressRequestV1Schema
>;

/**
 * The server either returns a stamped local dispatch for the authenticated
 * source daemon or completes the exact-machine closed Socket dispatch itself.
 * Both shapes preserve the canonical Session create-or-rejoin result contract.
 */
export const SessionServerStartIngressResponseV1Schema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('local'),
    dispatch: SessionServerStartDispatchRequestV1Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    kind: z.literal('result'),
    result: SessionServerStartDispatchResultV1Schema,
  }).strict(),
]);
export type SessionServerStartIngressResponseV1 = z.infer<
  typeof SessionServerStartIngressResponseV1Schema
>;

/**
 * The target daemon's canonical create-or-rejoin entrypoint contract. Closed
 * server-origin authorization and opaque transport remain outside this
 * plaintext owner boundary; implementations delegate to Session creation.
 */
export type SessionServerStartHandlerV1 = (
  input: SessionSpawnNewInputV2,
  options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<SessionSpawnNewResultV1>;
