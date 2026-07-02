import { z } from 'zod';

import {
  SkillCatalogItemV1Schema,
  SkillCatalogV1Schema,
  VendorPluginCatalogItemV1Schema,
  VendorPluginCatalogV1Schema,
} from '../runtime/catalog/index.js';
import {
  normalizeSessionUsageLimitRecoveryOperationResultV1,
  type SessionUsageLimitRecoveryOperationResultV1,
} from '../sessionControl/sessionUsageLimitRecoveryOperationResultV1.js';
import { SessionUsageLimitRecoveryResumePromptModeV1Schema } from '../session/state/valueSchemas/usageLimitRecovery.js';
import { SessionWorkStateStatusV1Schema, SessionWorkStateV1Schema } from './sessionWorkStateV1.js';

export const SessionWorkStateGetRequestV1Schema = z.object({}).passthrough();
export type SessionWorkStateGetRequestV1 = z.infer<typeof SessionWorkStateGetRequestV1Schema>;

export const SessionWorkStateGetResponseV1Schema = z
  .object({
    workState: SessionWorkStateV1Schema.nullable(),
  })
  .passthrough();
export type SessionWorkStateGetResponseV1 = z.infer<typeof SessionWorkStateGetResponseV1Schema>;

export const SessionGoalGetRequestV1Schema = z.object({}).passthrough();
export type SessionGoalGetRequestV1 = z.infer<typeof SessionGoalGetRequestV1Schema>;

const sessionGoalMutationHasField = (value: Readonly<{
  objective?: unknown;
  status?: unknown;
  tokenBudget?: unknown;
}>): boolean => (
  typeof value.objective === 'string'
  || typeof value.status === 'string'
  || Object.prototype.hasOwnProperty.call(value, 'tokenBudget')
);

const SessionGoalMutationFieldsV1Schema = z
  .object({
    objective: z.string().trim().min(1).max(4000).optional(),
    status: SessionWorkStateStatusV1Schema.optional(),
    tokenBudget: z.number().finite().positive().nullable().optional(),
  })
  .passthrough()
  .refine(sessionGoalMutationHasField, { message: 'At least one goal mutation field is required' });

export const SessionGoalSetRequestV1Schema = SessionGoalMutationFieldsV1Schema;
export type SessionGoalSetRequestV1 = z.infer<typeof SessionGoalSetRequestV1Schema>;

export const SessionInitialGoalRequestV1Schema = SessionGoalSetRequestV1Schema.refine(
  (value) => typeof value.objective === 'string' && value.objective.trim().length > 0,
  { message: 'Initial goal requires an objective' },
);
export type SessionInitialGoalRequestV1 = z.infer<typeof SessionInitialGoalRequestV1Schema>;

export const SessionGoalClearRequestV1Schema = z.object({}).passthrough();
export type SessionGoalClearRequestV1 = z.infer<typeof SessionGoalClearRequestV1Schema>;

export const SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema = z.object({}).passthrough();
export type SessionConnectedServiceAuthInvalidateTransportsRequestV1 =
  z.infer<typeof SessionConnectedServiceAuthInvalidateTransportsRequestV1Schema>;

const SessionIdRequestFieldSchema = z.string().trim().min(1);
const IssueFingerprintFieldSchema = z.string().trim().min(1);

export const SessionUsageLimitWaitResumeEnableRequestV1Schema = z
  .object({
    sessionId: SessionIdRequestFieldSchema,
    issueFingerprint: IssueFingerprintFieldSchema.optional(),
    remember: z.boolean().optional(),
    rememberPreference: z.boolean().optional(),
    resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
  })
  .passthrough();
export type SessionUsageLimitWaitResumeEnableRequestV1 = z.infer<typeof SessionUsageLimitWaitResumeEnableRequestV1Schema>;

export const SessionUsageLimitWaitResumeCancelRequestV1Schema = z
  .object({
    sessionId: SessionIdRequestFieldSchema,
    issueFingerprint: IssueFingerprintFieldSchema.nullable().optional(),
  })
  .passthrough();
export type SessionUsageLimitWaitResumeCancelRequestV1 = z.infer<typeof SessionUsageLimitWaitResumeCancelRequestV1Schema>;

export const SessionUsageLimitCheckNowRequestV1Schema = z
  .object({
    sessionId: SessionIdRequestFieldSchema,
    provider: z.string().trim().min(1).optional(),
    operation: z.enum(['check_now', 'switch_account_now']).optional(),
    resumePromptMode: SessionUsageLimitRecoveryResumePromptModeV1Schema.optional(),
  })
  .passthrough();
export type SessionUsageLimitCheckNowRequestV1 = z.infer<typeof SessionUsageLimitCheckNowRequestV1Schema>;

export const SessionUsageLimitOperationResponseV1Schema = z
  .unknown()
  .transform((value): SessionUsageLimitRecoveryOperationResultV1 => (
    normalizeSessionUsageLimitRecoveryOperationResultV1(value)
  ));
export type SessionUsageLimitOperationResponseV1 = z.infer<typeof SessionUsageLimitOperationResponseV1Schema>;

export const SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({
    ok: z.literal(false),
    error: z.string().trim().min(1),
    errorCode: z.string().trim().min(1).optional(),
  }).passthrough(),
]);
export type SessionConnectedServiceAuthInvalidateTransportsResponseV1 =
  z.infer<typeof SessionConnectedServiceAuthInvalidateTransportsResponseV1Schema>;

