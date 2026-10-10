import { z } from 'zod';

import { AgentIdV1Schema } from '@happier-dev/protocol/agents/agentIdV1';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { BackendTargetRefV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { SessionProviderBindingMetadataV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { ProfileRowRevisionV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol/providers/model-selection';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import type {
  AgentCliSessionCommandBuildInputV1,
  AgentCliSessionCommandOptionsV1,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { AgentRuntimeDaemonSessionDescriptorV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { ConnectedServicesBindingsIngressSchema } from '@/daemon/connectedServices/parseConnectedServicesBindings';

const BoundedIdSchema = z.string().trim().min(1).max(256);

export const FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH =
  '/agent-runtime/foreground/admit';
export const FOREGROUND_AGENT_RUNTIME_CLAIM_PATH =
  '/agent-runtime/foreground/claim';
export const HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY =
  'HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE';
export const FOREGROUND_AGENT_RUNTIME_RELEASE_PATH =
  '/agent-runtime/foreground/release';
export const FOREGROUND_AGENT_RUNTIME_SESSION_OPTIONS_PATH =
  '/agent-runtime/foreground/session-options';

const AgentCliSessionCommandParsedArgsV1Schema = z.object({
  startingMode: z.string().optional(),
  directory: z.string().optional(),
  resume: z.string().optional(),
  agentArgs: z.array(z.string()),
}).strict();

export const AgentCliSessionCommandBuildInputV1Schema: z.ZodType<AgentCliSessionCommandBuildInputV1> = z.object({
  isExplicitCliSubcommand: z.boolean(),
  parsed: AgentCliSessionCommandParsedArgsV1Schema,
  settings: z.record(z.string(), StrictJsonValueSchema),
  pluginSettings: z.object({
    account: z.record(z.string(), StrictJsonValueSchema).optional(),
    daemon: z.record(z.string(), StrictJsonValueSchema).optional(),
  }).strict(),
  environment: z.record(z.string(), z.string()),
  startOrigin: z.enum(['terminal', 'daemon']),
}).strict();

export const AgentCliSessionCommandOptionsV1Schema: z.ZodType<AgentCliSessionCommandOptionsV1> = z.record(
  z.string(),
  StrictJsonValueSchema,
);

export const ForegroundAgentRuntimeAdmissionRequestV1Schema = z.object({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  sessionId: BoundedIdSchema,
  existingSessionId: BoundedIdSchema.optional(),
  foregroundPid: z.number().int().positive(),
  directory: z.string().min(1).max(32_768),
  agentId: AgentIdV1Schema,
  backendTarget: BackendTargetRefV2Schema,
  /** Launch intent only; executable authority is still the admitted contribution. */
  agentTarget: AgentExecutionTargetV1Schema.optional(),
  runtimeDescriptorV1: RuntimeDescriptorV1Schema.optional(),
  profileId: BoundedIdSchema.optional(),
  profileRecordRevision: ProfileRowRevisionV1Schema.optional(),
  accountSettingsScopeKey: z.string().min(1).max(1_024).optional(),
  accountSettingsVersion: z.number().int().nonnegative().optional(),
  selection: SessionModelSelectionV1Schema.optional(),
  previousBinding: SessionProviderBindingMetadataV1Schema.nullable().optional(),
  connectedServices: ConnectedServicesBindingsIngressSchema,
  vendorResumeId: BoundedIdSchema.optional(),
  /**
   * Optional one-shot, value-free Saved Secret reference override for this
   * launch. It carries references and revisions only; the daemon materializer
   * stays the sole resolver and the selected Profile is never written.
   *
   * This seam needs no capability negotiation: the admission client calls
   * `ensureDaemonRunningForSessionCommand()` first, which restarts the daemon
   * unless it already runs the exact installed CLI version
   * (`isDaemonRunningCurrentlyInstalledHappyVersion`). A predecessor daemon
   * therefore cannot receive this request, and this schema is `.strict()` so
   * it would reject rather than silently launch with different credentials.
   */
  secretReferenceOverlay: SecretReferenceOverlayV1Schema.optional(),
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
  if (value.secretReferenceOverlay !== undefined && value.profileId === undefined) {
    // The overlay overrides Profile-declared secret requirement bindings, so
    // without a selected Profile there is nothing declared to override.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['secretReferenceOverlay'],
      message:
        'A Saved Secret reference overlay requires an exact selected profileId',
    });
  }
  if (value.profileRecordRevision !== undefined && value.profileId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profileRecordRevision'],
      message: 'A Profile revision requires an exact selected profileId' });
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
        admissionFilePath: z.string().min(1).max(32_768),
        bootstrapFilePath: z.string().min(1).max(32_768),
        authorityFilePath: z.string().min(1).max(32_768),
        descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
      }).strict(),
      /**
       * What the foreground process must submit when it creates the Session:
       * the Team slot bindings that make the admitted durable Team purpose
       * targets usable by this Session at the Home.
       */
      sessionCreation: z.object({
        teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema,
      }).strict().optional(),
      launchPolicy: z.object({
        reservedEnvironmentVariableNames: z.array(BoundedIdSchema).max(256),
        profileSecretRequirementNamesMissingBinding:
          z.array(BoundedIdSchema).max(256),
        nativeHomeSourceEnvironmentKey: BoundedIdSchema.optional(),
      }).strict(),
    }).strict(),
    z.object({
      ok: z.literal(false),
      error: ProviderErrorV1Schema,
    }).strict(),
  ]);

