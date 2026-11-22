import {
    attachRemoteWorkspace, readAttachableRemoteWorkspaces,
    type AttachableRemoteWorkspaceRequest, type AttachRemoteWorkspaceChoice,
} from '../machines/managed/attachableRemoteWorkspaceActions';

export async function attachRemoteHostWorkspace(input: Omit<AttachableRemoteWorkspaceRequest, 'selectors' | 'credentials'>
    & Omit<AttachRemoteWorkspaceChoice, 'workspaceId'> & Readonly<{ hostId: string }>) {
    const { hostId, signal, onApprovalPending, onProgress, ...request } = input;
    const account = await readAttachableRemoteWorkspaces({
        ...request, selectors: { remoteHostId: hostId }, signal, onApprovalPending,
    });
    if (account.kind !== 'ready') return account;
    return attachRemoteWorkspace({ account, workspaceId: hostId, signal, onApprovalPending, onProgress });
}
