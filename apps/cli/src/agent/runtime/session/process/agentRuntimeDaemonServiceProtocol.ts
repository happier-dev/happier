import { z } from 'zod/mini';
import { SessionAgentSpawnPolicyV1StrictSchema } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import { SessionAgentStartAllowListsV1StrictSchema } from '@happier-dev/protocol/account/settings/sessionAgentStartAllowListsV1';
import { RUNNER_EXECUTION_RUN_SNAPSHOT_OPERATIONS, RUNNER_EXECUTION_RUN_SNAPSHOT_RESULTS } from './executionRunSnapshotProtocol';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ReviewCommentPrincipalHeaderV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { PluginIdSchema } from '@happier-dev/protocol/plugins/plugin-id';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { PluginMachineMaterializationRefV1Schema } from '@happier-dev/protocol/plugins/availability/materializationRefV1';
import { ManagedExecutableRefSchema } from '@happier-dev/protocol/plugins/contributions/agentAcpTransport';
import { AgentSessionTeamProviderBindingV1Schema } from '@happier-dev/protocol/providers/sessions/agentSessionProviderBindingV1';
import { SessionEnvOverlayV1Schema } from '@happier-dev/protocol/spawn/envOverlay';
import { SessionInputEnqueueResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionPendingEnqueueByMachineRequestV1Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SessionPendingExecutionRunEnqueueByMachineRequestV2Schema } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import { ProviderBrokerConsumerV1Schema } from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { ProviderRuntimeBindingBasisV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { QualifiedConnectedAccountPurposeV1Schema } from '@happier-dev/protocol/connect/connectedAccountPurposeIdentity';
import { QualifiedConnectedAccountPurposeBindingV1Schema, QualifiedConnectedAccountPurposeBindingTargetV1Schema } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { TeamCredentialRouteV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { SessionIdSchema } from '@happier-dev/protocol/sessions/idsV1';
import { RunnerDaemonPluginServicesPreparationCauseV1Schema, SessionRuntimeTeamCredentialDenialDetailsV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { WorkflowProjectTargetV1Schema } from '@happier-dev/protocol/workflows/workflowWorkspaceV1';
import { McpRequestAuthOpenV1Schema, McpRequestAuthCloseV1Schema, McpRequestAuthResultV1Schema, McpRequestAuthClosedV1Schema } from '@/mcp/runtime/mcpRequestAuth';
import { RUNNER_PLUGIN_MCP_OPERATIONS, RUNNER_PLUGIN_MCP_RESULTS } from './runnerPluginMcpProtocol';

import {
  AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema,
  AgentRuntimeDaemonProviderConnectionModelRefV1Schema,
  AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema,
  AgentRuntimeDaemonSessionOpenRequestV1Schema,
  AgentRuntimeDaemonTurnContributionRequestV1Schema,
  AgentRuntimeDaemonTurnContributionsResultV1Schema,
} from './agentRuntimeRunnerProtocol';
import {
  createManagedServiceEndpointProjectionV1,
  parseManagedServiceEndpointProjectionV1,
  type ManagedServiceEndpointProjectionInputV1,
  type ManagedServiceEndpointProjectionV1,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import {
  RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS,
  RunnerAgentDaemonFacetResultV1Schema,
} from './agentRuntimeDaemonFacetProtocol';
import {
  RUNNER_DAEMON_PLUGIN_SERVICE_OPERATION_V1_SCHEMAS,
  RunnerDaemonPluginServiceResultV1Schema,
} from './agentRuntimeDaemonPluginServicesProtocol';
import {
  AgentRuntimeDaemonServiceTurnWitnessV1Schema,
} from './agentRuntimeDaemonServiceTurnWitness';

export {
  RunnerDaemonPluginServicesPreparationCauseV1Schema,
  type RunnerDaemonPluginServicesPreparationCauseV1,
} from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

export {
  AgentRuntimeDaemonServiceTurnWitnessV1Schema,
} from './agentRuntimeDaemonServiceTurnWitness';

export const AGENT_RUNTIME_DAEMON_SERVICES_PATH =
  '/agent-runtime/session/services/v1';

const OpaqueIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(512));
// Host-private projection: never transport the requester's Account document.
const AgentStartPolicyV1Schema = z.strictObject({
  workDepthLimit: z.int().check(z.gte(0)),
  sessionAgentStartAllowListsV1: asHostProtocolZod(SessionAgentStartAllowListsV1StrictSchema),
  sessionAgentSpawnPolicyV1: asHostProtocolZod(SessionAgentSpawnPolicyV1StrictSchema),
});
const ActionExecuteSuccessSchema = z.strictObject({
  ok: z.literal(true),
  result: z.unknown(),
});
const ActionExecuteResultSchema = z.custom<ActionExecuteResult>((value) => {
  if (ActionExecuteFailureSchema.safeParse(value).success) return true;
  return ActionExecuteSuccessSchema.safeParse(value).success
    && Object.prototype.hasOwnProperty.call(value, 'result');
});
const ProjectionTokenSchema = z.string().check(z.regex(/^[a-f0-9]{64}$/u));
const CanonicalOriginSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(2_048));
const DeclaredSecretValueSchema = z.string().check(z.maxLength(65_536));
const EnvironmentKeySchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));
const ManagedProviderBindingProofShape = {
  executionRunId: OpaqueIdSchema,
  executionRunOccurrenceId: OpaqueIdSchema,
  agentId: OpaqueIdSchema,
  modelId: OpaqueIdSchema,
  runtimeBindingBasis: asHostProtocolZod(ProviderRuntimeBindingBasisV1Schema),
  expectedAccountSettingsScopeKey: z.string().check(z.minLength(1)),
};
const EnvironmentKeysSchema = z.array(EnvironmentKeySchema).check(z.maxLength(256), z.superRefine((keys, context) => {
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: 'custom',
        message: 'Environment keys must be unique',
      });
    }
  }));
