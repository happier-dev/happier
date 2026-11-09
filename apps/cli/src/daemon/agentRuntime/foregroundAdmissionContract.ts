import { z } from 'zod/mini';
export { HAPPIER_FOREGROUND_AGENT_RUNTIME_ADMISSION_FILE_ENV_KEY } from '@/agent/runtime/session/process/agentRuntimeRunnerEnvironment';

import { AgentIdV1Schema } from '@happier-dev/protocol/agents/agentIdV1';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { RuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor';
import { BackendTargetRefV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { SessionSpawnLaunchErrorV1Schema } from '@happier-dev/protocol/spawnSession';
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
import { AgentRuntimeDaemonSessionDescriptorV1Schema, AgentSessionConnectedAccountsV1Schema } from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';
import { ConnectedServicesBindingsIngressSchema } from '@/daemon/connectedServices/parseConnectedServicesBindings';
import { ProjectSetupReviewV1Schema } from '@happier-dev/protocol/actions/projectSetupConsentFailure';

const BoundedIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));

export const FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH =
  '/agent-runtime/foreground/admit';
export const FOREGROUND_AGENT_RUNTIME_CLAIM_PATH =
  '/agent-runtime/foreground/claim';
export const FOREGROUND_AGENT_RUNTIME_RELEASE_PATH =
  '/agent-runtime/foreground/release';
export const FOREGROUND_AGENT_RUNTIME_SESSION_OPTIONS_PATH =
  '/agent-runtime/foreground/session-options';

const AgentCliSessionCommandParsedArgsV1Schema = z.strictObject({
  startingMode: z.optional(z.string()),
  directory: z.optional(z.string()),
  resume: z.optional(z.string()),
  agentArgs: z.array(z.string()),
});

export const AgentCliSessionCommandBuildInputV1Schema: z.ZodMiniType<AgentCliSessionCommandBuildInputV1> = z.strictObject({
  isExplicitCliSubcommand: z.boolean(),
  parsed: AgentCliSessionCommandParsedArgsV1Schema,
  settings: z.record(z.string(), StrictJsonValueSchema),
  pluginSettings: z.strictObject({
    account: z.optional(z.record(z.string(), StrictJsonValueSchema)),
    daemon: z.optional(z.record(z.string(), StrictJsonValueSchema)),
  }),
  environment: z.record(z.string(), z.string()),
  startOrigin: z.enum(['terminal', 'daemon']),
});

export const AgentCliSessionCommandOptionsV1Schema: z.ZodMiniType<AgentCliSessionCommandOptionsV1> = z.record(
  z.string(),
  StrictJsonValueSchema,
);

export const ForegroundAgentRuntimeAdmissionRequestV1Schema = z.strictObject({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  sessionId: BoundedIdSchema,
  existingSessionId: z.optional(BoundedIdSchema),
  foregroundPid: z.number().check(z.int(), z.positive()),
  directory: z.string().check(z.minLength(1), z.maxLength(32_768)),
  agentId: AgentIdV1Schema,
  backendTarget: BackendTargetRefV2Schema,
  /** Launch intent only; executable authority is still the admitted contribution. */
  agentTarget: z.optional(AgentExecutionTargetV1Schema),
  runtimeDescriptorV1: z.optional(RuntimeDescriptorV1Schema),
  profileId: z.optional(BoundedIdSchema),
  profileRecordRevision: z.optional(ProfileRowRevisionV1Schema),
  accountSettingsScopeKey: z.optional(z.string().check(z.minLength(1), z.maxLength(1_024))),
  accountSettingsVersion: z.optional(z.number().check(z.int(), z.nonnegative())),
  selection: z.optional(SessionModelSelectionV1Schema),
  previousBinding: z.optional(z.nullable(SessionProviderBindingMetadataV1Schema)),
  connectedServices: ConnectedServicesBindingsIngressSchema,
  vendorResumeId: z.optional(BoundedIdSchema),
  /**
   * Optional one-shot, value-free Saved Secret reference override for this
   * launch. It carries references and revisions only; the daemon materializer
   * stays the sole resolver and the selected Profile is never written.
   *
   * The admission client checks daemon ownership with
   * `ensureDaemonRunningForSessionCommand()` first. A conflicting or
   * service-managed daemon may remain, so strict request parsing must reject
   * unsupported credential intent rather than silently launch differently.
   * The control client also refuses unsupported or invalid responses.
   */
  secretReferenceOverlay: z.optional(SecretReferenceOverlayV1Schema),
}).check(z.superRefine((value, ctx) => {
  if (
    value.profileId !== undefined
    && (
      value.accountSettingsScopeKey === undefined
      || value.accountSettingsVersion === undefined
    )
  ) {
    ctx.addIssue({
      code: "custom",
      path: ['profileId'],
      message:
        'Foreground Profile admission requires an exact account settings scope and version',
    });
  }
  if (value.secretReferenceOverlay !== undefined && value.profileId === undefined) {
    // The overlay overrides Profile-declared secret requirement bindings, so
    // without a selected Profile there is nothing declared to override.
    ctx.addIssue({
      code: "custom",
      path: ['secretReferenceOverlay'],
      message:
        'A Saved Secret reference overlay requires an exact selected profileId',
    });
  }
  if (value.profileRecordRevision !== undefined && value.profileId === undefined) {
    ctx.addIssue({ code: "custom", path: ['profileRecordRevision'],
      message: 'A Profile revision requires an exact selected profileId' });
  }
}));

