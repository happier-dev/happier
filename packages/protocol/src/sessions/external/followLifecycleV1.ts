import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';

import {
  buildLinkedExternalSessionMetadataV1,
  LinkedExternalSessionQualifiedIdentityV1Schema,
  readExternalSessionFollowIssueV1,
  readExternalSessionFollowPolicyV1,
  readExternalSessionFollowStatusV1,
  readLinkedExternalSessionV1FromMetadata,
  type ExternalSessionFollowIssueV1,
  type ExternalSessionFollowPolicyV1,
  type ExternalSessionFollowStatusV1,
  type LinkedExternalSessionQualifiedIdentityV1,
  type LinkedExternalSessionV1,
} from './linkedSessionMetadata.js';

export {
  ExternalSessionFollowIssueV1Schema,
  ExternalSessionFollowStatusV1Schema,
  ExternalSessionFollowStatusValueV1Schema,
  readExternalSessionFollowIssueV1,
  readExternalSessionFollowStatusV1,
} from './linkedSessionMetadata.js';
export type {
  ExternalSessionFollowIssueV1,
  ExternalSessionFollowStatusV1,
  ExternalSessionFollowStatusValueV1,
} from './linkedSessionMetadata.js';

export const ExternalSessionCompletedBoundaryV1Schema = z.object({
  id: z.string().trim().min(1).max(1_024),
  observedAtMs: z.number().int().min(0),
}).strict();

export type ExternalSessionCompletedBoundaryV1 = z.infer<
  typeof ExternalSessionCompletedBoundaryV1Schema
>;

export type ExternalSessionCompletedBoundaryReservationV1 =
  | Readonly<{
    outcome: 'reserved';
    boundary: ExternalSessionCompletedBoundaryV1;
  }>
  | Readonly<{
    outcome: 'replay' | 'stale' | 'conflict';
    boundary: ExternalSessionCompletedBoundaryV1;
  }>;

export const EXTERNAL_SESSIONS_AUTO_LINK_SOURCE_POLICIES_MAX_V1 = 128;

const ExternalSessionsMachineIdV1Schema = z.string().trim().min(1).max(256);

export const ExternalSessionsAutoLinkSourcePolicyIdV1Schema = z.string().regex(
  /^es-source-policy:v1:[0-9a-f]{64}$/,
  'External-session auto-link source policy ids must be v1 lowercase SHA-256 identities.',
);
export type ExternalSessionsAutoLinkSourcePolicyIdV1 = z.infer<
  typeof ExternalSessionsAutoLinkSourcePolicyIdV1Schema
>;

const ExternalSessionsAutoLinkSourcePolicyIdInputV1Schema = z.object({
  machineId: ExternalSessionsMachineIdV1Schema,
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  canonicalResolvedSourceKey: z.string()
    .min(1)
    .max(10_000)
    .refine((value) => value.trim().length > 0),
}).strict();

const EXTERNAL_SESSIONS_AUTO_LINK_SOURCE_POLICY_ID_DOMAIN_V1 =
  'happier.external-sessions.auto-link-source-policy.v1';

export function deriveExternalSessionsAutoLinkSourcePolicyIdV1(
  input: Readonly<{
    machineId: string;
    qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
    canonicalResolvedSourceKey: string;
  }>,
): ExternalSessionsAutoLinkSourcePolicyIdV1 {
  const parsed = ExternalSessionsAutoLinkSourcePolicyIdInputV1Schema.parse(input);
  const digestInput = JSON.stringify([
    EXTERNAL_SESSIONS_AUTO_LINK_SOURCE_POLICY_ID_DOMAIN_V1,
    parsed.machineId,
    parsed.qualifiedIdentity.agent.pluginId,
    parsed.qualifiedIdentity.agent.localId,
    parsed.qualifiedIdentity.source.kind,
    parsed.qualifiedIdentity.source.contractVersion,
    parsed.canonicalResolvedSourceKey,
  ]);
  return ExternalSessionsAutoLinkSourcePolicyIdV1Schema.parse(
    `es-source-policy:v1:${bytesToHex(sha256(utf8ToBytes(digestInput)))}`,
  );
}

