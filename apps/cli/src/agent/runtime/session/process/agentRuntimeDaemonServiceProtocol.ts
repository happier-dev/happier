import { z } from 'zod';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { ManagedExecutableRefSchema } from '@happier-dev/protocol/plugins/contributions/agentAcpTransport';
import { AgentSessionTeamProviderBindingV1Schema } from '@happier-dev/protocol/providers/sessions/agentSessionProviderBindingV1';
import { SessionEnvOverlayV1Schema } from '@happier-dev/protocol/spawn/envOverlay';
import { SessionInputAdmissionResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
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
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';

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
  AgentRuntimeDaemonServiceTurnWitnessV1Schema,
} from './agentRuntimeDaemonServiceTurnWitness';

export const AGENT_RUNTIME_DAEMON_SERVICES_PATH =
  '/agent-runtime/session/services/v1';

const OpaqueIdSchema = z.string().trim().min(1).max(512);
const ActionExecuteSuccessSchema = z.object({
  ok: z.literal(true),
  result: z.unknown(),
}).strict();
const ActionExecuteResultSchema = z.custom<ActionExecuteResult>((value) => {
  if (ActionExecuteFailureSchema.safeParse(value).success) return true;
  return ActionExecuteSuccessSchema.safeParse(value).success
    && Object.prototype.hasOwnProperty.call(value, 'result');
});
const ProjectionTokenSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const CanonicalOriginSchema = z.string().trim().min(1).max(2_048);
const DeclaredSecretValueSchema = z.string().max(65_536);
const EnvironmentKeySchema = z.string().trim().min(1).max(256);
const ManagedProviderBindingProofShape = {
  executionRunId: OpaqueIdSchema,
  executionRunOccurrenceId: OpaqueIdSchema,
  agentId: OpaqueIdSchema,
  modelId: OpaqueIdSchema,
  runtimeBindingBasis: asHostProtocolZod(ProviderRuntimeBindingBasisV1Schema),
  expectedAccountSettingsScopeKey: z.string().min(1),
};
const EnvironmentKeysSchema = z.array(EnvironmentKeySchema)
  .max(256)
  .superRefine((keys, context) => {
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: 'custom',
        message: 'Environment keys must be unique',
      });
    }
  });
const ResolvedManagedServiceLaunchSchema = z.object({
  command: z.string().trim().min(1).max(8_192),
  args: z.array(z.string().max(16_384)).max(4_096).optional(),
  env: z.record(
    EnvironmentKeySchema,
    z.string().max(65_536),
  ).refine((value) => Object.keys(value).length <= 256).optional(),
  allowedArguments:
    z.array(z.string().max(16_384)).max(4_096).optional(),
}).strict();
const AuthorizedManagedServiceLaunchSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('daemonResolved'),
    value: ResolvedManagedServiceLaunchSchema,
  }).strict(),
  z.object({
    kind: z.literal('runnerPackagedRuntime'),
  }).strict(),
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
  z.object({
    request: AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema,
    providerSessionId: OpaqueIdSchema.nullable(),
  }).strict();

export type AgentRuntimeDaemonServiceSessionOpenAttestationV1 =
  z.infer<
    typeof AgentRuntimeDaemonServiceSessionOpenAttestationV1Schema
  >;

