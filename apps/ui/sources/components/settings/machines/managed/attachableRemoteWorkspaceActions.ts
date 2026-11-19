import { isMachineProvisionerWorkspaceAttachmentV1, projectMachineProvisionerSelectionV1,
    type MachineProvisionerContributionV1, type MachineProvisionerOptionsResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import type { ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedControllerV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { awaitActionApprovalResult, type ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
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

export type AttachRemoteWorkspaceOutcome = Readonly<{ kind: 'attached'; managedId: string; controller: ManagedControllerV1 }>
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
    const failed = (code: string, message?: string): AttachRemoteWorkspaceOutcome =>
        code === 'session_holder_unavailable' ? { kind: 'unsupported_platform' }
            : { kind: 'failed', code, message: message ?? null };
    const client = createManagedProvisionerClient(request.scope, request.homeId);
    const succeed = (value: { managedId: string }): AttachRemoteWorkspaceOutcome =>
        ({ kind: 'attached', managedId: value.managedId, controller: request.controller });
    const outcome = await awaitActionApprovalResult<{ managedId: string }, AttachRemoteWorkspaceOutcome>({
        signal: input.signal,
        aborted: () => failed('aborted'),
        succeeded: succeed,
        failed: (code, failure) => failed(code, projectManagedProvisionerFailure(code, failure?.details).message),
        execute: async callbacks => {
            input.onProgress?.({ kind: 'acquiring' });
            const result = await client.execute('machines.managed.acquire', {
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
    if (outcome.kind === 'failed' && outcome.code !== 'aborted') input.onProgress?.({ kind: 'failed', code: outcome.code });
    return outcome;
}
