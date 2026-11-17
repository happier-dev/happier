import { readAcceptedProjectSetupV1, type ProjectSetupReadV1 } from '@happier-dev/protocol/projects/projectSetupV1';
import type { ProjectAccountOrganizationV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createCredentialedAccountArtifactStore, type AccountArtifact } from '@/api/artifacts/accountArtifactStore';
import { readRequesterAccountActionContext, requesterAccountEncryptionMode } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readProjectAccountRows, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { readPublishedProjectSetupV1 } from '@happier-dev/protocol/projects/projectSetupChangeV1';

/** Explicit review/import only, through the existing Source transport and Artifact envelope owner. */
export async function readPublishedProjectSetup(input: Readonly<{
    account: ProjectAccountRowsInput; serverId: string; sourceId: string; serverHttpBaseUrl: string; signal?: AbortSignal;
}>) {
    const authorization = input.account.authorization;
    const requester = readRequesterAccountActionContext(authorization);
    const credentials = authorization ? requester?.credentials : input.account.credentials;
    if (!credentials) throw Object.assign(new Error('project_requester_credentials_unavailable'), { code: 'project_requester_credentials_unavailable' });
    const headers = async (request: Readonly<{ method: string; path: string; body?: unknown }>) => {
        if (!authorization) return { Authorization: `Bearer ${credentials.token}` };
        const result = await authorization.requesterHttpProjection?.createRequestHeaders({ ...request,
            effectActionId: input.account.effectActionId ?? authorization.binding.actionId, signal: input.signal });
        if (!result) throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
        return { ...result, [requesterAccountEncryptionMode]: requester!.accountEncryptionCurrentness.mode };
    };
    const sources = createCliProjectSourceActionDeps({ serverHttpBaseUrl: input.serverHttpBaseUrl,
        // The receiving projects.inspect owner has already admitted this captured Home/requester.
        admitAccount: () => null, resolveRequestHeaders: (_context, _actionId, request) => headers(request) });
    const result = await sources.projectSourcesRead!({ serverId: input.serverId, sourceId: input.sourceId },
        { signal: input.signal, ...(authorization ? { externalActionExecutionAuthorization: authorization } : {}) });
    if (!result.ok) {
        const code = 'errorCode' in result ? result.errorCode : result.error;
        throw Object.assign(new Error(code), result, { code });
    }
    const artifacts = createCredentialedAccountArtifactStore(credentials);
    return runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => readPublishedProjectSetupV1({ source: result.source,
        readArtifact: (artifactId, projectSourceId) => artifacts.read(artifactId, { signal: input.signal, projectSourceId,
            includeSharedAudience: false, prepareRecipients: false, authorizationHeaders: headers }),
    }));
}

export type AcceptedProjectSetupResult = ProjectSetupReadV1;

/** Reads only the accepted local detail, so publisher deletion cannot change an accepted launch. */
export async function readAcceptedProjectSetup(input: Readonly<{
    organization: ProjectAccountOrganizationV1 | null;
    signal?: AbortSignal;
    readArtifact(artifactId: string): Promise<Pick<AccountArtifact, 'artifactId' | 'header' | 'body' | 'revision'> | null>;
}>): Promise<AcceptedProjectSetupResult> {
    return readAcceptedProjectSetupV1({ ...input.organization, signal: input.signal, readArtifact: input.readArtifact });
}

/** Captured requester authority owns both selected row and Artifact reads; no daemon-Account fallback. */
export async function readAcceptedProjectSetupForProject(input: Readonly<{
    account: ProjectAccountRowsInput; project: Readonly<{ serverId: string; projectId: string }>;
    serverHttpBaseUrl: string; signal?: AbortSignal;
    organization?: ProjectAccountOrganizationV1 | null;
}>): Promise<AcceptedProjectSetupResult> {
    const organization = input.organization === undefined ? (await runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => readProjectAccountRows({ ...input.account,
        serverId: input.project.serverId, selection: { key: { kind: 'project-organization', serverId: input.project.serverId,
            projectKey: input.project.projectId } }, signal: input.signal }))).organizations[0]?.value ?? null : input.organization;
    // The common no-setup path acquires neither Artifact crypto nor a content reader.
    if (!organization?.setupContent) return readAcceptedProjectSetup({ organization, signal: input.signal, readArtifact: async () => null });
    const authorization = input.account.authorization;
    const requester = readRequesterAccountActionContext(authorization);
    const credentials = authorization ? requester?.credentials : input.account.credentials;
    if (!credentials) return { kind: 'unavailable', code: 'project_requester_credentials_unavailable' };
    const artifacts = createCredentialedAccountArtifactStore(credentials);
    return runWithServerHttpBaseUrl(input.serverHttpBaseUrl, () => readAcceptedProjectSetup({ organization, signal: input.signal,
        readArtifact: artifactId => artifacts.read(artifactId, { signal: input.signal, includeSharedAudience: false,
            ...(authorization ? { prepareRecipients: false, authorizationHeaders: async request => {
                const headers = await authorization.requesterHttpProjection?.createRequestHeaders({ ...request,
                    effectActionId: input.account.effectActionId ?? authorization.binding.actionId, signal: input.signal });
                if (!headers) throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
                return { ...headers, [requesterAccountEncryptionMode]: requester!.accountEncryptionCurrentness.mode };
            } } : {}),
        }),
    }));
}
