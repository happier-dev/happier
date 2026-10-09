import {
    PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1, PROJECT_TRUST_ROUTE_V1,
    ProjectTrustListResponseV1Schema, ProjectTrustMutationRequestV1Schema, ProjectTrustMutationResponseV1Schema,
    ProjectTrustReadResponseV1Schema, ProjectTrustValueV1Schema, QualifiedProjectTrustProjectV1Schema,
    StoredProjectTrustValueV1Schema, assertProjectTrustContentForModeV1, assertProjectTrustValueForProjectV1,
    type ProjectTrustContentV1, type ProjectTrustMutationResponseV1, type ProjectTrustValueV1, type QualifiedProjectTrustProjectV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { resolveAccountStorageContext } from '@/sync/encryption/accountStorageContext';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { classifyHttpMutationRequestFailure } from '@/sync/http/mutationRequestOutcome';

const StoredReadSchema = createStoredReadSchema(ProjectTrustReadResponseV1Schema);
const StoredListSchema = createStoredReadSchema(ProjectTrustListResponseV1Schema);
export type OpenedProjectTrustRead =
    | Readonly<{ status: 'present'; revision: number; value: ProjectTrustValueV1 }>
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'deleted'; revision: number }>;
export type OpenedProjectTrustRow = Readonly<{ project: QualifiedProjectTrustProjectV1; revision: number; value: ProjectTrustValueV1 }>;
export type RememberReviewedProjectEffect = Readonly<ProjectTrustValueV1 & {
    currentEffectDigest: string; expectedRevision: number | 'absent';
}>;
type ProjectTrustErrorCode = 'project_trust_storage_unavailable' | 'project_trust_content_mode_mismatch'
    | 'project_trust_encryption_material_unavailable' | 'project_trust_identity_mismatch'
    | 'project_setup_effect_changed' | 'action_account_scope_changed' | 'present_user_required'
    | 'unauthorized' | 'forbidden' | 'unsupported' | 'cancelled' | 'not_dispatched' | 'outcome_unknown';
export class ProjectTrustOperationError extends Error {
    constructor(readonly code: ProjectTrustErrorCode) {
        super(code); this.name = 'ProjectTrustOperationError';
    }
}
type Account = Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'credentials' | 'request' | 'assertCurrent' | 'resolveAccountEncryption'>;
type TrustRequest = (path: string, init?: RequestInit) => Promise<Response>;
function failure(code: ProjectTrustErrorCode): never { throw new ProjectTrustOperationError(code); }
function preserveScopeFailure(error: unknown): void {
    if (error instanceof Error && ('code' in error ? error.code : error.message) === 'action_account_scope_changed') failure('action_account_scope_changed');
}
function materialFor(credentials: AuthCredentials, mode: 'plain' | 'e2ee'): AccountScopedCryptoMaterial | null {
    if (mode === 'plain') return null;
    try { return resolveAccountScopedCryptoMaterialFromCredentials(credentials); }
    catch { return failure('project_trust_encryption_material_unavailable'); }
}
function openContent(project: QualifiedProjectTrustProjectV1, input: ProjectTrustContentV1, mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null): ProjectTrustValueV1 {
    let content: ProjectTrustContentV1;
    try { content = assertProjectTrustContentForModeV1(input, mode); }
    catch { return failure('project_trust_content_mode_mismatch'); }
    const payload = content.t === 'plain' ? content.v : (() => {
        if (!material) return failure('project_trust_encryption_material_unavailable');
        return openAccountScopedBlobCiphertext({ kind: PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1, material, ciphertext: content.c })?.value;
    })();
    const parsed = StoredProjectTrustValueV1Schema.safeParse(payload);
    if (!parsed.success) return failure('project_trust_storage_unavailable');
    try { return assertProjectTrustValueForProjectV1(parsed.data, project); }
    catch { return failure('project_trust_identity_mismatch'); }
}
async function responseJson(response: Response): Promise<unknown> {
    if (!response.ok) {
        if (response.status === 401) return failure('unauthorized');
        if (response.status === 403) {
            const body: unknown = await response.json().catch(() => null);
            if (body && typeof body === 'object' && 'error' in body && body.error === 'present_user_required') return failure('present_user_required');
            return failure('forbidden');
        }
        if (response.status === 404) return failure('unsupported');
        return failure('project_trust_storage_unavailable');
    }
    try { return await response.json(); }
    catch { return failure('project_trust_storage_unavailable'); }
}
const requestInit = (body: unknown, signal?: AbortSignal): RequestInit => ({
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
});
async function readResponse(request: TrustRequest, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try { return await request(path, requestInit(body, signal)); }
    catch (error) {
        preserveScopeFailure(error);
        if (signal?.aborted) return failure('cancelled');
        // Native HTTP errors may retain request credentials; never export their message/config/cause.
        return failure('project_trust_storage_unavailable');
    }
}