export const AgentRuntimeDaemonServiceRequestV1Schema = z.object({
  v: z.literal(1),
  context: z.object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    sessionId: asHostProtocolZod(SessionIdSchema),
  }).strict(),
  operation: z.discriminatedUnion('kind', [
    ...RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS,
    ...RUNNER_DAEMON_PLUGIN_SERVICE_OPERATION_V1_SCHEMAS,
    z.object({
      kind: z.literal('action.execute'),
      surface: z.enum(['agent', 'mcp']).optional(),
      requestId: OpaqueIdSchema,
      actionId: asHostProtocolZod(ActionIdSchema),
      input: z.unknown(),
      witness: AgentRuntimeDaemonServiceTurnWitnessV1Schema,
      toolCallId: OpaqueIdSchema.optional(),
    }).strict().refine((operation) => Object.prototype.hasOwnProperty.call(operation, 'input'), {
      path: ['input'],
      message: 'Action input must be present',
    }),
    z.object({
      kind: z.literal('session.open.attest'),
      requestId: OpaqueIdSchema,
      phase: z.enum(['prepare', 'commit']).default('commit'),
      request: AgentRuntimeDaemonSessionOpenRequestV1Schema,
      providerSessionId: OpaqueIdSchema.nullable(),
    }).strict(),
    z.object({
      kind: z.literal('turn.admission.authorize'),
      requestId: OpaqueIdSchema,
      witness: AgentRuntimeDaemonServiceTurnWitnessV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('turn_contributions.resolve'),
      requestId: OpaqueIdSchema,
      request:
        AgentRuntimeDaemonTurnContributionRequestV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('session.input.admit'),
      requestId: OpaqueIdSchema,
      request: z.union([asHostProtocolZod(SessionPendingEnqueueByMachineRequestV1Schema), asHostProtocolZod(SessionPendingExecutionRunEnqueueByMachineRequestV2Schema)]),
    }).strict(),
    z.object({
      kind: z.literal('model_transition.authorize'),
      requestId: OpaqueIdSchema,
      selection:
        AgentRuntimeDaemonProviderConnectionModelRefV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('provider_managed.purpose.resolve'),
      requestId: OpaqueIdSchema,
      expectedAccountSettingsScopeKey: z.string().min(1),
      purpose: asHostProtocolZod(QualifiedConnectedAccountPurposeV1Schema),
      target: asHostProtocolZod(QualifiedConnectedAccountPurposeBindingTargetV1Schema),
      serviceRefs: z.array(asHostProtocolZod(PluginContributionIdentityV1Schema)),
    }).strict(),
    z.object({
      kind: z.literal('provider_managed.binding.open'),
      requestId: OpaqueIdSchema,
      ...ManagedProviderBindingProofShape,
    }).strict(),
    z.object({
      kind: z.literal('provider_managed.binding.read'),
      requestId: OpaqueIdSchema,
      ...ManagedProviderBindingProofShape,
      bindingId: OpaqueIdSchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('provider_managed.binding.close'),
      requestId: OpaqueIdSchema,
      bindingId: OpaqueIdSchema,
    }).strict(),
    z.object({
      kind: z.literal('provider_broker.binding.open'),
      requestId: OpaqueIdSchema,
      resourceId: OpaqueIdSchema,
      expectedResourceRevision: z.number().int().nonnegative(),
      agentTargetKey: OpaqueIdSchema,
      modelId: OpaqueIdSchema,
      consumer: asHostProtocolZod(ProviderBrokerConsumerV1Schema).optional(),
      /**
       * An Execution Run's own accepted selection (`PLAN.md` §2.3): its Team
       * and route travel with it, because a Run selected from the Home-wide
       * catalog need not share its parent Session's binding. Only an
       * `execution_run` consumer may carry them, and only together; a Session,
       * or a Run that selected nothing, is bound by its tracked Session.
       */
      teamId: OpaqueIdSchema.optional(),
      deliveryMode: TeamCredentialRouteV1Schema.optional(),
      /**
       * The Agent an `execution_run` consumer runs, which need not be its
       * parent Session's; required for every Run and refused for a Session,
       * which always materializes for the daemon-retained Agent.
       */
      agentId: OpaqueIdSchema.optional(),
    }).strict(),
    z.object({
      kind: z.literal('provider_broker.binding.close'),
      requestId: OpaqueIdSchema,
      bindingId: OpaqueIdSchema,
    }).strict(),
    z.object({
      kind: z.literal('managed_server.supervision.authorize'),
      requestId: OpaqueIdSchema,
      contributionId: OpaqueIdSchema,
      operationClaimId: OpaqueIdSchema.optional(),
      serverId: OpaqueIdSchema,
      executable: ManagedExecutableRefSchema,
      environmentKeys: EnvironmentKeysSchema,
    }).strict(),
    z.object({
      kind: z.literal('managed_server.endpoint.publish'),
      requestId: OpaqueIdSchema,
      projection: SessionRunnerManagedServiceEndpointProjectionInputV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('managed_server.endpoint.release'),
      requestId: OpaqueIdSchema,
      pluginId: OpaqueIdSchema,
      instanceId: OpaqueIdSchema,
      projectionToken: ProjectionTokenSchema,
    }).strict(),
    z.object({
      kind: z.literal('managed_server.endpoint.resolve'),
      requestId: OpaqueIdSchema,
      witness: AgentRuntimeDaemonServiceTurnWitnessV1Schema,
      selector: z.object({
        kind: z.literal('projectionToken'),
        projectionToken: ProjectionTokenSchema,
      }).strict(),
    }).strict(),
    z.object({
      kind: z.literal('managed_server.endpoint.read.claim'),
      requestId: OpaqueIdSchema,
      projectionToken: ProjectionTokenSchema,
    }).strict(),
    /**
     * Host-private, operation-scoped read of one declared managed-service
     * secret. The runner never holds device-local secret key material: the
     * current daemon owns the retained-generation declaration, the canonical
     * custody router, and the revision this operation reports. `revalidate`
     * rechecks the same declaration against `expectedRevision` immediately
     * before the runner dispatches a credential-bearing request.
     */
    z.object({
      kind: z.literal('managed_server.secret.read'),
      requestId: OpaqueIdSchema,
      phase: z.enum(['read', 'revalidate']).default('read'),
      secretId: OpaqueIdSchema,
      canonicalOrigin: CanonicalOriginSchema,
      expectedRevision: OpaqueIdSchema.optional(),
    }).strict(),
  ]),
}).strict();

