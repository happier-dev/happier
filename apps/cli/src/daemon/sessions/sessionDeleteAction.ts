import type { ActionExecutorDeps, ActionExecuteResult } from '@happier-dev/protocol/actions';
import { ActionExecuteFailureSchema, readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { createManagedSessionDirectories } from '@/session/creation/managedSessionDirectories';
import { prepareManagedSessionDirectoryRemovalAsMember } from '@/session/creation/memberSessionDirectoryRemoval';
import { requireProjectCheckoutRemovalOperation } from '@/workspaces/projectSetup/projectCheckoutRemoval';
import type { ProjectFiniteActionRuntime } from '@/workspaces/projectSetup/projectFiniteAction';

type SessionDelete = NonNullable<ActionExecutorDeps['sessionDelete']>;
const failure = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });

/** Consumes the original admitted deletion; Account authority is never reconstructed after DELETE. */
export function createNativeSessionDeleteAction(input: Readonly<{
    ingress: RpcHandlerContext;
    resolveRuntime(ingress: RpcHandlerContext): Promise<ProjectFiniteActionRuntime | null>;
    isSessionActive(sessionId: string): Promise<boolean>;
    retireRequesterCustody(sessionId: string): Promise<boolean>;
    nativeOperationRuntime: Pick<ApiMachineClient, 'prepareNativeOperation' | 'readMemberFolderOwner'>;
}>): SessionDelete {
    return async request => {
        const operation = requireProjectCheckoutRemovalOperation(request.context);
        let runtime: Promise<ProjectFiniteActionRuntime | null> | undefined;
        let memberRuntime: Pick<ProjectFiniteActionRuntime, 'requesterIdentity' | 'agentIsolation'> | undefined;
        const directories = createManagedSessionDirectories({
            resolveProjectRuntime: async ingress => {
                const installed = await (runtime ??= input.resolveRuntime(ingress));
                return installed && memberRuntime ? { ...installed, ...memberRuntime } : installed;
            },
        });
        let prepared: Awaited<ReturnType<typeof directories.prepareForSessionDeletion>> | undefined;
        try {
            const result = await request.deleteFromHome(async () => {
                // A tracked successor must enter the original reviewed Stop child too.
                if (await input.isSessionActive(request.input.sessionId)) return failure('session_active');
                if (prepared) return;
                prepared = await directories.prepareForSessionDeletion({ sessionId: request.input.sessionId,
                    removalContext: { ingress: input.ingress, context: request.context, operation, skipCleanup: request.input.skipCleanup },
                    async prepareMemberDirectory(directory, prepareRemoval) {
                        return prepareManagedSessionDirectoryRemovalAsMember({ nativeOperationRuntime: input.nativeOperationRuntime,
                            ingress: input.ingress, operation, directory, async prepareRemoval(reads, member) {
                                memberRuntime = member;
                                try { await prepareRemoval(reads); } finally { memberRuntime = undefined; }
                            } });
                    },
                });
                // Home can report active once more; never replay prepared teardown.
            });
            if (result.ok && prepared) for (const removal of await prepared.remove()) removal.settle('deleted');
            if (result.ok && !await input.retireRequesterCustody(request.input.sessionId)) {
                return failure('requester_session_custody_unavailable');
            }
            return result;
        } catch (error) {
            const errorCode = readActionErrorCodeV1(error) ?? 'session_directory_unavailable';
            const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
            const parsed = ActionExecuteFailureSchema.safeParse({ ok: false, errorCode, error: errorCode,
                ...(details === undefined ? {} : { details }) });
            return parsed.success ? parsed.data : failure(errorCode);
        } finally { await prepared?.dispose(); }
    };
}