export type ForegroundAgentRuntimeAdmissionRequestV1 =
  z.infer<typeof ForegroundAgentRuntimeAdmissionRequestV1Schema>;

export type ForegroundAgentRuntimeAdmissionOwnerRequestV1 =
  ForegroundAgentRuntimeAdmissionRequestV1
  & Readonly<{ machineId: string }>;

/** Project admission is independent of Provider authentication and contains no launch material. */
export const ForegroundProjectAgentLaunchRefusalV1Schema = z.strictObject({
  code: z.literal('project_agent_launch_refused'),
  reason: z.string().check(z.regex(/^[a-z][a-z0-9_]*$/iu)),
  setupReview: z.optional(ProjectSetupReviewV1Schema),
});

export type ForegroundProjectAgentLaunchRefusalV1 =
  z.infer<typeof ForegroundProjectAgentLaunchRefusalV1Schema>;

export const ForegroundAgentRuntimeAdmissionResponseV1Schema =
  z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      capability: z.strictObject({
        attemptId: BoundedIdSchema,
        admissionFilePath: z.string().check(z.minLength(1), z.maxLength(32_768)),
        bootstrapFilePath: z.string().check(z.minLength(1), z.maxLength(32_768)),
        authorityFilePath: z.string().check(z.minLength(1), z.maxLength(32_768)),
        descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
      }),
      /**
       * What the foreground process must submit when it creates the Session:
       * the Team slot bindings that make the admitted durable Team purpose
       * targets usable by this Session at the Home.
       */
      sessionCreation: z.optional(z.strictObject({
        teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema,
      })),
      launchPolicy: z.strictObject({
        reservedEnvironmentVariableNames: z.array(BoundedIdSchema).check(z.maxLength(256)),
        profileSecretRequirementNamesMissingBinding:
          z.array(BoundedIdSchema).check(z.maxLength(256)),
        nativeHomeSourceEnvironmentKey: z.optional(BoundedIdSchema),
      }),
    }),
    z.strictObject({
      ok: z.literal(false),
      error: z.union([ProviderErrorV1Schema, ForegroundProjectAgentLaunchRefusalV1Schema, SessionSpawnLaunchErrorV1Schema]),
    }),
  ]);

export type ForegroundAgentRuntimeAdmissionResponseV1 =
  z.infer<typeof ForegroundAgentRuntimeAdmissionResponseV1Schema>;

export const ForegroundAgentRuntimeClaimRequestV1Schema = z.strictObject({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  provisionalSessionId: BoundedIdSchema,
  canonicalSessionId: BoundedIdSchema,
  foregroundPid: z.number().check(z.int(), z.positive()),
  pluginId: BoundedIdSchema,
  agentId: AgentIdV1Schema,
  occurrenceId: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  sourceCustody: PluginSourceCustodyV1Schema,
  capability: z.string().check(z.minLength(1), z.maxLength(4_096)),
  foregroundSatisfiedProfileSecretRequirementNames:
    z.array(BoundedIdSchema).check(z.maxLength(256)),
  nativeHomeSourceEnvironmentValue:
    z.optional(z.nullable(z.string().check(z.maxLength(32_768)))),
});

export type ForegroundAgentRuntimeClaimRequestV1 =
  z.infer<typeof ForegroundAgentRuntimeClaimRequestV1Schema>;

export const ForegroundAgentRuntimeClaimResponseV1Schema =
  z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      environment: z.record(z.string(), z.string()),
      sessionConnectedAccounts: z.optional(AgentSessionConnectedAccountsV1Schema),
      unsetEnvironmentVariableNames: z.array(BoundedIdSchema).check(z.maxLength(256)),
      sensitiveEnvironmentVariableNames: z.array(BoundedIdSchema).check(z.maxLength(256)),
    }),
    z.strictObject({
      ok: z.literal(false),
      error: ProviderErrorV1Schema,
      profileSecretRecovery: z.optional(z.strictObject({
        requirementNames: z.array(BoundedIdSchema).check(z.maxLength(256)),
      })),
    }),
  ]);

export type ForegroundAgentRuntimeClaimResponseV1 =
  z.infer<typeof ForegroundAgentRuntimeClaimResponseV1Schema>;

export const ForegroundAgentRuntimeReleaseRequestV1Schema = z.strictObject({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  sessionId: BoundedIdSchema,
});

export type ForegroundAgentRuntimeReleaseRequestV1 =
  z.infer<typeof ForegroundAgentRuntimeReleaseRequestV1Schema>;

export const ForegroundAgentRuntimeReleaseResponseV1Schema = z.strictObject({
  ok: z.literal(true),
});

export const ForegroundAgentRuntimeSessionOptionsRequestV1Schema = z.strictObject({
  v: z.literal(1),
  attemptId: BoundedIdSchema,
  sessionId: BoundedIdSchema,
  foregroundPid: z.number().check(z.int(), z.positive()),
  input: AgentCliSessionCommandBuildInputV1Schema,
});

export type ForegroundAgentRuntimeSessionOptionsRequestV1 =
  z.infer<typeof ForegroundAgentRuntimeSessionOptionsRequestV1Schema>;

export const ForegroundAgentRuntimeSessionOptionsResponseV1Schema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    options: AgentCliSessionCommandOptionsV1Schema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: ProviderErrorV1Schema,
  }),
]);

export type ForegroundAgentRuntimeSessionOptionsResponseV1 =
  z.infer<typeof ForegroundAgentRuntimeSessionOptionsResponseV1Schema>;