export type AgentRuntimeDaemonServiceRequestV1 =
  z.infer<typeof AgentRuntimeDaemonServiceRequestV1Schema>;

export const AgentRuntimeDaemonServiceResponseV1Schema =
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      result: z.union([
        z.object({
          kind: z.literal('action.execution'),
          requestId: OpaqueIdSchema,
          outcome: ActionExecuteResultSchema,
        }).strict(),
        z.object({
          kind: z.literal('session.open.attestation'),
          status: z.enum(['accepted', 'recorded']),
        }).strict(),
        z.object({
          kind: z.literal('turn.admission'),
          status: z.literal('admitted'),
          witness:
            AgentRuntimeDaemonServiceTurnWitnessV1Schema,
        }).strict(),
        z.object({
          kind: z.literal('turn_contributions'),
          status: z.literal('resolved'),
          contributions:
            AgentRuntimeDaemonTurnContributionsResultV1Schema,
        }).strict(),
        z.object({
          kind: z.literal('session.input.admission'),
          status: z.literal('resolved'),
          admission: SessionInputAdmissionResultV1Schema,
        }).strict(),
        z.object({
          kind: z.literal('model_transition'),
          status: z.literal('authorized'),
          authorization:
            AgentRuntimeDaemonModelTransitionAuthorizationResultV1Schema,
        }).strict(),
        z.object({
          kind: z.literal('provider_managed.purpose'),
          binding: asHostProtocolZod(QualifiedConnectedAccountPurposeBindingV1Schema),
        }).strict(),
        z.object({
          kind: z.literal('provider_managed.binding'),
          bindingId: OpaqueIdSchema,
          endpointUrl: CanonicalOriginSchema,
          headers: z.record(EnvironmentKeySchema, DeclaredSecretValueSchema),
        }).strict(),
        z.object({
          kind: z.literal('provider_managed.binding.closed'),
          status: z.literal('closed'),
        }).strict(),
        z.object({
          kind: z.literal('provider_broker.binding'),
          status: z.literal('opened'),
          providerBinding: AgentSessionTeamProviderBindingV1Schema,
          environmentOverlay: SessionEnvOverlayV1Schema,
          additionalRedactionValues: z.array(z.string().min(1).max(65_536)).max(64),
          bindingId: OpaqueIdSchema.optional(),
        }).strict(),
        z.object({
          kind: z.literal('provider_broker.binding.closed'),
          status: z.literal('closed'),
        }).strict(),
        z.object({
          kind: z.literal('turn.admission'),
          status: z.literal('denied'),
          reason: OpaqueIdSchema,
        }).strict(),
        z.object({
          kind: z.literal('managed_server.supervision'),
          status: z.literal('authorized'),
          launch: AuthorizedManagedServiceLaunchSchema,
        }).strict(),
        z.object({
          kind: z.literal('managed_server.endpoint'),
          status: z.literal('published'),
          projectionToken: ProjectionTokenSchema,
        }).strict(),
        z.object({
          kind: z.literal('managed_server.endpoint'),
          status: z.literal('released'),
          released: z.boolean(),
        }).strict(),
        z.object({
          kind: z.literal('managed_server.endpoint'),
          status: z.literal('resolved'),
          projection: ManagedServiceEndpointProjectionV1Schema,
        }).strict(),
        z.object({
          kind: z.literal('managed_server.endpoint'),
          status: z.literal('unavailable'),
        }).strict(),
        z.object({
          kind: z.literal('managed_server.endpoint.read'),
          status: z.literal('claimed'),
          requestId: OpaqueIdSchema,
        }).strict(),
        z.object({
          kind: z.literal('managed_server.endpoint.read'),
          status: z.literal('unavailable'),
          requestId: OpaqueIdSchema,
        }).strict(),
        z.object({
          kind: z.literal('managed_server.secret'),
          status: z.literal('resolved'),
          requestId: OpaqueIdSchema,
          /** `null` is the configured-but-missing/empty credential state. */
          value: DeclaredSecretValueSchema.nullable(),
          revision: OpaqueIdSchema,
        }).strict(),
        z.object({
          kind: z.literal('managed_server.secret'),
          status: z.enum(['current', 'stale', 'unavailable']),
          requestId: OpaqueIdSchema,
        }).strict(),
        RunnerAgentDaemonFacetResultV1Schema,
        RunnerDaemonPluginServiceResultV1Schema,
      ]),
    }).strict(),
    z.object({
      ok: z.literal(false),
      error: z.object({
        code: OpaqueIdSchema,
        message: z.string().max(4_096),
      }).strict(),
    }).strict(),
  ]);

export type AgentRuntimeDaemonServiceResponseV1 =
  z.infer<typeof AgentRuntimeDaemonServiceResponseV1Schema>;