export const ExternalSessionsAutoLinkSourcePolicyV1Schema = z.object({
  machineId: ExternalSessionsMachineIdV1Schema,
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  sourcePolicyId: ExternalSessionsAutoLinkSourcePolicyIdV1Schema,
  enabledAtMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();

export type ExternalSessionsAutoLinkSourcePolicyV1 = z.infer<
  typeof ExternalSessionsAutoLinkSourcePolicyV1Schema
>;

export type ExternalSessionsAutoLinkSourcePolicyIdentityV1 = Readonly<{
  machineId: string;
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1;
  sourcePolicyId: ExternalSessionsAutoLinkSourcePolicyIdV1;
}>;

const ExternalSessionsAutoLinkSourcePolicyIdentityV1Schema = z.object({
  machineId: ExternalSessionsMachineIdV1Schema,
  qualifiedIdentity: LinkedExternalSessionQualifiedIdentityV1Schema,
  sourcePolicyId: ExternalSessionsAutoLinkSourcePolicyIdV1Schema,
}).strict();

function autoLinkSourcePolicyScopeKey(
  policy: ExternalSessionsAutoLinkSourcePolicyIdentityV1,
): string {
  return JSON.stringify([
    policy.machineId,
    policy.qualifiedIdentity.agent.pluginId,
    policy.qualifiedIdentity.agent.localId,
    policy.qualifiedIdentity.source.kind,
    policy.qualifiedIdentity.source.contractVersion,
    policy.sourcePolicyId,
  ]);
}

export const ExternalSessionsAutoLinkSourcePoliciesV1Schema = z.array(
  ExternalSessionsAutoLinkSourcePolicyV1Schema,
)
  .max(EXTERNAL_SESSIONS_AUTO_LINK_SOURCE_POLICIES_MAX_V1)
  .superRefine((policies, ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < policies.length; index += 1) {
      const key = autoLinkSourcePolicyScopeKey(policies[index]);
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: 'External-session auto-link source policy scopes must be unique.',
        });
      }
      seen.add(key);
    }
  });

export const ExternalSessionsSettingsV1Schema = z.object({
  v: z.literal(1).default(1),
  keepPassivelyFollowingAfterRestart: z.boolean().default(false),
  autoLinkSourcePolicies: ExternalSessionsAutoLinkSourcePoliciesV1Schema
    .default([])
    .catch([]),
}).passthrough();

export type ExternalSessionsSettingsV1 = z.infer<
  typeof ExternalSessionsSettingsV1Schema
>;

export type ExternalSessionsSettingsPatchV1 = Readonly<{
  keepPassivelyFollowingAfterRestart?: boolean;
  autoLinkSourcePolicies?: readonly ExternalSessionsAutoLinkSourcePolicyV1[];
}>;

const ExternalSessionsSettingsPatchV1Schema = z.object({
  keepPassivelyFollowingAfterRestart: z.boolean().optional(),
  autoLinkSourcePolicies: ExternalSessionsAutoLinkSourcePoliciesV1Schema.optional(),
}).strict();

export function readExternalSessionsSettingsV1(
  value: unknown,
): ExternalSessionsSettingsV1 | null {
  const parsed = ExternalSessionsSettingsV1Schema.safeParse(value ?? {});
  if (!parsed.success) return null;
  return parsed.data;
}

export function patchExternalSessionsSettingsV1(
  current: unknown,
  patch: ExternalSessionsSettingsPatchV1,
): ExternalSessionsSettingsV1 {
  const parsedCurrent = readExternalSessionsSettingsV1(current)
    ?? ExternalSessionsSettingsV1Schema.parse({});
  const parsedPatch = ExternalSessionsSettingsPatchV1Schema.parse(patch);
  return ExternalSessionsSettingsV1Schema.parse({
    ...parsedCurrent,
    ...parsedPatch,
  });
}

export function upsertExternalSessionsAutoLinkSourcePolicyV1(
  current: unknown,
  policy: ExternalSessionsAutoLinkSourcePolicyV1,
): ExternalSessionsSettingsV1 {
  const parsedCurrent = readExternalSessionsSettingsV1(current)
    ?? ExternalSessionsSettingsV1Schema.parse({});
  const parsedPolicy = ExternalSessionsAutoLinkSourcePolicyV1Schema.parse(policy);
  const policyKey = autoLinkSourcePolicyScopeKey(parsedPolicy);
  const existingIndex = parsedCurrent.autoLinkSourcePolicies.findIndex(
    (candidate) => autoLinkSourcePolicyScopeKey(candidate) === policyKey,
  );
  const nextPolicies = existingIndex === -1
    ? [...parsedCurrent.autoLinkSourcePolicies, parsedPolicy]
    : parsedCurrent.autoLinkSourcePolicies.map((candidate, index) =>
      index === existingIndex ? parsedPolicy : candidate);

  return patchExternalSessionsSettingsV1(parsedCurrent, {
    autoLinkSourcePolicies: nextPolicies,
  });
}