const ResolvedManagedServiceLaunchSchema = z.strictObject({
  command: z.string().check(z.trim(), z.minLength(1), z.maxLength(8_192)),
  args: z.optional(z.array(z.string().check(z.maxLength(16_384))).check(z.maxLength(4_096))),
  env: z.optional(z.record(
    EnvironmentKeySchema,
    z.string().check(z.maxLength(65_536)),
  ).check(z.refine((value) => Object.keys(value).length <= 256))),
  allowedArguments:
    z.optional(z.array(z.string().check(z.maxLength(16_384))).check(z.maxLength(4_096))),
});
const AuthorizedManagedServiceLaunchSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('daemonResolved'),
    value: ResolvedManagedServiceLaunchSchema,
  }),
  z.strictObject({
    kind: z.literal('runnerPackagedRuntime'),
  }),
]);
const SessionRunnerManagedServiceEndpointProjectionInputV1Schema =
  z.custom<ManagedServiceEndpointProjectionInputV1>((value) => {
    try {
      return createManagedServiceEndpointProjectionV1(
        value as ManagedServiceEndpointProjectionInputV1,
      ).custodyOwner === 'sessionRunner';
    } catch {
      return false;
    }
  });
const ManagedServiceEndpointProjectionV1Schema =
  z.custom<ManagedServiceEndpointProjectionV1>(
    (value) => parseManagedServiceEndpointProjectionV1(value) !== null,
  );

export const AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema =
  z.strictObject({
    request: AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema,
    providerSessionId: z.nullable(OpaqueIdSchema),
    refusal: z.optional(z.strictObject({ code: z.literal('native_agent_session_mode_unavailable') })),
  });

export type AgentRuntimeDaemonServiceSessionOpenAttestationV1 =
  z.infer<
    typeof AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema
  >;