/** Shared complete census/opening for captured UI Actions and the incumbent Account-mode converter. */
export async function fetchProjectTrustInventory(params: Readonly<{
    credentials: AuthCredentials; mode: 'plain' | 'e2ee'; request: TrustRequest;
    project?: QualifiedProjectTrustProjectV1; assertCurrent?: () => void; signal?: AbortSignal;
}>): Promise<readonly OpenedProjectTrustRow[]> {
    const project = params.project === undefined ? undefined : QualifiedProjectTrustProjectV1Schema.parse(params.project);
    const material = materialFor(params.credentials, params.mode);
    params.assertCurrent?.();
    const response = await readResponse(params.request, `${PROJECT_TRUST_ROUTE_V1}/list`, project ? { project } : {}, params.signal);
    params.assertCurrent?.();
    const raw = await responseJson(response); params.assertCurrent?.();
    const parsed = StoredListSchema.safeParse(raw);
    if (!parsed.success) return failure('project_trust_storage_unavailable');
    return parsed.data.rows.flatMap(row => {
        if (project && (row.project.serverId !== project.serverId || row.project.projectId !== project.projectId)) return failure('project_trust_identity_mismatch');
        return row.content === null ? [] : [{ project: row.project, revision: row.revision, value: openContent(row.project, row.content, params.mode, material) }];
    });
}

