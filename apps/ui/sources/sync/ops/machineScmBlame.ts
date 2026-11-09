import {
    ScmBlameFileRequestSchema,
    ScmBlameFileResponseSchema,
    type ScmBlameFileRequest,
    type ScmBlameFileResponse,
} from '@happier-dev/protocol/scm';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import type { MachineScmCallOptions } from './scm/machineScm';
import { invokeUiScmAction, normalizeUiScmFacadeResult } from './scm/scmActionInvocation';
import { createFrontDoorActionExecute } from './actions/frontDoorRuntimeActionExecutor';

export async function machineScmBlameFile(
    machineId: string,
    request: ScmBlameFileRequest,
    options?: MachineScmCallOptions & Readonly<{ onApprovalPending?: (registration: ActionApprovalContinuation) => void }>,
): Promise<ScmBlameFileResponse> {
    const payload = ScmBlameFileRequestSchema.parse(request);
    const signal = options?.signal;
    const scope = options?.serverId && options.accountId ? { serverId: options.serverId, accountId: options.accountId } : null;
    const executor = createFrontDoorActionExecute(undefined, signal && scope && options?.onApprovalPending ? {
        hostActionApprovalLifetime: { actionId: 'scm.blame.get', signal, surface: 'ui' },
        onBlockingApprovalPending: ({ artifactId }) => {
            if (signal.aborted) return;
            options.onApprovalPending?.({ artifactId, scope, signal, refreshAfterExecution: false,
                onExecuted: async () => 'ignored' });
        },
    } : undefined);
    const response = await invokeUiScmAction({ actionId: 'scm.blame.get', input: payload,
        schema: ScmBlameFileResponseSchema, executor,
        context: { externalActionTarget: { kind: 'machine', machineId },
            ...(options?.serverId ? { serverId: options.serverId } : {}),
            ...(options?.accountId ? { expectedAccountId: options.accountId } : {}),
            ...(signal ? { signal } : {}),
        },
    });
    // This new read owns its error vocabulary. Only transport/admission failures
    // enter the legacy facade normalizer; stale_file remains an alignment fact.
    const parsed = ScmBlameFileResponseSchema.safeParse(response);
    if (parsed.success) return parsed.data;
    if ('success' in response && response.success) {
        return { success: false, errorCode: 'COMMAND_FAILED', error: 'The blame response could not be validated.' };
    }
    return normalizeUiScmFacadeResult<ScmBlameFileResponse>(response);
}