export const AgentRuntimeDaemonServiceRequestV1Schema = z.strictObject({
  v: z.literal(1),
  context: z.strictObject({
    token: z.string().check(z.regex(/^[A-Za-z0-9_-]{43}$/u)),
    sessionId: asHostProtocolZod(SessionIdSchema),
    executionRunSnapshotId: z.optional(z.uuid()),
  }),
  operation: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('agent_start.policy.read') }),
    z.strictObject({ kind: z.literal('execution_run.review_plugin_authority.resolve_v1'),
      pluginId: asHostProtocolZod(PluginIdSchema) }),
    ...RUNNER_EXECUTION_RUN_SNAPSHOT_OPERATIONS,
    McpRequestAuthOpenV1Schema,
    McpRequestAuthCloseV1Schema,
    ...RUNNER_PLUGIN_MCP_OPERATIONS,
    ...RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS,
    ...RUNNER_DAEMON_PLUGIN_SERVICE_OPERATION_V1_SCHEMAS,
    z.strictObject({
      kind: z.literal('action.execute'),
      surface: z.optional(z.enum(['agent', 'mcp'])),
      reviewCommentPrincipal: z.optional(asHostProtocolZod(ReviewCommentPrincipalHeaderV1Schema)),
      executionRun: z.optional(z.strictObject({ runId: OpaqueIdSchema, occurrenceId: OpaqueIdSchema })),
      /** Host-selected Session/Run workspace, separate from authored SCM input. */
      scmWorkspace: z.optional(asHostProtocolZod(WorkflowProjectTargetV1Schema)),
      requestId: OpaqueIdSchema,
      actionId: asHostProtocolZod(ActionIdSchema),
      input: z.unknown(),
      witness: AgentRuntimeDaemonServiceTurnWitnessV1Schema,
      toolCallId: z.optional(OpaqueIdSchema),
    }).check(z.refine((operation) => Object.prototype.hasOwnProperty.call(operation, 'input'), {
      path: ['input'],
      message: 'Action input must be present',
    })),
    z.strictObject({
      kind: z.literal('session.open.attest'),
      requestId: OpaqueIdSchema,
      phase: z._default(z.enum(['prepare', 'commit', 'refused']), 'commit'),
      request: AgentRuntimeDaemonSessionOpenRequestV1Schema,
      providerSessionId: z.nullable(OpaqueIdSchema),
    }),
    z.strictObject({
      kind: z.literal('turn.admission.authorize'),
      requestId: OpaqueIdSchema,
      witness: AgentRuntimeDaemonServiceTurnWitnessV1Schema,
    }),
    z.strictObject({
      kind: z.literal('turn_contributions.resolve'),
      requestId: OpaqueIdSchema,
      request:
        AgentRuntimeDaemonTurnContributionRequestV1Schema,
    }),
    z.strictObject({
      kind: z.literal('session.input.admit'),
      requestId: OpaqueIdSchema,
      request: z.union([asHostProtocolZod(SessionPendingEnqueueByMachineRequestV1Schema), asHostProtocolZod(SessionPendingExecutionRunEnqueueByMachineRequestV2Schema)]),
    }),
    z.strictObject({
      kind: z.literal('model_transition.authorize'),
      requestId: OpaqueIdSchema,
      selection:
        AgentRuntimeDaemonProviderConnectionModelRefV1Schema,
    }),
    z.strictObject({
      kind: z.literal('provider_managed.purpose.resolve'),
      requestId: OpaqueIdSchema,
      expectedAccountSettingsScopeKey: z.string().check(z.minLength(1)),
      purpose: asHostProtocolZod(QualifiedConnectedAccountPurposeV1Schema),
      target: asHostProtocolZod(QualifiedConnectedAccountPurposeBindingTargetV1Schema),
      serviceRefs: z.array(asHostProtocolZod(PluginContributionIdentityV1Schema)),
    }),
    z.strictObject({
      kind: z.literal('provider_managed.binding.open'),
      requestId: OpaqueIdSchema,
      ...ManagedProviderBindingProofShape,
    }),
    z.strictObject({
      kind: z.literal('provider_managed.binding.read'),
      requestId: OpaqueIdSchema,
      ...ManagedProviderBindingProofShape,
      bindingId: z.optional(OpaqueIdSchema),
    }),
    z.strictObject({
      kind: z.literal('provider_managed.binding.close'),
      requestId: OpaqueIdSchema,
      bindingId: OpaqueIdSchema,
    }),
    z.strictObject({
      kind: z.literal('provider_broker.binding.open'),
      requestId: OpaqueIdSchema,
      resourceId: OpaqueIdSchema,
      expectedResourceRevision: z.number().check(z.int(), z.nonnegative()),
      agentTargetKey: OpaqueIdSchema,
      modelId: OpaqueIdSchema,
      consumer: z.optional(asHostProtocolZod(ProviderBrokerConsumerV1Schema)),
      /**
       * An Execution Run's own accepted selection (`PLAN.md` §2.3): its Team
       * and route travel with it, because a Run selected from the Home-wide
       * catalog need not share its parent Session's binding. Only an
       * `execution_run` consumer may carry them, and only together; a Session,
       * or a Run that selected nothing, is bound by its tracked Session.
       */
      teamId: z.optional(OpaqueIdSchema),
      deliveryMode: z.optional(TeamCredentialRouteV1Schema),
      /**
       * The Agent an `execution_run` consumer runs, which need not be its
       * parent Session's; required for every Run and refused for a Session,
       * which always materializes for the daemon-retained Agent.
       */
      agentId: z.optional(OpaqueIdSchema),
    }),
    z.strictObject({
      kind: z.literal('provider_broker.binding.close'),
      requestId: OpaqueIdSchema,
      bindingId: OpaqueIdSchema,
    }),
    z.strictObject({
      kind: z.literal('provider_broker.refusal.read'),
      requestId: OpaqueIdSchema,
      turnId: OpaqueIdSchema,
    }),
    z.strictObject({
      kind: z.literal('managed_server.supervision.authorize'),
      requestId: OpaqueIdSchema,
      contributionId: OpaqueIdSchema,
      operationClaimId: z.optional(OpaqueIdSchema),
      serverId: OpaqueIdSchema,
      executable: ManagedExecutableRefSchema,
      environmentKeys: EnvironmentKeysSchema,
    }),
    z.strictObject({
      kind: z.literal('managed_server.endpoint.publish'),
      requestId: OpaqueIdSchema,
      projection: SessionRunnerManagedServiceEndpointProjectionInputV1Schema,
    }),
    z.strictObject({
      kind: z.literal('managed_server.endpoint.release'),
      requestId: OpaqueIdSchema,
      pluginId: OpaqueIdSchema,
      instanceId: OpaqueIdSchema,
      projectionToken: ProjectionTokenSchema,
    }),
    z.strictObject({
      kind: z.literal('managed_server.endpoint.resolve'),
      requestId: OpaqueIdSchema,
      witness: AgentRuntimeDaemonServiceTurnWitnessV1Schema,
      selector: z.strictObject({
        kind: z.literal('projectionToken'),
        projectionToken: ProjectionTokenSchema,
      }),
    }),
    z.strictObject({
      kind: z.literal('managed_server.endpoint.read.claim'),
      requestId: OpaqueIdSchema,
      projectionToken: ProjectionTokenSchema,
    }),
    /**
     * Host-private, operation-scoped read of one declared managed-service
     * secret. The runner never holds device-local secret key material: the
     * current daemon owns the retained-generation declaration, the canonical
     * custody router, and the revision this operation reports. `revalidate`
     * rechecks the same declaration against `expectedRevision` immediately
     * before the runner dispatches a credential-bearing request.
     */
    z.strictObject({
      kind: z.literal('managed_server.secret.read'),
      requestId: OpaqueIdSchema,
      phase: z._default(z.enum(['read', 'revalidate']), 'read'),
      secretId: OpaqueIdSchema,
      canonicalOrigin: CanonicalOriginSchema,
      expectedRevision: z.optional(OpaqueIdSchema),
    }),
  ]),
});

