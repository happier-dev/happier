import { z } from 'zod/mini';
import { z as zMini } from 'zod/mini';
import { BackendTargetRefV2Schema } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { PluginExecutionRunProfileContributionV2Schema } from '@happier-dev/protocol/plugins/contributions/executionRunProfiles';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { AgentSessionRunnerBindingV1Schema } from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { AgentRuntimeDaemonSessionDescriptorV1Schema } from './agentRuntimeRunnerProtocol';
import { ReviewScmScopeV1Schema } from '@happier-dev/protocol/reviews/scope';
import { ExecutionRunScmCommitMessageInputV1Schema, ExecutionRunScmCommitMessageScopeV1Schema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ScmWorkingSnapshotSchema, ScmCommitOidSchema, ScmCommitExpectedRefSchema, ScmOperationErrorCodeSchema } from '@happier-dev/protocol/scm';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/selection/v1';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { AgentSessionProviderBindingV1Schema } from '@happier-dev/protocol/providers/sessions/agentSessionProviderBindingV1';
import { SessionEnvOverlayV1Schema } from '@happier-dev/protocol/spawn/envOverlay';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { AgentProbeModelSchema } from '@happier-dev/protocol/capabilities';
import { PortableRuntimeDescriptorV1Schema } from '@happier-dev/protocol/sessions/metadata/runtimeDescriptorV1';
import { SecretReferenceOverlayV1Schema } from '@happier-dev/protocol/profiles/secretReferenceOverlayV1';
import { AcpConfigOptionOverridesV1Schema } from '@happier-dev/protocol/sessions/metadata/overrides';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';

const StrictBackendTargetRefV2Schema = zMini.pipe(
  zMini.strictObject(BackendTargetRefV2Schema.shape),
  BackendTargetRefV2Schema,
);

const ProviderLaunchRequestShape = {
  selection: asHostProtocolZod(ProviderBoundModelRefSchema),
  teamCredentialModel: z.optional(asHostProtocolZod(TeamCredentialProviderModelSelectionV1Schema)),
  sessionConfigOptionOverrides: z.optional(asHostProtocolZod(AcpConfigOptionOverridesV1Schema)),
  backendTarget: asHostProtocolZod(StrictBackendTargetRefV2Schema),
  agentId: z.string().check(z.minLength(1)), runId: z.string().check(z.minLength(1)), controllerOccurrenceId: z.optional(z.string().check(z.minLength(1))),
  expectedAccountSettingsScopeKey: z.string().check(z.minLength(1)),
  connectedServices: z.optional(z.nullable(asHostProtocolZod(ConnectedServiceBindingsV2Schema))),
};
const ProviderLaunchRefusalShape = {
  ok: z.literal(false), providerError: asHostProtocolZod(ProviderErrorV1Schema), childChoiceRequired: z.boolean(),
};

// Host-private optional operations. Older daemons reject unknown operations;
// that refusal cannot be interpreted as an empty executable snapshot.
export const RUNNER_EXECUTION_RUN_SNAPSHOT_OPERATIONS = [
  z.strictObject({ kind: z.literal('execution_run.snapshot.acquire_v1'),
    backendTarget: z.optional(asHostProtocolZod(StrictBackendTargetRefV2Schema)) }),
  z.strictObject({ kind: z.literal('execution_run.snapshot.release_v1'), snapshotId: z.uuid() }),
  z.strictObject({ kind: z.literal('execution_run.native_offered_model.read_v1'),
    backendTarget: asHostProtocolZod(StrictBackendTargetRefV2Schema), modelId: z.string().check(z.minLength(1)),
    cwd: z.string().check(z.minLength(1)), runtimeDescriptorV1: z.optional(asHostProtocolZod(PortableRuntimeDescriptorV1Schema)),
    connectedServices: z.optional(z.nullable(asHostProtocolZod(ConnectedServiceBindingsV2Schema))),
    secretReferenceOverlay: z.optional(asHostProtocolZod(SecretReferenceOverlayV1Schema)) }),
  z.strictObject({ kind: z.literal('execution_run.review_scm_scope.resolve_v1'),
    cwd: z.string().check(z.minLength(1)), intentInput: z.optional(z.unknown()) }),
  z.strictObject({ kind: z.literal('execution_run.commit_message_context.resolve_v1'),
    workingDirectory: z.string().check(z.minLength(1)),
    maxFiles: asHostProtocolZod(zMini.nonoptional(ExecutionRunScmCommitMessageInputV1Schema.shape.maxFiles)),
    maxTotalDiffChars: asHostProtocolZod(zMini.nonoptional(ExecutionRunScmCommitMessageInputV1Schema.shape.maxTotalDiffChars)),
    scope: z.optional(asHostProtocolZod(ExecutionRunScmCommitMessageScopeV1Schema)),
  }),
  z.strictObject({ kind: z.literal('execution_run.scm_commit_target.capture_v1'), cwd: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('execution_run.provider.admit_v1'), ...ProviderLaunchRequestShape }),
  z.strictObject({ kind: z.literal('execution_run.provider.prepare_v1'), ...ProviderLaunchRequestShape }),
  z.strictObject({ kind: z.literal('execution_run.provider.revalidate_v1') }),
  z.strictObject({ kind: z.literal('execution_run.provider.release_v1') }),
] as const;

