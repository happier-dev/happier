import { randomUUID } from 'node:crypto';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { resolveManagedCliReleaseChannelSync } from '@happier-dev/cli-common/firstPartyRuntime';
import { runManagedMachineEnrollment as runSharedManagedMachineEnrollment, projectManagedMachineBootstrapPrompt,
  SystemTaskExecutionError, type ManagedNativeBootstrapIO,
  type ManagedMachineEnrollmentDependencies as PortableEnrollmentDependencies } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import type { InteractiveSystemTaskEventInput, InteractiveSystemTaskKind } from '@happier-dev/cli-common/systemTasks';
import type { ManagedEnrollmentCorrelationV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import type { SavedSecretRefV1 } from '@happier-dev/protocol';
import type { ManagedMachineBootstrapPromptV1 } from '@happier-dev/protocol/actions/operations/v1';
import { ManagedMachineControllerError } from './controllerErrors';
import { REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS, TERMINAL_AUTH_POLL_INTERVAL_MS, type HomeOperationRetry } from '@/api/client/retryHomeOperation';
import { createManagedEnrollmentPairingDelivery, createManagedEnrollmentResponseValidation } from './enrollmentPairing';
import { installManagedNativePayload } from './enrollmentPayload';
import { resolveManagedEnrollmentSshTrust } from './enrollmentSshTrust';
import type { StoredCredentials } from '@/persistence';

export { projectManagedMachineBootstrapPrompt };
export type { ManagedNativeBootstrapIO };
export type ManagedMachineEnrollmentDependencies = Readonly<{
  readCurrentManagedRow(): Promise<ManagedMachineV1>;
  onEnrollmentLifetime?(lifetime: HomeOperationRetry): void;
  native?: ManagedNativeBootstrapIO;
  materializeBootstrapCredential?(reference: Extract<SavedSecretRefV1, { kind: 'shared_resource' }>): Promise<Readonly<{ path: string; dispose(): Promise<void> }>>;
}>;

/** Host custody binds the existing binary task to one retained resource. */
export async function runManagedMachineEnrollment(input: Readonly<{
  correlation: ManagedEnrollmentCorrelationV1;
  target: ResolvedHomeTarget;
  carrier: unknown;
  guestHostPublicKey?: string;
  /** The creating Action owns both the task question and its transient requester delivery. */
  operationId?: string;
  onInstalled?(): Promise<void>;
  reviewedChild?: HostReviewedChildPortV1;
  accountCredentials?: StoredCredentials;
  signal?: AbortSignal;
  channel?: 'stable' | 'preview' | 'dev';
  onEvent?: (event: InteractiveSystemTaskEventInput) => void;
  onTask?: (task: Readonly<{ taskId: string; kind: 'remote.ssh.bootstrapMachine.v1' }>) => void | Promise<void>;
  /** The task's current unanswered question, then `null` once it is answered, so the waiting surface can ask it. */
  onPrompt?: (prompt: ManagedMachineBootstrapPromptV1 | null) => void;
}>, deps: ManagedMachineEnrollmentDependencies): Promise<Readonly<{ machineId: string }>> {
  const correlation = input.correlation;
  let liveTaskId: string | undefined;
  const approveLocalAuthRequest: PortableEnrollmentDependencies['approveLocalAuthRequest'] = async ({ publicKey, pairing, supportsTokenOnly, signal }) => {
    input.signal?.throwIfAborted();
    const { approveTerminalAuthRequest } = await import('@/auth/terminalAuthApproval');
    await approveTerminalAuthRequest({ publicKey, pairing, supportsTokenOnly, target: input.target,
      accountCredentials: input.accountCredentials, signal });
  };
  let responseOwner: Parameters<typeof createManagedEnrollmentPairingDelivery>[0] | undefined;
  const runPreparedTask = async (kind: InteractiveSystemTaskKind) => {
    const { getLiveSystemTasksRunnerAdapter } = await import('@/capabilities/systemTasks/liveSystemTasksRunner');
    const owner = getLiveSystemTasksRunnerAdapter();
    let controllerFailure: ManagedMachineControllerError | undefined;
    const task = await owner.startAdmitted({ run: async (ctx) => {
      try {
        return await kind.run({ ...ctx, emit: (event) => {
          ctx.emit(event);
          input.onEvent?.(event);
        }, prompt: async (prompt) => {
          input.onPrompt?.(projectManagedMachineBootstrapPrompt(prompt));
          const data = prompt.data;
          const promptId = data && typeof data === 'object' && !Array.isArray(data) && 'promptId' in data
            && typeof data.promptId === 'string' ? data.promptId : undefined;
          try { return await ctx.prompt({ ...prompt, ...(responseOwner ? {
            validateResponse: createManagedEnrollmentResponseValidation(responseOwner, { kind: prompt.kind, promptId }),
          } : {}) }); } finally { input.onPrompt?.(null); }
        } });
      } catch (error) {
        if (error instanceof ManagedMachineControllerError) {
          controllerFailure = error;
          throw new SystemTaskExecutionError(error.code, error.code);
        }
        throw error;
      }
    } });
    liveTaskId = task.taskId;
    const cancel = () => { void owner.cancel(task); };
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();
    try {
      await input.onTask?.({ ...task, kind: 'remote.ssh.bootstrapMachine.v1' });
      const result = await owner.wait(task);
      if (!result.ok) {
        // The task keeps its existing public error contract; its invoking
        // operation retains the original typed controller observation.
        if (controllerFailure && result.error?.code === controllerFailure.code) throw controllerFailure;
        throw new SystemTaskExecutionError(result.error?.code ?? 'system_task_failed', result.error?.message ?? 'Managed guest setup failed.');
      }
      const data = result.data;
      const machineId = data && typeof data === 'object' && !Array.isArray(data) && 'machineId' in data && typeof data.machineId === 'string' ? data.machineId : '';
      if (!machineId) throw new SystemTaskExecutionError('machine_registration_unconfirmed', 'Managed guest registration was not confirmed.');
      input.signal?.throwIfAborted();
      return { machineId };
    } catch (error) {
      await owner.cancel(task);
      await owner.wait(task);
      throw error;
    } finally { input.signal?.removeEventListener('abort', cancel); }
  };
  return await runSharedManagedMachineEnrollment({ ...input,
    channel: input.channel ?? resolveManagedCliReleaseChannelSync({ argv: process.argv, invokedPath: process.argv[1], processEnv: process.env }).label,
  }, {
    readCurrentManagedRow: deps.readCurrentManagedRow,
    native: deps.native,
    createPromptId: randomUUID,
    runTask: runPreparedTask,
    installNativePayload: installManagedNativePayload,
    onEnrollmentDeadline: (deadlineMs, transport) => deps.onEnrollmentLifetime?.({ deadlineMs,
      pollIntervalMs: transport === 'native'
        ? TERMINAL_AUTH_POLL_INTERVAL_MS : REMOTE_HOME_ENROLLMENT_POLL_INTERVAL_MS, signal: input.signal }),
    createPairingDelivery: enrollmentAccountId => {
      if (!input.operationId) return undefined;
      responseOwner = { correlation, operationId: input.operationId, enrollmentAccountId, readTaskId: () => liveTaskId,
        reviewedChild: input.reviewedChild };
      return createManagedEnrollmentPairingDelivery(responseOwner);
    },
    approveLocalAuthRequest,
    ...(deps.materializeBootstrapCredential ? { runSshTask: async ({ configuration, reviewedChild, carrier, trustedHostKey, assertCurrent, prepareDedicatedBootstrap, deliverAuthApproval, onEnrollmentDeadline }: Parameters<NonNullable<PortableEnrollmentDependencies['runSshTask']>>[0]) => {
      const credential = await deps.materializeBootstrapCredential!(carrier.credentialRef);
      try {
        input.signal?.throwIfAborted();
        const trust = await resolveManagedEnrollmentSshTrust({ correlation, carrier, trustedHostKey });
        const { createLiveRemoteSshBootstrapTaskKind } = await import('@/capabilities/systemTasks/ssh/liveRemoteSshBootstrap');
        const task = createLiveRemoteSshBootstrapTaskKind({ reviewedChild, prepareDedicatedBootstrap, onEnrollmentDeadline, deliverAuthApproval, approveLocalAuthRequest,
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