export type AgentRuntimeDaemonServiceRequestV1 =
  z.infer<typeof AgentRuntimeDaemonServiceRequestV1Schema>;

export const AgentRuntimeDaemonServiceResponseV1Schema =
  z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      result: z.union([
        z.strictObject({ kind: z.literal('agent_start.policy'), policy: AgentStartPolicyV1Schema }),
        z.strictObject({ kind: z.literal('execution_run.review_plugin_authority'),
          authority: z.nullable(z.strictObject({ sourceCustody: asHostProtocolZod(PluginSourceCustodyV1Schema),
            caller: z.nullable(asHostProtocolZod(PluginMachineMaterializationRefV1Schema)) })) }),
        ...RUNNER_EXECUTION_RUN_SNAPSHOT_RESULTS,
        McpRequestAuthResultV1Schema,
        McpRequestAuthClosedV1Schema,
        ...RUNNER_PLUGIN_MCP_RESULTS,
        z.strictObject({
          kind: z.literal('action.execution'),
          requestId: OpaqueIdSchema,
          outcome: ActionExecuteResultSchema,
        }),
        z.strictObject({
          kind: z.literal('session.open.attestation'),
          status: z.enum(['accepted', 'recorded']),
        }),
        z.strictObject({
          kind: z.literal('turn.admission'),
          status: z.literal('admitted'),
          witness:
            AgentRuntimeDaemonServiceTurnWitnessV1Schema,
        }),
        z.strictObject({
          kind: z.literal('turn_contributions'),
          status: z.literal('resolved'),
          contributions:
            AgentRuntimeDaemonTurnContributionsResultV1Schema,
        }),
        z.strictObject({
          kind: z.literal('session.input.admission'),
          status: z.literal('resolved'),
          admission: SessionInputEnqueueResultV1Schema,
        }),
        z.strictObject({
          kind: z.literal('model_transition'),
          status: z.literal('authorized'),
          authorization:
            AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema,
        }),
        z.strictObject({
          kind: z.literal('provider_managed.purpose'),
          binding: asHostProtocolZod(QualifiedConnectedAccountPurposeBindingV1Schema),
        }),
        z.strictObject({
          kind: z.literal('provider_managed.binding'),
          bindingId: OpaqueIdSchema,
          endpointUrl: CanonicalOriginSchema,
          headers: z.record(EnvironmentKeySchema, DeclaredSecretValueSchema),
        }),
        z.strictObject({
          kind: z.literal('provider_managed.binding.closed'),
          status: z.literal('closed'),
        }),
        z.strictObject({
          kind: z.literal('provider_broker.binding'),
          status: z.literal('opened'),
          providerBinding: AgentSessionTeamProviderBindingV1Schema,
          environmentOverlay: SessionEnvOverlayV1Schema,
          additionalRedactionValues: z.array(z.string().check(z.minLength(1), z.maxLength(65_536))).check(z.maxLength(64)),
          bindingId: z.optional(OpaqueIdSchema),
        }),
        z.strictObject({
          kind: z.literal('provider_broker.binding.closed'),
          status: z.literal('closed'),
        }),
        z.strictObject({
          kind: z.literal('provider_broker.refusal'),
          denial: z.nullable(asHostProtocolZod(SessionRuntimeTeamCredentialDenialDetailsV1Schema)),
        }),
        z.strictObject({
          kind: z.literal('turn.admission'),
          status: z.literal('denied'),
          reason: OpaqueIdSchema,
        }),
        z.strictObject({
          kind: z.literal('managed_server.supervision'),
          status: z.literal('authorized'),
          launch: AuthorizedManagedServiceLaunchSchema,
        }),
        z.strictObject({
          kind: z.literal('managed_server.endpoint'),
          status: z.literal('published'),
          projectionToken: ProjectionTokenSchema,
        }),
        z.strictObject({
          kind: z.literal('managed_server.endpoint'),
          status: z.literal('released'),
          released: z.boolean(),
        }),
        z.strictObject({
          kind: z.literal('managed_server.endpoint'),
          status: z.literal('resolved'),
          projection: ManagedServiceEndpointProjectionV1Schema,
        }),
        z.strictObject({
          kind: z.literal('managed_server.endpoint'),
          status: z.literal('unavailable'),
        }),
        z.strictObject({
          kind: z.literal('managed_server.endpoint.read'),
          status: z.literal('claimed'),
          requestId: OpaqueIdSchema,
        }),
        z.strictObject({
          kind: z.literal('managed_server.endpoint.read'),
          status: z.literal('unavailable'),
          requestId: OpaqueIdSchema,
        }),
        z.strictObject({
          kind: z.literal('managed_server.secret'),
          status: z.literal('resolved'),
          requestId: OpaqueIdSchema,
          /** `null` is the configured-but-missing/empty credential state. */
          value: z.nullable(DeclaredSecretValueSchema),
          revision: OpaqueIdSchema,
        }),
        z.strictObject({
          kind: z.literal('managed_server.secret'),
          status: z.enum(['current', 'stale', 'unavailable']),
          requestId: OpaqueIdSchema,
        }),
        RunnerAgentDaemonFacetResultV1Schema,
        RunnerDaemonPluginServiceResultV1Schema,
      ]),
    }),
    z.strictObject({
      ok: z.literal(false),
      error: z.strictObject({
        code: OpaqueIdSchema,
        message: z.string().check(z.maxLength(4_096)),
        cause: z.optional(RunnerDaemonPluginServicesPreparationCauseV1Schema),
      }),
    }),
  ]);

export type AgentRuntimeDaemonServiceResponseV1 =
  z.infer<typeof AgentRuntimeDaemonServiceResponseV1Schema>;
