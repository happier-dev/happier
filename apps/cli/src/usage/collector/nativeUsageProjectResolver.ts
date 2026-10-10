import type { DeviceLocalSecretStorage } from '@/daemon/deviceLocalSecretStorage';
import type { StoredCredentials } from '@/persistence';
import type { NativeUsageCaptureAuthority } from './nativeUsageCaptureState';
import { isCanonicalAbsoluteObservationFilePath } from '@happier-dev/protocol/sessions/external/externalAgentObservationV1';
import { normalizeWorkspaceRootPathV1, resolveWorkspacePathBasenameV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { mutateProjectAccountOrganization, readProjectAccountRows } from '@/workspaces/projectAccountRows';

export type NativeUsageProjectWitness = Readonly<{ rootPath: string; label?: string }>;
export type NativeUsageProjectResolverInput = Readonly<{
    authority: NativeUsageCaptureAuthority;
    storage: DeviceLocalSecretStorage;
    serverHttpBaseUrl: string;
    readCredentials(): Promise<StoredCredentials | null>;
}>;

/** Reuses accepted checkouts read-only; native-only labels use the existing Account organization row. */
export function createNativeUsageProjectResolver(input: NativeUsageProjectResolverInput) {
    const refusal = (code: string) => Object.assign(new Error(code), { code });
    return async (project: NativeUsageProjectWitness, signal: AbortSignal): Promise<{ projectKey: string; workspaceId?: string }> => {
        signal.throwIfAborted();
        if (!isCanonicalAbsoluteObservationFilePath(project.rootPath)) throw refusal('usage_project_root_invalid');
        const credentials = await input.readCredentials();
        signal.throwIfAborted();
        if (!credentials || readAccountIdFromToken(credentials.token) !== input.authority.accountId) {
            throw refusal('usage_account_authority_unavailable');
        }
        return await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, async () => {
            const rowInput = { credentials, serverId: input.authority.serverId, signal };
            const snapshot = await readProjectAccountRows(rowInput);
            signal.throwIfAborted();
            const workspace = resolveWorkspaceRefV1(snapshot.workspaceRefs, {
                serverId: input.authority.serverId, machineId: input.authority.machineId, rootPath: project.rootPath,
            }, { rootsEqual: (left, right) => getPathRemainderWithinBase(left, right) === '' });
            if (workspace.kind === 'resolved') {
                return { projectKey: workspace.ref.projectKey ?? workspace.ref.id, workspaceId: workspace.ref.id };
            }
            if (workspace.kind !== 'missing') throw refusal(`workspace_ref_${workspace.kind}`);
            const projectKey = input.storage.deriveOpaqueIdentity({ purpose: 'usage_accounting_identity',
                value: JSON.stringify(['native-project', input.authority.serverId, input.authority.accountId,
                    input.authority.machineId, normalizeWorkspaceRootPathV1(project.rootPath)]) });
            const label = project.label?.trim() || resolveWorkspacePathBasenameV1(project.rootPath)?.trim() || undefined;
            const known = snapshot.organizations.find(row => row.key.serverId === input.authority.serverId && row.key.projectKey === projectKey);
            if (known && (known.value.label !== undefined || label === undefined)) return { projectKey };
            const accepted = await mutateProjectAccountOrganization({ ...rowInput, projectKey,
                mutate: value => value.label !== undefined || label === undefined ? value : { ...value, label } });
            signal.throwIfAborted();
            if (accepted.status !== 'updated') throw refusal(`usage_project_${accepted.status}`);
            return { projectKey };
        });
    };
}