export const RunnerExecutionRunSnapshotV1Schema = z.strictObject({
  kind: z.literal('execution_run.snapshot'), snapshotId: z.uuid(),
  agent: z.optional(z.strictObject({ descriptor: AgentRuntimeDaemonSessionDescriptorV1Schema,
    binding: AgentSessionRunnerBindingV1Schema })),
  profiles: z.array(z.strictObject({ pluginId: z.string().check(z.minLength(1)),
    sourceCustody: asHostProtocolZod(PluginSourceCustodyV1Schema),
    definition: asHostProtocolZod(PluginExecutionRunProfileContributionV2Schema) })),
});
export const RUNNER_EXECUTION_RUN_SNAPSHOT_RESULTS = [
  RunnerExecutionRunSnapshotV1Schema,
  z.strictObject({ kind: z.literal('execution_run.snapshot.released') }),
  z.strictObject({ kind: z.literal('execution_run.native_offered_model'), model: z.nullable(asHostProtocolZod(AgentProbeModelSchema)) }),
  z.strictObject({ kind: z.literal('execution_run.review_scm_scope'),
    scope: asHostProtocolZod(ReviewScmScopeV1Schema) }),
  z.strictObject({ kind: z.literal('execution_run.commit_message_context'), context: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), snapshot: asHostProtocolZod(ScmWorkingSnapshotSchema),
      diffsByPath: z.array(z.strictObject({ path: z.string(), diff: z.string() })) }),
    z.strictObject({ ok: z.literal(false), errorCode: z.string(), error: z.string() }),
  ]) }),
  z.strictObject({ kind: z.literal('execution_run.provider.admitted'), ok: z.literal(true) }),
  z.strictObject({ kind: z.literal('execution_run.provider.admitted'), ...ProviderLaunchRefusalShape }),
  z.strictObject({ kind: z.literal('execution_run.provider.prepared'),
    ok: z.literal(true),
    environmentOverlay: asHostProtocolZod(SessionEnvOverlayV1Schema),
    connectedServices: z.optional(z.nullable(asHostProtocolZod(ConnectedServiceBindingsV2Schema))),
    providerBinding: asHostProtocolZod(AgentSessionProviderBindingV1Schema),
    additionalRedactionValues: z.array(z.string().check(z.minLength(1))),
  }),
  z.strictObject({ kind: z.literal('execution_run.provider.prepared'), ...ProviderLaunchRefusalShape }),
  z.strictObject({ kind: z.literal('execution_run.provider.revalidated'), result: z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true) }),
    z.strictObject({ ok: z.literal(false), error: asHostProtocolZod(ProviderErrorV1Schema) }),
  ]) }),
  z.strictObject({ kind: z.literal('execution_run.provider.released') }),
  z.strictObject({ kind: z.literal('execution_run.scm_commit_target'), capture: z.discriminatedUnion('success', [
    z.strictObject({ success: z.literal(true), target: z.strictObject({
      headOid: z.nullable(asHostProtocolZod(ScmCommitOidSchema)),
      ref: asHostProtocolZod(ScmCommitExpectedRefSchema),
      baseTreeOid: asHostProtocolZod(ScmCommitOidSchema),
    }) }),
    z.strictObject({ success: z.literal(false), errorCode: z.optional(asHostProtocolZod(ScmOperationErrorCodeSchema)),
      error: z.optional(z.string()) }),
  ]) }),
] as const;
export type RunnerExecutionRunSnapshotV1 = z.infer<typeof RunnerExecutionRunSnapshotV1Schema>;
