import { z } from 'zod';

import {
  BackendTargetRefV2Schema,
  ProviderErrorV1Schema,
  SessionModelSelectionV1Schema,
  SessionProviderBindingMetadataV1Schema,
} from '@happier-dev/protocol';

import { AgentRuntimeDaemonSessionDescriptorV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';

const BoundedIdSchema = z.string().trim().min(1).max(256);

export const FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH =
  '/agent-runtime/foreground/admit';
export const FOREGROUND_AGENT_RUNTIME_RELEASE_PATH =
  '/agent-runtime/foreground/release';

export const ForegroundAgentRuntimeAdmissionRequestV1Schema = z.object({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  sessionId: BoundedIdSchema,
  foregroundPid: z.number().int().positive(),
  directory: z.string().min(1).max(32_768),
  agentId: BoundedIdSchema,
  backendTarget: BackendTargetRefV2Schema,
  profileId: BoundedIdSchema.optional(),
  accountSettingsScopeKey: z.string().min(1).max(1_024).optional(),
  accountSettingsVersion: z.number().int().nonnegative().optional(),
  selection: SessionModelSelectionV1Schema.optional(),
  previousBinding: SessionProviderBindingMetadataV1Schema.nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (
    value.profileId !== undefined
    && (
      value.accountSettingsScopeKey === undefined
      || value.accountSettingsVersion === undefined
    )
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['profileId'],
      message:
        'Foreground Profile admission requires an exact account settings scope and version',
    });
  }
});

export type ForegroundAgentRuntimeAdmissionRequestV1 =
  z.infer<typeof ForegroundAgentRuntimeAdmissionRequestV1Schema>;

export type ForegroundAgentRuntimeAdmissionOwnerRequestV1 =
  ForegroundAgentRuntimeAdmissionRequestV1
  & Readonly<{ machineId: string }>;

export const ForegroundAgentRuntimeAdmissionResponseV1Schema =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      capability: z.object({
        attemptId: BoundedIdSchema,
        tokenFilePath: z.string().min(1).max(32_768),
        descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
      }).strict(),
      launchPolicy: z.object({
        reservedEnvironmentVariableNames: z.array(BoundedIdSchema).max(256),
        profileSecretRequirementNamesMissingBinding:
          z.array(BoundedIdSchema).max(256),
      }).strict(),
    }).strict(),
    z.object({
      ok: z.literal(false),
      error: ProviderErrorV1Schema,
    }).strict(),
  ]);

export type ForegroundAgentRuntimeAdmissionResponseV1 =
  z.infer<typeof ForegroundAgentRuntimeAdmissionResponseV1Schema>;

export const ForegroundAgentRuntimeReleaseRequestV1Schema = z.object({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  sessionId: BoundedIdSchema,
}).strict();

export type ForegroundAgentRuntimeReleaseRequestV1 =
  z.infer<typeof ForegroundAgentRuntimeReleaseRequestV1Schema>;

export const ForegroundAgentRuntimeReleaseResponseV1Schema = z.object({
  ok: z.literal(true),
}).strict();
