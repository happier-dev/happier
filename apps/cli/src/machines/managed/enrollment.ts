import { randomUUID } from 'node:crypto';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { runManagedMachineEnrollment as runSharedManagedMachineEnrollment, projectManagedMachineBootstrapPrompt,
  SystemTaskExecutionError, type ManagedNativeBootstrapIO,
  type DeploymentAppMachineEnrollmentInput as PortableDeploymentAppEnrollmentInput,
  type ManagedMachineEnrollmentInput as PortableManagedMachineEnrollmentInput,
  type ManagedMachineEnrollmentDependencies as PortableEnrollmentDependencies } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import type { InteractiveSystemTaskEventInput, InteractiveSystemTaskKind } from '@happier-dev/cli-common/systemTasks';
import type { ManagedEnrollmentCorrelationV1, ManagedEnrollmentFullCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import type { SavedSecretRefV1 } from '@happier-dev/protocol';
import type { ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { createManagedBootstrapTaskRunner } from './enrollmentTask';
import { REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS, TERMINAL_AUTH_POLL_INTERVAL_MS, type HomeOperationRetry } from '@/api/client/retryHomeOperation';
import { createManagedEnrollmentPairingDelivery } from './enrollmentPairing';
import { installManagedNativePayload } from './enrollmentPayload';
import { resolveManagedEnrollmentSshTrust } from './enrollmentSshTrust';
import type { StoredCredentials } from '@/persistence';
import { createAccountServerMachineMetadataClient } from '@/api/machine/accountServerMachineMetadata';
import { getMachineMetadataFieldV1, mutateMachineMetadataFieldV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { MachinePublishedMetadataV1Schema, type DeploymentAppMachineBindingV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';

export { projectManagedMachineBootstrapPrompt };
export { runManagedSessionSshTrust } from './enrollmentSshTrust';
export type { ManagedNativeBootstrapIO };
export type ManagedMachineEnrollmentDependencies = Readonly<{
  readCurrentManagedRow(): Promise<ManagedMachineFullV1>;
  onEnrollmentLifetime?(lifetime: HomeOperationRetry): void;
  native?: ManagedNativeBootstrapIO;
  materializeBootstrapCredential?(reference: Extract<SavedSecretRefV1, { kind: 'shared_resource' }>): Promise<Readonly<{ path: string; dispose(): Promise<void> }>>;
}>;

export type ManagedMachineEnrollmentInput = Readonly<{
  correlation: ManagedEnrollmentFullCorrelationV1;
  homeCorrelation: ManagedEnrollmentCorrelationV1;
  target: ResolvedHomeTarget;
  carrier: unknown;
  guestHostPublicKey?: string;
  /** The creating Action owns both the task question and its transient requester delivery. */
  operationId?: string;
  replacePayload?: boolean;
  guestCli?: import('@happier-dev/protocol/features').GuestCliIdentityV1;
  onInstalled?(): Promise<void>;
  reviewedChild?: HostReviewedChildPortV1;
  accountCredentials?: StoredCredentials;
  signal?: AbortSignal;
  channel?: 'stable' | 'preview' | 'dev';
  onEvent?: (event: InteractiveSystemTaskEventInput) => void;
  onTask?: (task: Readonly<{ taskId: string; kind: 'remote.ssh.bootstrapMachine.v1' }>) => void | Promise<void>;
  /** The task's current unanswered question, then `null` once it is answered, so the waiting surface can ask it. */
  onPrompt?: (prompt: ManagedMachineBootstrapPromptV1 | null) => void;
}> & Pick<PortableManagedMachineEnrollmentInput, 'presetCredentialBroker' | 'supportsAgentNativeSandbox'>;

export type DeploymentAppMachineEnrollmentInput = Omit<PortableDeploymentAppEnrollmentInput, 'channel'>
  & Pick<ManagedMachineEnrollmentInput, 'channel' | 'onEvent' | 'onTask' | 'onPrompt'>
  & Readonly<{ accountCredentials: StoredCredentials }>;
export type DeploymentAppMachineEnrollmentDependencies = Pick<ManagedMachineEnrollmentDependencies, 'native' | 'onEnrollmentLifetime'>;

export function runManagedMachineEnrollment(input: DeploymentAppMachineEnrollmentInput,
  deps: DeploymentAppMachineEnrollmentDependencies): Promise<Readonly<{ machineId: string }>>;
export function runManagedMachineEnrollment(input: ManagedMachineEnrollmentInput,
  deps: ManagedMachineEnrollmentDependencies): Promise<Readonly<{ machineId: string }>>;
/** Host custody binds the existing binary task to its admitted enrollment source. */
export async function runManagedMachineEnrollment(input: ManagedMachineEnrollmentInput | DeploymentAppMachineEnrollmentInput,
  deps: Partial<ManagedMachineEnrollmentDependencies>): Promise<Readonly<{ machineId: string }>> {
  const approveLocalAuthRequest: PortableEnrollmentDependencies['approveLocalAuthRequest'] = async ({ publicKey, pairing, supportsTokenOnly, signal }) => {
    input.signal?.throwIfAborted();
    const { approveTerminalAuthRequest } = await import('@/auth/terminalAuthApproval');
    await approveTerminalAuthRequest({ publicKey, pairing, supportsTokenOnly, target: input.target,
      accountCredentials: input.accountCredentials, signal });
  };
  let responseOwner: Parameters<typeof createManagedEnrollmentPairingDelivery>[0] | undefined;
  const taskRunner = createManagedBootstrapTaskRunner({ ...input, readResponseOwner: () => responseOwner });
  const runPreparedTask = async (kind: InteractiveSystemTaskKind) => {
    const data = await taskRunner.run(kind);
    const machineId = data && typeof data === 'object' && !Array.isArray(data) && 'machineId' in data && typeof data.machineId === 'string' ? data.machineId : '';
    if (!machineId) throw new SystemTaskExecutionError('machine_registration_unconfirmed', 'Managed guest registration was not confirmed.');
    return { machineId };
  };
  const channel = input.channel ?? resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label;
  const onEnrollmentDeadline: PortableEnrollmentDependencies['onEnrollmentDeadline'] = (deadlineMs, transport) => deps.onEnrollmentLifetime?.({ deadlineMs,
    pollIntervalMs: transport === 'native'
      ? TERMINAL_AUTH_POLL_INTERVAL_MS : REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS, signal: input.signal });
  if ('source' in input) return await runSharedManagedMachineEnrollment({ ...input, channel,
    onExistingMachine: async machineId => {
      await input.onExistingMachine(machineId);
      const withMetadata = await createAccountServerMachineMetadataClient({ machineId, credentials: input.accountCredentials,
        serverHttpBaseUrl: input.target.applicationUrl, signal: input.signal });
      const field = { field: 'deploymentApp', storedSchema: MachinePublishedMetadataV1Schema.shape.deploymentApp,
        defaultValue: (): DeploymentAppMachineBindingV1 | undefined => undefined,
        equal: (left: DeploymentAppMachineBindingV1 | undefined, right: DeploymentAppMachineBindingV1 | undefined) =>
          left?.serviceName === right?.serviceName && left?.port === right?.port };
      await withMetadata(async port => {
        const current = await getMachineMetadataFieldV1(port, field);
        if (current.status !== 'ready') throw new SystemTaskExecutionError('machine_registration_unconfirmed',
          'The retained App Machine service binding is unavailable.');
        const result = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: current.metadataVersion,
          expectedPolicy: current.policy, policy: input.deploymentAppBinding, comparison: 'field' }, port, field, { signal: input.signal });
        if (result.status !== 'applied' && result.status !== 'unchanged' && result.status !== 'satisfied') {
          throw new SystemTaskExecutionError('machine_registration_unconfirmed', 'The retained App Machine service binding could not be published.');
        }
      });
    },
  }, {
    native: deps.native,
    runTask: runPreparedTask,
    installNativePayload: installManagedNativePayload,
    onEnrollmentDeadline,
    approveLocalAuthRequest,
  });
  const correlation = input.correlation;
  return await runSharedManagedMachineEnrollment({ ...input,
    channel,
  }, {
    // The managed overload requires its retained-row owner; App enrollment returns above.
    readCurrentManagedRow: deps.readCurrentManagedRow!,
    native: deps.native,
    createPromptId: randomUUID,
    runTask: runPreparedTask,
    installNativePayload: installManagedNativePayload,
    onEnrollmentDeadline,
    createPairingDelivery: enrollmentAccountId => {
      if (!input.operationId) return undefined;
      responseOwner = { correlation: input.homeCorrelation, operationId: input.operationId, enrollmentAccountId, readTaskId: taskRunner.readTaskId,
        reviewedChild: input.reviewedChild };
      return createManagedEnrollmentPairingDelivery(responseOwner);
    },
    approveLocalAuthRequest,
    ...(deps.materializeBootstrapCredential ? { runSshTask: async ({ configuration, reviewedChild, carrier, trustedHostKey, resumeMachineId, assertCurrent, prepareDedicatedBootstrap, deliverAuthApproval, onEnrollmentDeadline }: Parameters<NonNullable<PortableEnrollmentDependencies['runSshTask']>>[0]) => {
      const credential = await deps.materializeBootstrapCredential!(carrier.credentialRef);
      try {
        input.signal?.throwIfAborted();
        const trust = await resolveManagedEnrollmentSshTrust({ correlation, carrier, trustedHostKey });
        const { createLiveRemoteSshBootstrapTaskKind } = await import('@/capabilities/systemTasks/ssh/liveRemoteSshBootstrap');
        const task = createLiveRemoteSshBootstrapTaskKind({ reviewedChild, prepareDedicatedBootstrap, resumeMachineId, onEnrollmentDeadline, deliverAuthApproval, approveLocalAuthRequest,
          assertManagedEnrollmentCurrent: assertCurrent });
        return await runPreparedTask({ run: async ctx => task.run({ ...ctx, params: { ...configuration, ssh: {
          target: `${carrier.user}@${carrier.address}`, auth: 'keyfile', identityFile: credential.path,
          ...(carrier.port ? { port: carrier.port } : {}),
          ...(carrier.hostKeyEvidence ? { hostKeyEvidence: carrier.hostKeyEvidence } : {}),
          ...trust,
        } } }) });
      } finally { await credential.dispose(); }
    } } : {}),
  });
}