export function removeExternalSessionsAutoLinkSourcePolicyV1(
  current: unknown,
  identity: ExternalSessionsAutoLinkSourcePolicyIdentityV1,
): ExternalSessionsSettingsV1 {
  const parsedCurrent = readExternalSessionsSettingsV1(current)
    ?? ExternalSessionsSettingsV1Schema.parse({});
  const parsedIdentity = ExternalSessionsAutoLinkSourcePolicyIdentityV1Schema.parse(identity);
  const identityKey = autoLinkSourcePolicyScopeKey(parsedIdentity);
  return patchExternalSessionsSettingsV1(parsedCurrent, {
    autoLinkSourcePolicies: parsedCurrent.autoLinkSourcePolicies.filter(
      (candidate) => autoLinkSourcePolicyScopeKey(candidate) !== identityKey,
    ),
  });
}

/**
 * Reserves the canonical completed-boundary owner before any best-effort effect.
 * Boundary ids are stable opaque identities: a replay remains a replay even when
 * a later observation attaches a newer timestamp.
 */
export function reserveExternalSessionCompletedBoundaryV1(
  current: ExternalSessionCompletedBoundaryV1 | null,
  candidate: ExternalSessionCompletedBoundaryV1,
): ExternalSessionCompletedBoundaryReservationV1 {
  const parsedCandidate = ExternalSessionCompletedBoundaryV1Schema.parse(candidate);
  if (!current) {
    return { outcome: 'reserved', boundary: parsedCandidate };
  }

  const parsedCurrent = ExternalSessionCompletedBoundaryV1Schema.parse(current);
  if (parsedCurrent.id === parsedCandidate.id) {
    return { outcome: 'replay', boundary: parsedCurrent };
  }
  if (parsedCandidate.observedAtMs < parsedCurrent.observedAtMs) {
    return { outcome: 'stale', boundary: parsedCurrent };
  }
  if (parsedCandidate.observedAtMs === parsedCurrent.observedAtMs) {
    return { outcome: 'conflict', boundary: parsedCurrent };
  }
  return { outcome: 'reserved', boundary: parsedCandidate };
}

export function updateLinkedExternalSessionFollowMetadataV1(
  metadata: Record<string, unknown>,
  update: Readonly<{
    followPolicyV1?: ExternalSessionFollowPolicyV1 | null;
    followStatusV1?: ExternalSessionFollowStatusV1 | null;
    lastFollowIssueV1?: ExternalSessionFollowIssueV1 | null;
  }>,
): Record<string, unknown> {
  const current = readLinkedExternalSessionV1FromMetadata(metadata);
  if (!current) return metadata;

  const next: LinkedExternalSessionV1 = { ...current };
  if (update.followPolicyV1 === null) {
    delete next.followPolicyV1;
  } else if (update.followPolicyV1 !== undefined) {
    const policy = readExternalSessionFollowPolicyV1(update.followPolicyV1);
    if (!policy) throw new TypeError('Invalid external-session follow policy.');
    next.followPolicyV1 = policy;
  }

  if (update.followStatusV1 === null) {
    delete next.followStatusV1;
  } else if (update.followStatusV1 !== undefined) {
    const status = readExternalSessionFollowStatusV1(update.followStatusV1);
    if (!status) throw new TypeError('Invalid external-session follow status.');
    next.followStatusV1 = status;
  }

  if (update.lastFollowIssueV1 === null) {
    delete next.lastFollowIssueV1;
  } else if (update.lastFollowIssueV1 !== undefined) {
    const issue = readExternalSessionFollowIssueV1(update.lastFollowIssueV1);
    if (!issue) throw new TypeError('Invalid external-session follow issue.');
    next.lastFollowIssueV1 = issue;
  }

  return buildLinkedExternalSessionMetadataV1(metadata, next);
}
