import { z } from 'zod';
import {
  ManagedExecutableRefSchema,
  SessionInputAdmissionResultV1Schema,
  SessionPendingEnqueueByMachineRequestV1Schema,
} from '@happier-dev/protocol';

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
const ProjectionTokenSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const EnvironmentKeySchema = z.string().trim().min(1).max(256);
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
    sessionId: OpaqueIdSchema,
  }).strict(),
  operation: z.discriminatedUnion('kind', [
    ...RUNNER_AGENT_DAEMON_FACET_OPERATION_SCHEMAS,
    ...RUNNER_DAEMON_PLUGIN_SERVICE_OPERATION_V1_SCHEMAS,
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
      request: SessionPendingEnqueueByMachineRequestV1Schema,
    }).strict(),
    z.object({
      kind: z.literal('model_transition.authorize'),
      requestId: OpaqueIdSchema,
      selection:
        AgentRuntimeDaemonProviderConnectionModelRefV1Schema,
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
