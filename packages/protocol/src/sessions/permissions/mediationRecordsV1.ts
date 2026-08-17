import { z } from 'zod';
import { asProtocolZod } from "../../plugins/actions/internalProtocolZodAdapter.js";

import { computeCanonicalDomainSeparatedDigest } from '../../crypto/canonicalDigest.js';
import { PluginIdSchema } from '../../plugins/pluginId.js';
import { SessionPermissionSourceAuthorityV1Schema } from '../messages/sessionInputAdmission.js';
import { SessionIdSchema, TurnIdSchema } from '../idsV1.js';
import {
  SessionPermissionExternalHumanDecisionActorV1Schema,
  SessionPermissionGrantIdV1Schema,
  SessionPermissionIdempotencyKeyV1Schema,
  SessionPermissionRequestIdV1Schema,
  SessionPermissionSettlementIdV1Schema,
} from './v1.js';

export const SESSION_PERMISSION_SYSTEM_RECORD_NAMESPACE = 'permission' as const;
export const SESSION_PERMISSION_SYSTEM_RECORD_KINDS = [
  'remote_settlement.v1',
  'remote_grant.v1',
] as const;

/**
 * The bounded System Record locator for a mediation row's causal
 * turn/request identity. It is an address key, never a second persistence
 * identity: Session scope and the exact causal tuple are persisted separately
 * by the containing Session System Record row.
 */
export const SESSION_PERMISSION_MEDIATION_RECORD_LOCATOR_V1_PREFIX = 'pmr1.' as const;
export const SESSION_REMOTE_PERMISSION_MEDIATION_ROW_BYTES_MAX = 8 * 1024;
export const SESSION_REMOTE_PERMISSION_MEDIATION_ROWS_MAX = 1_024;
export const SESSION_REMOTE_PERMISSION_ACTIVE_GRANTS_MAX = 256;

const UTF8_ENCODER = new TextEncoder();
const SESSION_PERMISSION_MEDIATION_RECORD_LOCATOR_V1_DOMAIN =
  'happier.session.permission-mediation-record-locator.v1';

function boundedNfcIdentifier(maxBytes: number, label: string) {
  return z.string()
    .refine((value) => value === value.normalize('NFC'), `${label} must be NFC-normalized`)
    .refine((value) => value === value.trim() && value.length > 0, `${label} must be trimmed and nonempty`)
    .refine((value) => UTF8_ENCODER.encode(value).byteLength <= maxBytes, `${label} exceeds its UTF-8 byte limit`);
}

const SessionPermissionToolIdentifierV1Schema = boundedNfcIdentifier(1_024, 'Permission tool identifiers');

export const SessionPermissionMediationRecordLocatorV1Schema = z.string()
  .regex(/^pmr1\.[A-Za-z0-9_-]{43}$/u, 'Expected a canonical mediation row locator');
export type SessionPermissionMediationRecordLocatorV1 = z.infer<
  typeof SessionPermissionMediationRecordLocatorV1Schema
>;

/**
 * One remote mediation row is scoped by its containing Session and bound to
 * the exact causal turn/request pair. Persisted record payloads carry the
 * turn/request portion; the host route and Session-system-record row carry
 * the Session scope.
 */
export const SessionPermissionMediationRecordIdentityV1Schema = z.object({
  sessionId: asProtocolZod(SessionIdSchema),
  turnId: TurnIdSchema,
  requestId: SessionPermissionRequestIdV1Schema,
}).strict();
export type SessionPermissionMediationRecordIdentityV1 = z.infer<
  typeof SessionPermissionMediationRecordIdentityV1Schema
>;

/**
 * Derives the sole bounded row locator from the validated causal tuple. The
 * Session id is deliberately excluded because the containing Session table
 * partition and route already enforce that scope.
 */
export function deriveSessionPermissionMediationRecordLocatorV1(
  input: z.input<typeof SessionPermissionMediationRecordIdentityV1Schema>,
): SessionPermissionMediationRecordLocatorV1 {
  const identity = SessionPermissionMediationRecordIdentityV1Schema.parse(input);
  return SessionPermissionMediationRecordLocatorV1Schema.parse(
    `${SESSION_PERMISSION_MEDIATION_RECORD_LOCATOR_V1_PREFIX}${computeCanonicalDomainSeparatedDigest(
      SESSION_PERMISSION_MEDIATION_RECORD_LOCATOR_V1_DOMAIN,
      [identity.turnId, identity.requestId],
    )}`,
  );
}

export const SessionPermissionRemoteRevocationActorV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accountUser'),
    accountId: boundedNfcIdentifier(191, 'Account ids'),
  }).strict(),
  z.object({
    kind: z.literal('mediatorPlugin'),
    pluginId: asProtocolZod(PluginIdSchema),
  }).strict(),
]);
export type SessionPermissionRemoteRevocationActorV1 = z.infer<
  typeof SessionPermissionRemoteRevocationActorV1Schema
