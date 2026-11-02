import {
  createRemoteNativeBootstrapMachineTaskKind,
  SystemTaskExecutionError,
} from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';
import {
  ManagedInstallationServerOriginV1Schema,
  ManagedTerminalPairingContextV1Schema,
  type ManagedEnrollmentCorrelationV1,
} from '@happier-dev/protocol/machines/managed/actionsV1';
import { readHostAdmittedReviewedParentV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';

type ManagedEnrollmentResponseOwner = Readonly<{
  correlation: ManagedEnrollmentCorrelationV1;
  operationId: string;
  enrollmentAccountId: string;
  readTaskId(): string | undefined;
  reviewedChild?: HostReviewedChildPortV1;
}>;

async function assertManagedEnrollmentResponse(
  input: ManagedEnrollmentResponseOwner,
  authorization: unknown,
  phase: 'answer' | 'delivery',
  prompt: Readonly<{ kind: string; promptId?: string }>,
): Promise<void> {
  const origin =
    ManagedInstallationServerOriginV1Schema.safeParse(authorization);
  if (!origin.success)
    throw new SystemTaskExecutionError(
      'permission_denied',
      'Current requester approval authority is required.',
    );
  const { purpose } = origin.data;
  const taskId = input.readTaskId();
  if (
    !taskId ||
    purpose.taskId !== taskId ||
    purpose.operationId !== input.operationId ||
    purpose.homeId !== input.correlation.homeId ||
    purpose.managedId !== input.correlation.managedId ||
    purpose.expectedPromptKind !== prompt.kind ||
    purpose.expectedPromptId !== prompt.promptId ||
    purpose.phase !== phase
  ) {
    throw new SystemTaskExecutionError(
      'permission_denied',
      'Pairing approval does not address this managed creation.',
    );
  }
}

/** Every managed installer answer, not just secret delivery, belongs to this task's creation. */
export function createManagedEnrollmentResponseValidation(
  input: ManagedEnrollmentResponseOwner,
  prompt: Readonly<{ kind: string; promptId?: string }>,
): (authorization: unknown) => Promise<void> {
  return async (authorization) => {
    await assertManagedEnrollmentResponse(
      input,
      authorization,
      'answer',
      prompt,
    );
  };
}

/** The task owns this closure only while its exact pairing question is unanswered. */
export function createManagedEnrollmentPairingDelivery(
  input: ManagedEnrollmentResponseOwner,
): NonNullable<
  Parameters<
    typeof createRemoteNativeBootstrapMachineTaskKind
  >[0]['deliverAuthApproval']
> {
  const reviewedParent = readHostAdmittedReviewedParentV1(input.reviewedChild);
  return async (data) => {
    data.signal?.throwIfAborted();
    const request = data.request;
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      !('authorization' in request) ||
      !('request' in request)
    ) {
      throw new SystemTaskExecutionError(
        'permission_denied',
        'Current requester approval authority is required.',
      );
    }
    const delivery = request.request;
    if (
      !delivery ||
      typeof delivery !== 'object' ||
      Array.isArray(delivery) ||
      !('kind' in delivery) ||
      delivery.kind !== 'terminalPairing' ||
      Object.keys(delivery).length !== 1
    ) {
      throw new SystemTaskExecutionError(
        'permission_denied',
        'Current requester approval authority is required.',
      );
    }
    await assertManagedEnrollmentResponse(
      input,
      request.authorization,
      'delivery',
      { kind: 'auth.approveRemoteProvisioning' },
    );
    data.signal?.throwIfAborted();
    const context = ManagedTerminalPairingContextV1Schema.safeParse({
      publicKey: data.publicKey,
      homeServerIdentityId: data.homeServerIdentityId,
      pairing: data.pairing,
      supportsTokenOnly: data.supportsTokenOnly,
      pairingRequirement: 'v3',
      enrollmentAccountId: input.enrollmentAccountId,
      ...(reviewedParent ? { reviewedParent: { actionId: reviewedParent.actionId } } : {}),
    });
    if (
      !context.success ||
      context.data.homeServerIdentityId !== input.correlation.homeId ||
      context.data.pairing.expiresAtMs <= context.data.pairing.createdAtMs
    ) {
      throw new SystemTaskExecutionError(
        'invalid_cli_response',
        'Authenticated guest pairing context is unavailable.',
      );
    }
    if (Date.now() >= context.data.pairing.expiresAtMs) {
      throw new SystemTaskExecutionError(
        'auth_request_expired',
        'Guest pairing has expired. Retry setup.',
      );
    }
    return context.data;
  };
}