export const SessionUsageLimitWaitResumeEnableResponseV1Schema = SessionUsageLimitOperationResponseV1Schema;
export type SessionUsageLimitWaitResumeEnableResponseV1 =
  z.infer<typeof SessionUsageLimitWaitResumeEnableResponseV1Schema>;

export const SessionUsageLimitWaitResumeCancelResponseV1Schema = SessionUsageLimitOperationResponseV1Schema;
export type SessionUsageLimitWaitResumeCancelResponseV1 =
  z.infer<typeof SessionUsageLimitWaitResumeCancelResponseV1Schema>;

export const SessionUsageLimitCheckNowResponseV1Schema = SessionUsageLimitOperationResponseV1Schema;
export type SessionUsageLimitCheckNowResponseV1 = z.infer<typeof SessionUsageLimitCheckNowResponseV1Schema>;

export const DaemonSessionGoalGetRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
  })
  .passthrough();
export type DaemonSessionGoalGetRequestV1 = z.infer<typeof DaemonSessionGoalGetRequestV1Schema>;

export const DaemonSessionGoalSetRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
    objective: z.string().trim().min(1).max(4000).optional(),
    status: SessionWorkStateStatusV1Schema.optional(),
    tokenBudget: z.number().finite().positive().nullable().optional(),
  })
  .passthrough()
  .refine(sessionGoalMutationHasField, { message: 'At least one goal mutation field is required' });
export type DaemonSessionGoalSetRequestV1 = z.infer<typeof DaemonSessionGoalSetRequestV1Schema>;

export const DaemonSessionGoalClearRequestV1Schema = z
  .object({
    sessionId: z.string().trim().min(1),
  })
  .passthrough();
export type DaemonSessionGoalClearRequestV1 = z.infer<typeof DaemonSessionGoalClearRequestV1Schema>;

// Compatibility alias for pre-A.8y clients. New writers must emit
// VendorPluginCatalogItemV1; remove this union arm after deployed clients no
// longer consume daemon.sessionVendorPluginCatalog.list legacy rows.
export const SessionVendorPluginSummaryV1Schema = z
  .object({
    vendorPluginRef: z.string().min(1),
    name: z.string().min(1),
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    installed: z.boolean().optional(),
    enabled: z.boolean().optional(),
    mentionable: z.boolean().optional(),
  })
  .passthrough()
  .transform((item) => ({
    ...item,
    mentionable: item.mentionable ?? (item.installed === true && item.enabled === true),
  }));
export type SessionVendorPluginSummaryV1 = z.infer<typeof SessionVendorPluginSummaryV1Schema>;

const SessionVendorPluginCatalogListItemV1Schema = z.union([
  VendorPluginCatalogItemV1Schema,
  SessionVendorPluginSummaryV1Schema,
]);

export const SessionVendorPluginCatalogListRequestV1Schema = z
  .object({
    cwd: z.string().min(1).optional(),
  })
  .passthrough();
export type SessionVendorPluginCatalogListRequestV1 = z.infer<typeof SessionVendorPluginCatalogListRequestV1Schema>;

export const DaemonSessionVendorPluginCatalogListRequestV1Schema = SessionVendorPluginCatalogListRequestV1Schema
  .extend({
    sessionId: z.string().trim().min(1),
  })
  .passthrough();
export type DaemonSessionVendorPluginCatalogListRequestV1 = z.infer<typeof DaemonSessionVendorPluginCatalogListRequestV1Schema>;

export const SessionVendorPluginCatalogListResponseV1Schema = z
  .object({
    catalog: VendorPluginCatalogV1Schema.optional(),
    vendorPlugins: z.array(SessionVendorPluginCatalogListItemV1Schema).default([]),
    unsupported: z.boolean().optional(),
  })
  .passthrough()
  .transform((response) => ({
    ...response,
    vendorPlugins: response.catalog?.items ?? response.vendorPlugins,
  }));
export type SessionVendorPluginCatalogListResponseV1 = z.infer<typeof SessionVendorPluginCatalogListResponseV1Schema>;

export const SessionSkillCatalogItemV1Schema = SkillCatalogItemV1Schema;
export type SessionSkillCatalogItemV1 = z.infer<typeof SessionSkillCatalogItemV1Schema>;

export const SessionSkillCatalogListRequestV1Schema = SessionVendorPluginCatalogListRequestV1Schema;
export type SessionSkillCatalogListRequestV1 = z.infer<typeof SessionSkillCatalogListRequestV1Schema>;

export const DaemonSessionSkillCatalogListRequestV1Schema = DaemonSessionVendorPluginCatalogListRequestV1Schema;
export type DaemonSessionSkillCatalogListRequestV1 = z.infer<typeof DaemonSessionSkillCatalogListRequestV1Schema>;

export const SessionSkillCatalogListResponseV1Schema = z
  .object({
    catalog: SkillCatalogV1Schema.optional(),
    skills: z.array(SessionSkillCatalogItemV1Schema).default([]),
    unsupported: z.boolean().optional(),
  })
  .passthrough()
  .transform((response) => ({
    ...response,
    skills: response.catalog?.items ?? response.skills,
  }));
export type SessionSkillCatalogListResponseV1 = z.infer<typeof SessionSkillCatalogListResponseV1Schema>;