>;

const SessionPermissionRemoteMediationEffectV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allowOnce') }).strict(),
  z.object({ kind: z.literal('deny') }).strict(),
  z.object({
    kind: z.literal('sessionGrant'),
    grantId: SessionPermissionGrantIdV1Schema,
    rule: z.object({
      kind: z.literal('exactTool'),
      identifier: SessionPermissionToolIdentifierV1Schema,
    }).strict(),
  }).strict(),
]);
export type SessionPermissionRemoteMediationEffectV1 = z.infer<
  typeof SessionPermissionRemoteMediationEffectV1Schema
>;

const SessionPermissionRemoteMediationRecordBaseV1Schema = (
  SessionPermissionMediationRecordIdentityV1Schema.pick({
    turnId: true,
    requestId: true,
  }).extend({
  version: z.literal(1),
  settlementId: SessionPermissionSettlementIdV1Schema,
  mediatorPluginId: asProtocolZod(PluginIdSchema),
  idempotencyKey: SessionPermissionIdempotencyKeyV1Schema,
  sourceAuthority: SessionPermissionSourceAuthorityV1Schema,
  actor: SessionPermissionExternalHumanDecisionActorV1Schema,
  decision: z.enum(['allow', 'deny']),
  requestedScope: z.enum(['request', 'session']),
  effect: SessionPermissionRemoteMediationEffectV1Schema,
  createdAtMs: z.number().int().nonnegative(),
  revoked: z.object({
    atMs: z.number().int().nonnegative(),
    actor: SessionPermissionRemoteRevocationActorV1Schema,
  }).strict().optional(),
}).strict()
);

function addRemoteMediationInvariantIssues(
  value: z.infer<typeof SessionPermissionRemoteMediationRecordBaseV1Schema>,
  context: z.RefinementCtx,
): void {
  if (value.sourceAuthority.mediatorPluginId !== value.mediatorPluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceAuthority', 'mediatorPluginId'],
      message: 'Remote permission source authority must match the stamped mediator plugin',
    });
  }
  if (value.actor.assertedBy.pluginId !== value.mediatorPluginId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actor', 'assertedBy', 'pluginId'],
      message: 'Remote permission actor must be asserted by the stamped mediator plugin',
    });
  }
  if (
    value.decision === 'allow'
    && value.sourceAuthority.remoteApprovalMaxScope === 'off'
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sourceAuthority', 'remoteApprovalMaxScope'],
      message: 'Remote permission allow records require remote approval to be enabled',
    });
  }
  const encoded = UTF8_ENCODER.encode(JSON.stringify(value));
  if (encoded.byteLength > SESSION_REMOTE_PERMISSION_MEDIATION_ROW_BYTES_MAX) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Remote permission mediation record exceeds its byte limit',
    });
  }
}

export const SessionPermissionRemoteSettlementRecordV1Schema = (
  SessionPermissionRemoteMediationRecordBaseV1Schema
    .superRefine((value, context) => {
      addRemoteMediationInvariantIssues(value, context);
      if (value.revoked) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['revoked'],
          message: 'Remote settlement records cannot carry grant revocation state',
        });
      }
      if (value.decision === 'allow') {
        if (value.requestedScope !== 'request' || value.effect.kind !== 'allowOnce') {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['effect'],
            message: 'Request-scoped remote allow must have the allow-once effect',
          });
        }
      } else if (value.effect.kind !== 'deny') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effect'],
          message: 'Remote deny must have the deny effect',
        });
      }
    })
);
export type SessionPermissionRemoteSettlementRecordV1 = z.infer<
  typeof SessionPermissionRemoteSettlementRecordV1Schema
>;

export const SessionPermissionRemoteGrantRecordV1Schema = (
  SessionPermissionRemoteMediationRecordBaseV1Schema
    .superRefine((value, context) => {
      addRemoteMediationInvariantIssues(value, context);
      if (
        value.decision !== 'allow'
        || value.requestedScope !== 'session'
        || value.effect.kind !== 'sessionGrant'
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['effect'],
          message: 'Remote grant records require a session-scoped allow with one exact tool grant',
        });
      }
      if (value.sourceAuthority.remoteApprovalMaxScope !== 'session') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sourceAuthority', 'remoteApprovalMaxScope'],
          message: 'Remote session grants require a source authority that permits session scope',
        });
      }
    })
);
export type SessionPermissionRemoteGrantRecordV1 = z.infer<
  typeof SessionPermissionRemoteGrantRecordV1Schema
>;

export const SessionPermissionRemoteMediationRecordV1Schema = z.union([
  SessionPermissionRemoteSettlementRecordV1Schema,
  SessionPermissionRemoteGrantRecordV1Schema,
]);
export type SessionPermissionRemoteMediationRecordV1 = z.infer<
  typeof SessionPermissionRemoteMediationRecordV1Schema
>;