/** Internal port for the already-admitted projectAction family, using that invocation's captured Account. */
export function createProjectTrustClientForAccount(account: Account) {
    async function modeContext() {
        try {
            const { encryption } = await account.resolveAccountEncryption();
            const storage = await resolveAccountStorageContext(account.credentials, { encryption, request: account.request });
            account.assertCurrent();
            return { mode: storage.mode, material: materialFor(account.credentials, storage.mode) };
        } catch (error) {
            preserveScopeFailure(error);
            if (error instanceof ProjectTrustOperationError) throw error;
            return failure('project_trust_encryption_material_unavailable');
        }
    }
    async function verifyReadMode(mode: 'plain' | 'e2ee') {
        const current = await modeContext();
        if (current.mode !== mode) failure('project_trust_content_mode_mismatch');
        account.assertCurrent();
    }
    async function read(projectInput: QualifiedProjectTrustProjectV1, signal?: AbortSignal): Promise<OpenedProjectTrustRead> {
        const project = QualifiedProjectTrustProjectV1Schema.parse(projectInput);
        const context = await modeContext();
        const response = await readResponse((path, init) => account.request(path, init, { retry: 'none' }), `${PROJECT_TRUST_ROUTE_V1}/read`, { project }, signal);
        account.assertCurrent();
        const raw = await responseJson(response); account.assertCurrent();
        const parsed = StoredReadSchema.safeParse(raw);
        if (!parsed.success) return failure('project_trust_storage_unavailable');
        const row = parsed.data;
        const result: OpenedProjectTrustRead = row.status === 'present'
            ? { status: 'present', revision: row.revision, value: openContent(project, row.content, context.mode, context.material) } : row;
        await verifyReadMode(context.mode);
        return result;
    }
    async function mutate(body: ReturnType<typeof ProjectTrustMutationRequestV1Schema.parse>, signal?: AbortSignal): Promise<ProjectTrustMutationResponseV1> {
        account.assertCurrent(); signal?.throwIfAborted();
        let response: Response;
        try { response = await account.request(`${PROJECT_TRUST_ROUTE_V1}/mutate`, requestInit(body, signal), { retry: 'none' }); }
        catch (error) {
            preserveScopeFailure(error);
            return failure(classifyHttpMutationRequestFailure({ error, issued: true, signal }));
        }
        // An external acknowledgement remains true for this invoker even if the Home/Account retired meanwhile.
        let raw: unknown;
        if (response.ok) {
            try { raw = await response.json(); }
            catch { return failure('outcome_unknown'); }
        } else raw = await responseJson(response);
        const parsed = ProjectTrustMutationResponseV1Schema.safeParse(raw);
        if (!parsed.success) return failure('outcome_unknown');
        return parsed.data;
    }
    return {
        read,
        async list(project?: QualifiedProjectTrustProjectV1, signal?: AbortSignal): Promise<readonly OpenedProjectTrustRow[]> {
            const context = await modeContext();
            const rows = await fetchProjectTrustInventory({ credentials: account.credentials, mode: context.mode,
                request: (path, init) => account.request(path, init, { retry: 'none' }), project, signal, assertCurrent: account.assertCurrent });
            await verifyReadMode(context.mode);
            return rows;
        },
        async remember(decision: RememberReviewedProjectEffect, signal?: AbortSignal): Promise<ProjectTrustMutationResponseV1> {
            if (decision.reviewedEffectDigest !== decision.currentEffectDigest) return failure('project_setup_effect_changed');
            const value = ProjectTrustValueV1Schema.parse({ project: decision.project, reviewedEffectDigest: decision.reviewedEffectDigest, approvedAtMs: decision.approvedAtMs });
            const context = await modeContext();
            const content: ProjectTrustContentV1 = context.mode === 'plain' ? { t: 'plain', v: value } : { t: 'encrypted',
                c: sealAccountScopedBlobCiphertext({ kind: PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1,
                    material: context.material ?? failure('project_trust_encryption_material_unavailable'), payload: value, randomBytes: getRandomBytes }) };
            return mutate(ProjectTrustMutationRequestV1Schema.parse({ project: value.project, expectedRevision: decision.expectedRevision, content }), signal);
        },
        async revoke(input: Readonly<{ project: QualifiedProjectTrustProjectV1; expectedRevision: number; expectedEffectDigest: string }>, signal?: AbortSignal): Promise<ProjectTrustMutationResponseV1 | Readonly<{ status: 'notFound' }>> {
            const row = await read(input.project, signal);
            if (row.status !== 'present') return { status: 'notFound' };
            if (row.revision !== input.expectedRevision || row.value.reviewedEffectDigest !== input.expectedEffectDigest) return { status: 'conflict', revision: row.revision };
            return mutate(ProjectTrustMutationRequestV1Schema.parse({ project: row.value.project, expectedRevision: row.revision, content: null }), signal);
        },
    };
}

async function withTrustAccount<T>(scope: ServerAccountScope, signal: AbortSignal | undefined,
    operation: (client: ReturnType<typeof createProjectTrustClientForAccount>) => Promise<T>): Promise<T> {
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    let account: LazyActionAccountContext | undefined;
    try {
        account = await captureLazyActionAccountContext(scope.serverId, signal);
        if (account.accountId !== scope.accountId) return failure('action_account_scope_changed');
        return await operation(createProjectTrustClientForAccount(account));
    } catch (error) {
        if (error instanceof ProjectTrustOperationError) throw error;
        preserveScopeFailure(error);
        if (signal?.aborted) return failure('cancelled');
        if (error instanceof Error && error.message === 'action_home_signed_out') return failure('unauthorized');
        return failure('project_trust_storage_unavailable');
    } finally { account?.dispose(); }
}
export function readProjectTrust(scope: ServerAccountScope, project: QualifiedProjectTrustProjectV1, signal?: AbortSignal): Promise<OpenedProjectTrustRead> {
    return withTrustAccount(scope, signal, client => client.read(project, signal));
}
/** Called only by the actual human review surface; server requirePresentUser is the grant authority. */
export function rememberReviewedProjectEffect(scope: ServerAccountScope, decision: RememberReviewedProjectEffect, signal?: AbortSignal): Promise<ProjectTrustMutationResponseV1> {
    return withTrustAccount(scope, signal, client => client.remember(decision, signal));
}