export type ForegroundAgentRuntimeAdmissionResponseV1 =
  z.infer<typeof ForegroundAgentRuntimeAdmissionResponseV1Schema>;

export const ForegroundAgentRuntimeClaimRequestV1Schema = z.object({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  provisionalSessionId: BoundedIdSchema,
  canonicalSessionId: BoundedIdSchema,
  foregroundPid: z.number().int().positive(),
  pluginId: BoundedIdSchema,
  agentId: AgentIdV1Schema,
  occurrenceId: z.string().trim().min(1).max(512),
  sourceCustody: PluginSourceCustodyV1Schema,
  capability: z.string().min(1).max(4_096),
  foregroundSatisfiedProfileSecretRequirementNames:
    z.array(BoundedIdSchema).max(256),
  nativeHomeSourceEnvironmentValue:
    z.string().max(32_768).nullable().optional(),
}).strict();

export type ForegroundAgentRuntimeClaimRequestV1 =
  z.infer<typeof ForegroundAgentRuntimeClaimRequestV1Schema>;

export const ForegroundAgentRuntimeClaimResponseV1Schema =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      environment: z.record(z.string(), z.string()),
      unsetEnvironmentVariableNames: z.array(BoundedIdSchema).max(256),
      sensitiveEnvironmentVariableNames: z.array(BoundedIdSchema).max(256),
    }).strict(),
    z.object({
      ok: z.literal(false),
      error: ProviderErrorV1Schema,
      profileSecretRecovery: z.object({
        requirementNames: z.array(BoundedIdSchema).max(256),
      }).strict().optional(),
    }).strict(),
  ]);

export type ForegroundAgentRuntimeClaimResponseV1 =
  z.infer<typeof ForegroundAgentRuntimeClaimResponseV1Schema>;

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

export const ForegroundAgentRuntimeSessionOptionsRequestV1Schema = z.object({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  sessionId: BoundedIdSchema,
  foregroundPid: z.number().int().positive(),
  input: AgentCliSessionCommandBuildInputV1Schema,
}).strict();

export type ForegroundAgentRuntimeSessionOptionsRequestV1 =
  z.infer<typeof ForegroundAgentRuntimeSessionOptionsRequestV1Schema>;

export const ForegroundAgentRuntimeSessionOptionsResponseV1Schema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    options: AgentCliSessionCommandOptionsV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: ProviderErrorV1Schema,
  }).strict(),
]);

export type ForegroundAgentRuntimeSessionOptionsResponseV1 =
  z.infer<typeof ForegroundAgentRuntimeSessionOptionsResponseV1Schema>;
