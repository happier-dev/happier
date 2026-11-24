import { isMachineProvisionerWorkspaceAttachmentV1, projectMachineProvisionerSelectionV1,
    type MachineProvisionerContributionV1, type MachineProvisionerOptionsResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { ManagedAcceptedV1Schema, unwrapManagedMachineReadV1, type ManagedAcceptedV1, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MANAGED_ACQUIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ACTION_OPERATION_GET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { readActionOperationTaskQuestionV1 } from '@happier-dev/protocol/actions/operations/taskQuestionV1';
import { ActionOperationGetV1ResponseSchema, readActionOperationTerminalResultV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { awaitActionApprovalResult, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { submitActionOperationTaskAnswer } from '@/components/inbox/actionOperations/useActionOperationTaskQuestion';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { confirmSshHostKey } from '@/components/ssh/SshHostKeyTrustSheet';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { t } from '@/text';
import type { ManagedMachineCreationProgress } from './managedMachineCreation';
import { createManagedProvisionerClient, projectManagedProvisionerFailure } from './managedProvisionerClient';

type OptionsInput = ManagedMachineActionInputV1<'machines.provisioners.options'>;
export type AttachableRemoteWorkspaceRequest = Required<Pick<OptionsInput, 'homeId' | 'controller' | 'contribution' | 'selectors'>>
    & Pick<OptionsInput, 'credentials'> & Readonly<{
        scope: ServerAccountScope;
        descriptor: Pick<MachineProvisionerContributionV1, 'launchSchema' | 'schemaVersion' | 'workspaceAttachment'>;
    }>;

export type AttachableRemoteWorkspace = Readonly<{
    id: string;
    name: string;
    template: string | null;
    status: 'running' | 'stopped' | 'starting' | 'unknown';
}>;
type RemoteWorkspaceFailure = Readonly<{ kind: 'failed'; code: string; message: string | null }>;
export type AttachableRemoteWorkspaceAccount = Readonly<{
    kind: 'ready';
    request: AttachableRemoteWorkspaceRequest;
    options: MachineProvisionerOptionsResultV1;
    workspaces: readonly AttachableRemoteWorkspace[];
}>;

export async function readAttachableRemoteWorkspaces(input: AttachableRemoteWorkspaceRequest & Readonly<{
    signal: AbortSignal;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void;
}>): Promise<AttachableRemoteWorkspaceAccount | RemoteWorkspaceFailure> {
    const { scope, descriptor, signal, onApprovalPending, ...nativeInput } = input;
    const result = await createManagedProvisionerClient(scope, nativeInput.homeId).read('machines.provisioners.options',
        nativeInput, { signal, onApprovalPending });
    if (result.kind === 'failed') return { kind: 'failed', code: result.code, message: result.message ?? null };
    return { kind: 'ready', request: { scope, descriptor, ...nativeInput }, options: result.value,
        workspaces: result.value.dimensions.image.map(option => ({
            id: option.id,
            name: resolvePluginLocalizedStringV2Text(option.title),
            template: option.nativeFacts?.image ? resolvePluginLocalizedStringV2Text(option.nativeFacts.image.title) : null,
            status: option.nativeFacts?.workspaceStatus ?? 'unknown',
        })) };
}

export type AttachRemoteWorkspaceOutcome = Readonly<{ kind: 'attached'; managedId: string; controller: ManagedControllerV1;
    /** The guest's home from the attached record's platform probe, where a folder choice starts. */
    home?: string }>
    | Readonly<{ kind: 'unsupported_platform' }> | RemoteWorkspaceFailure;

export type AttachRemoteWorkspaceChoice = Readonly<{
    workspaceId: string;
    signal: AbortSignal;
    onApprovalPending(approval: ActionApprovalRegistration): void;
    onProgress?(progress: ManagedMachineCreationProgress): void;
}>;

export async function attachRemoteWorkspace(input: AttachRemoteWorkspaceChoice & Readonly<{
    account: AttachableRemoteWorkspaceAccount;
}>): Promise<AttachRemoteWorkspaceOutcome> {
    const { request, options, workspaces } = input.account;
    const selected = workspaces.find(row => row.id === input.workspaceId);
    const projection = projectMachineProvisionerSelectionV1({
        options, selection: { image: input.workspaceId }, launchSchema: request.descriptor.launchSchema,
    });
    if (!selected || projection.kind !== 'ready'
        || !isMachineProvisionerWorkspaceAttachmentV1(request.descriptor, projection.launch)) {
        return { kind: 'failed', code: 'invalid_parameters', message: null };
    }
    const failed = (code: string, message?: string): Exclude<AttachRemoteWorkspaceOutcome, { kind: 'attached' }> =>
        code === 'session_holder_unavailable' ? { kind: 'unsupported_platform' }
            : { kind: 'failed', code, message: message ?? null };
    const client = createManagedProvisionerClient(request.scope, request.homeId);
    const succeed = (value: ManagedAcceptedV1) => ({ kind: 'accepted' as const, value });
    const accepted = await awaitActionApprovalResult<ManagedAcceptedV1, ReturnType<typeof succeed> | ReturnType<typeof failed>>({
        signal: input.signal,
        aborted: () => failed('aborted'),
        succeeded: succeed,
        failed: (code, failure) => failed(code, projectManagedProvisionerFailure(code, failure?.details).message),
        execute: async callbacks => {
            input.onProgress?.({ kind: 'acquiring' });
            const result = await client.execute(MANAGED_ACQUIRE_ACTION_ID_V1, {
                selection: {
                    kind: 'one-off', homeId: request.homeId, controller: request.controller,
                    launch: {
                        provider: request.contribution, name: selected.name, choices: projection.launch,
                        schemaVersion: request.descriptor.schemaVersion, ...(request.credentials ? { credentials: request.credentials } : {}),
                    },
                    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, attachWorkspace: true,
                },
                enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
            }, { ...callbacks,
                onApprovalPending: approval => {
                    input.onProgress?.({ kind: 'approval' });
                    input.onApprovalPending(approval);
                },
                onApprovalAdmitted: () => callbacks.onApprovalFailed('target_unavailable'),
            }).catch(() => ({ kind: 'failed', code: 'provider_unavailable', message: undefined } as const));
            if (result.kind === 'approval_pending') return { approvalPending: true };
            if (result.kind === 'admitted') return failed('target_unavailable');
            return result.kind === 'succeeded' ? succeed(result.value) : failed(result.code, result.message);
        },
    });
    const finishFailure = (failure: ReturnType<typeof failed>) => {
        if (failure.kind === 'failed' && failure.code !== 'aborted') input.onProgress?.({ kind: 'failed', code: failure.code });
        return failure;
    };
    if (accepted.kind !== 'accepted') return finishFailure(accepted);
    let { managedId } = accepted.value;
    if (accepted.value.operation) {
        const { serverId, accountId } = request.scope;
        const { machineId } = request.controller;
        const { operationId } = accepted.value.operation;
        const execute = scopedHomeActionExecutor(request.scope);
        const readOperation = async (signal: AbortSignal, includePrompt = false) => {
            const result = await execute(ACTION_OPERATION_GET_ACTION_ID_V1, {
                serverId, machineId, operationId, waitForTerminal: true, ...(includePrompt ? { includeManagedPrompt: true } : {}),
            }, { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: accountId, signal })
                .catch(() => null);
            if (signal.aborted) return failed('aborted');
            if (!result) return failed('action_operation_unavailable');
            const observed = classifyHomeActionOutcome(result);
            if (observed.kind !== 'completed') return failed(observed.kind === 'failed'
                ? homeDomainFailureCode(observed.failure) : 'approval_required');
            const read = ActionOperationGetV1ResponseSchema.safeParse(observed.result);
            if (!read.success) return failed('invalid_action_output');
            return read.data.kind === 'found' ? read.data : failed('operation_not_found');
        };
        const initial = await readOperation(input.signal, true);
        if (initial.kind !== 'found') return finishFailure(initial);
        const snapshot = initial.operation;
        let terminal = readActionOperationTerminalResultV1(snapshot);
        if (!terminal) {
            const question = readActionOperationTaskQuestionV1(snapshot);
            const prompt = question?.prompt;
            if (prompt?.kind !== 'ssh.trustHost' && prompt?.kind !== 'ssh.replaceHostKey') {
                return finishFailure(failed('invalid_action_output'));
            }
            input.onProgress?.({ kind: 'acquiring', operation: snapshot });
            const retired = new AbortController();
            const cancellation = mergeAbortSignals([input.signal, retired.signal]);
            try {
                // Inbox can answer this task while the chooser is asking the same question.
                const settlement = readOperation(cancellation.signal);
                const first = await Promise.race([
                    settlement,
                    confirmSshHostKey(prompt, { signal: cancellation.signal }).then(trusted => ({ kind: 'decision' as const, trusted })),
                ]);
                if (input.signal.aborted) return failed('aborted');
                let settled = first.kind === 'decision' ? undefined : first;
                if (first.kind === 'decision') {
                    const answer = await submitActionOperationTaskAnswer({ serverId, snapshot }, { trusted: first.trusted }, input.signal);
                    if (input.signal.aborted) return failed('aborted');
                    if (!answer.ok) {
                        if (first.trusted || answer.errorCode !== 'action_operation_unavailable') {
                            return finishFailure(failed(answer.errorCode));
                        }
                        settled = await settlement;
                        if (input.signal.aborted) return failed('aborted');
                        if (settled.kind !== 'found'
                            || settled.operation.state !== 'succeeded'
                            || settled.operation.domainRef?.kind !== 'managedMachine'
                            || settled.operation.domainRef.bootstrapTask?.id !== question?.id) {
                            return finishFailure(failed(answer.errorCode));
                        }
                        publishPresentationNotice({
                            key: `remote-workspace-trust:${serverId}:${operationId}`,
                            severity: 'info',
                            message: t('files.pane.serverFolderTrustAlreadyAnswered'),
                        });
                    } else if (!first.trusted) {
                        return finishFailure(failed('host_trust_declined'));
                    }
                }
                settled ??= await settlement;
                if (settled.kind !== 'found') return finishFailure(settled);
                terminal = readActionOperationTerminalResultV1(settled.operation);
                if (!terminal) return finishFailure(failed('invalid_action_output'));
            } finally {
                retired.abort();
                cancellation.dispose();
            }
        }
        if (!terminal.ok) {
            const code = terminal.errorCode ?? 'action_operation_failed';
            return finishFailure(failed(code, projectManagedProvisionerFailure(code, terminal.details).message));
        }
        const settled = ManagedAcceptedV1Schema.safeParse(terminal.result);
        if (!settled.success) return finishFailure(failed('invalid_action_output'));
        managedId = settled.data.managedId;
    }
    // The attached record carries the guest platform probe; its home is where the person picks a folder.
    const read = await client.execute('machines.managed.get', { homeId: request.homeId, managedId },
        { signal: input.signal }).catch(() => null);
    const home = read?.kind === 'succeeded' ? unwrapManagedMachineReadV1(read.value).workspaceAttachment?.home : undefined;
    return { kind: 'attached', managedId, controller: request.controller, ...(home ? { home } : {}) };
}
