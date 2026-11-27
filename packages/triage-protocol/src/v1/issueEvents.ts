import {
  defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import { SessionInputForgeEvidenceV1Schema } from '@happier-dev/plugin-sdk/sessions';
import { TriageConfiguredSourceConnectedAccountInstanceV1Schema, TriageConfiguredSourceInstanceV1Schema } from './instances.js';
import { TriageSourceInstanceIdV1Schema, TriageIdentifierV1ProtocolSchema } from './identity.js';
import { MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1 } from './bounds.js';
import { defineTriageSingleLineStringV1 } from './strings.js';

const closed = { policy: 'closed' } as const;

export const TriageIssueInvestigationV1Schema = defineProtocolObject({
  mode: defineProtocolLiteral('inbox'),
}, closed);

export const TriageIssueEventSetupInputV1Schema = defineProtocolObject({
  sourceInstanceId: TriageSourceInstanceIdV1Schema,
  checkPeriodSeconds: defineProtocolNumber({ integer: true, minimum: 1 }).optional(),
  investigation: TriageIssueInvestigationV1Schema.optional(),
}, closed);

export const TriageIssueEventSourceConfigV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1), instance: TriageConfiguredSourceConnectedAccountInstanceV1Schema,
  checkPeriodMs: defineProtocolNumber({ integer: true, minimum: 1 }),
  investigation: TriageIssueInvestigationV1Schema,
}, closed);
export type TriageIssueEventSourceConfigV1 = ReturnType<typeof TriageIssueEventSourceConfigV1Schema.parse>;

/**
 * A source whose single writer publishes each committed transition itself
 * (an Account-data source such as native Happier exceptions). It has no
 * polling period; the scan-diff observer above never runs for it.
 */
export const TriageIssueCommitPublishedEventSourceConfigV1Schema = defineProtocolObject({
  v: defineProtocolLiteral(1), instance: TriageConfiguredSourceInstanceV1Schema,
  investigation: TriageIssueInvestigationV1Schema,
}, closed);
export type TriageIssueCommitPublishedEventSourceConfigV1 = ReturnType<typeof TriageIssueCommitPublishedEventSourceConfigV1Schema.parse>;

/** Native time is evidence, not a status-change watermark or occurrence identity. */
export const TriageIssueTransitionV1Schema = defineProtocolObject({
  phase: defineProtocolUnion([defineProtocolLiteral('open'), defineProtocolLiteral('updated'), defineProtocolLiteral('resolved')]),
  sourceInstanceId: TriageSourceInstanceIdV1Schema,
  issueFingerprint: TriageIdentifierV1ProtocolSchema,
  issueRef: defineTriageSingleLineStringV1(MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1),
  providerUpdatedAt: defineProtocolNumber({ integer: true, minimum: 0 }),
  evidence: SessionInputForgeEvidenceV1Schema,
}, closed);
export type TriageIssueTransitionV1 = ReturnType<typeof TriageIssueTransitionV1Schema.parse>;
