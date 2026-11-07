import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, defineProtocolUtf8String, TriageCollisionScopeV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1, MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1, TriageConfiguredSourceCredentialInstanceV1Schema, TriageSourceEntryLocalRefV1Schema, TriageSourceFailureV1Schema, TriageSourceObservationV1Schema } from '@happier-dev/triage-protocol/v1';

export const GITHUB_SECURITY_ALERT_ACTION_IDS_V1 = Object.freeze({
  read: 'github/security-alert/read', listLocations: 'github/code-scanning-alert/list-locations', readLocation: 'github/code-scanning-alert/read-location', readFixPullRequest: 'github/dependabot-alert/read-fix-pull-request',
  dismissDependabot: 'github/dependabot-alert/dismiss', reopenDependabot: 'github/dependabot-alert/reopen', dismissCodeScanning: 'github/code-scanning-alert/dismiss', reopenCodeScanning: 'github/code-scanning-alert/reopen',
});
const text = defineProtocolString();
const nonempty = defineProtocolString({ minLength: 1 });
const count = defineProtocolNumber({ integer: true, minimum: 1 });
const target = { v: defineProtocolLiteral(1), instance: TriageConfiguredSourceCredentialInstanceV1Schema, localRef: TriageSourceEntryLocalRefV1Schema, routingToken: defineProtocolUtf8String({ minLength: 1, maxUtf8Bytes: MAX_TRIAGE_ROUTING_TOKEN_UTF8_BYTES_V1 }) };
const ref = <K extends 'dependabot-alert' | 'code-scanning-alert'>(kind: K) => defineProtocolObject({ kindId: defineProtocolLiteral(kind), collisionScope: TriageCollisionScopeV1ProtocolSchema, entryId: defineProtocolUtf8String({ minLength: 1, maxUtf8Bytes: MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1, pattern: '^[1-9][0-9]*$' }) }, { policy: 'closed' });
const unavailable = defineProtocolObject({ kind: defineProtocolLiteral('unavailable'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' });
export const GithubSecurityAlertReadInputV1Schema = defineProtocolObject({ ...target, localRef: defineProtocolUnion([ref('dependabot-alert'), ref('code-scanning-alert')]) }, { policy: 'closed' });
export const GithubCodeScanningInstanceV1Schema = defineProtocolObject({
  ref: text, analysisKey: text, environment: text, category: text, state: text, commitSha: defineProtocolString({ pattern: '^[a-fA-F0-9]{40}$' }),
  path: nonempty, startLine: count, endLine: count, startColumn: count.nullable(), endColumn: count.nullable(), message: text,
}, { policy: 'closed' });
export type GithubCodeScanningInstanceV1 = ReturnType<typeof GithubCodeScanningInstanceV1Schema.parse>;
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const commonDetail = { nativeState: nonempty, severity: nonempty, url: nonempty, dismissedReason: text.nullable(), dismissedComment: text.nullable(), dismissedBy: text.nullable(), dismissedAt: text.nullable(), projectionTruncated: boolean };
const dependabotDetail = defineProtocolObject({ ...commonDetail, summary: text, advisory: text, advisoryId: text.nullable(), packageName: text, ecosystem: text, manifestPath: text, dependencyScope: text.nullable(), relationship: text.nullable(), affectedRange: text.nullable(), patchedVersion: text.nullable() }, { policy: 'closed' });
const scanningDetail = defineProtocolObject({ ...commonDetail, ruleId: text.nullable(), ruleName: text, ruleDescription: text, ruleHelp: text.nullable(), ruleSeverity: text.nullable(), toolName: text, toolVersion: text.nullable(), message: text, location: GithubCodeScanningInstanceV1Schema.nullable() }, { policy: 'closed' });
export const GithubSecurityAlertReadResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('alert'), kindId: defineProtocolLiteral('dependabot-alert'), detail: dependabotDetail, observation: TriageSourceObservationV1Schema }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('alert'), kindId: defineProtocolLiteral('code-scanning-alert'), detail: scanningDetail, observation: TriageSourceObservationV1Schema }, { policy: 'closed' }), unavailable,
]);
export type GithubSecurityAlertReadResultV1 = ReturnType<typeof GithubSecurityAlertReadResultV1Schema.parse>;
export const GithubCodeScanningLocationsInputV1Schema = defineProtocolObject({ ...target, localRef: ref('code-scanning-alert'), limit: defineProtocolNumber({ integer: true, minimum: 1, maximum: 100 }), continuation: nonempty.optional() }, { policy: 'closed' });
export const GithubCodeScanningLocationsResultV1Schema = defineProtocolUnion([defineProtocolObject({ kind: defineProtocolLiteral('locations'), rows: defineProtocolArray(GithubCodeScanningInstanceV1Schema, { maxItems: 100 }), continuation: nonempty.optional(), incomplete: defineProtocolLiteral('pagination').optional() }, { policy: 'closed' }), unavailable]);
export type GithubCodeScanningLocationsResultV1 = ReturnType<typeof GithubCodeScanningLocationsResultV1Schema.parse>;
// The selected provider page and index are re-read before any path/commit is used.
export const GithubCodeScanningLocationInputV1Schema = defineProtocolObject({ ...target, localRef: ref('code-scanning-alert'), limit: defineProtocolNumber({ integer: true, minimum: 1, maximum: 100 }), continuation: nonempty.optional(), selectedInstance: GithubCodeScanningInstanceV1Schema }, { policy: 'closed' });
export const GithubCodeScanningLocationResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('location'), location: GithubCodeScanningInstanceV1Schema, code: text.nullable(), codeUnavailable: TriageSourceFailureV1Schema.optional(), firstLine: count, lastLine: count, totalLines: defineProtocolNumber({ integer: true, minimum: 0 }), sourceUrl: nonempty, projectionTruncated: boolean }, { policy: 'closed' }), unavailable,
]);
export type GithubCodeScanningLocationResultV1 = ReturnType<typeof GithubCodeScanningLocationResultV1Schema.parse>;
export const GithubDependabotFixPullRequestInputV1Schema = defineProtocolObject({ ...target, localRef: ref('dependabot-alert') }, { policy: 'closed' });
export const GithubDependabotFixPullRequestResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('pullRequest'), localRef: TriageSourceEntryLocalRefV1Schema, routingToken: nonempty, url: nonempty, title: text, state: text }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('none') }, { policy: 'closed' }), unavailable,
]);
export type GithubDependabotFixPullRequestResultV1 = ReturnType<typeof GithubDependabotFixPullRequestResultV1Schema.parse>;
export const GITHUB_DEPENDABOT_DISMISS_REASONS_V1 = ['fix_started', 'inaccurate', 'no_bandwidth', 'not_used', 'tolerable_risk'] as const;
export const GITHUB_CODE_SCANNING_DISMISS_REASONS_V1 = ['false positive', "won't fix", 'used in tests', 'mitigated'] as const;
export const GithubDependabotDismissInputV1Schema = defineProtocolObject({ ...target, localRef: ref('dependabot-alert'), reason: defineProtocolUnion([
  defineProtocolLiteral(GITHUB_DEPENDABOT_DISMISS_REASONS_V1[0]), defineProtocolLiteral(GITHUB_DEPENDABOT_DISMISS_REASONS_V1[1]),
  ...GITHUB_DEPENDABOT_DISMISS_REASONS_V1.slice(2).map(reason => defineProtocolLiteral(reason)),
]), comment: text.optional() }, { policy: 'closed' });
export const GithubCodeScanningDismissInputV1Schema = defineProtocolObject({ ...target, localRef: ref('code-scanning-alert'), reason: defineProtocolUnion([
  defineProtocolLiteral(GITHUB_CODE_SCANNING_DISMISS_REASONS_V1[0]), defineProtocolLiteral(GITHUB_CODE_SCANNING_DISMISS_REASONS_V1[1]),
  ...GITHUB_CODE_SCANNING_DISMISS_REASONS_V1.slice(2).map(reason => defineProtocolLiteral(reason)),
]), comment: text.optional() }, { policy: 'closed' });
export const GithubDependabotReopenInputV1Schema = GithubDependabotFixPullRequestInputV1Schema;
export const GithubCodeScanningReopenInputV1Schema = defineProtocolObject({ ...target, localRef: ref('code-scanning-alert') }, { policy: 'closed' });
export const GithubSecurityAlertMutationResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ kind: defineProtocolLiteral('applied'), effect: defineProtocolUnion([defineProtocolLiteral('changed'), defineProtocolLiteral('alreadySatisfied')]), observation: TriageSourceObservationV1Schema }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('refused'), reason: nonempty, observation: TriageSourceObservationV1Schema.optional() }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('uncertain'), failure: TriageSourceFailureV1Schema.optional(), observation: TriageSourceObservationV1Schema.optional() }, { policy: 'closed' }),
  defineProtocolObject({ kind: defineProtocolLiteral('failed'), failure: TriageSourceFailureV1Schema }, { policy: 'closed' }),
]);
export type GithubSecurityAlertMutationResultV1 = ReturnType<typeof GithubSecurityAlertMutationResultV1Schema.parse>;
