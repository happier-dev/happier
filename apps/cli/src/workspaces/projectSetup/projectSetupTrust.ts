import axios, { type AxiosResponse } from 'axios';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { randomBytes } from 'node:crypto';
import {
    PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1, PROJECT_TRUST_ROUTE_V1,
    ProjectTrustListResponseV1Schema, ProjectTrustMutationRequestV1Schema, ProjectTrustMutationResponseV1Schema,
    ProjectTrustReadResponseV1Schema, ProjectTrustValueV1Schema, QualifiedProjectTrustProjectV1Schema,
    StoredProjectTrustValueV1Schema,
    assertProjectTrustValueForProjectV1,
    type ProjectTrustContentV1, type ProjectTrustMutationResponseV1, type ProjectTrustValueV1, type QualifiedProjectTrustProjectV1,
} from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext, type AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { isAccountScopedBlobCiphertextForKind } from '@happier-dev/protocol/crypto/accountScopedCipherEnvelope';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';

import type { StoredCredentials } from '@/persistence';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { hasUsableAccountSettingsEncryptionMaterial } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

const StoredTrustReadResponseSchema = createStoredReadSchema(ProjectTrustReadResponseV1Schema);
const StoredTrustListResponseSchema = createStoredReadSchema(ProjectTrustListResponseV1Schema);

export type OpenedProjectTrustRead =
    | Readonly<{ status: 'present'; revision: number; value: ProjectTrustValueV1 }>
    | Readonly<{ status: 'absent' }>
    | Readonly<{ status: 'deleted'; revision: number }>;

function fail(code: string): never {
    throw Object.assign(new Error(code), { code });
}
/** The same mode/binding codec serves ordinary and admitted private requester custody. */
export function createProjectSetupTrustRowCipher(input: Readonly<{ mode: 'plain' | 'e2ee'; material: AccountScopedCryptoMaterial | null }>) {
    return {
        open(project: QualifiedProjectTrustProjectV1, content: ProjectTrustContentV1): ProjectTrustValueV1 {
            if ((input.mode === 'plain' && content.t !== 'plain') || (input.mode === 'e2ee' && content.t !== 'encrypted')) return fail('project_trust_content_mode_mismatch');
            let payload: unknown;
            if (content.t === 'plain') payload = content.v;
            else {
                if (!isAccountScopedBlobCiphertextForKind({ kind: PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1, ciphertext: content.c })) return fail('project_trust_content_mode_mismatch');
                if (!input.material) return fail('project_trust_encryption_material_unavailable');
                payload = openAccountScopedBlobCiphertext({ kind: PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1, material: input.material, ciphertext: content.c })?.value;
            }
            const parsed = StoredProjectTrustValueV1Schema.safeParse(payload);
            if (!parsed.success) return fail('project_trust_storage_unavailable');
            try { return assertProjectTrustValueForProjectV1(parsed.data, project); }
            catch { return fail('project_trust_identity_mismatch'); }
        },
        seal(value: ProjectTrustValueV1): ProjectTrustContentV1 {
            const payload = ProjectTrustValueV1Schema.parse(value);
            return input.mode === 'plain' ? { t: 'plain', v: payload } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                kind: PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1, material: input.material ?? fail('project_trust_encryption_material_unavailable'),
                payload, randomBytes: size => new Uint8Array(randomBytes(size)),
            }) };
        },
    };
}

/** The approving Account is the authenticated transport principal, including on foreign Machines. */
export type ProjectSetupTrustClientInput = Readonly<{
    credentials?: StoredCredentials;
    serverHttpBaseUrl: string;
    authorization?: ExternalActionExecutionAuthorizationV1;
    effectActionId?: string;
    signal?: AbortSignal;
}>;
export function createProjectSetupTrustClient(input: ProjectSetupTrustClientInput) {
    const baseUrl = input.serverHttpBaseUrl.replace(/\/$/u, '');
    const options = {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.credentials?.token ?? ''}` },
        validateStatus: () => true,
    };
    async function assertCurrent() {
        if (!input.authorization) {
            if (!input.credentials) return fail('project_trust_encryption_material_unavailable');
            return;
        }
        const account = input.authorization.requesterAccountProjection;
        const http = input.authorization.requesterHttpProjection;
        if (!account || !http || account.accountId !== input.authorization.binding.accountId || account.accountId !== http.accountId
            || account.serverId !== http.serverId || http.serverHttpBaseUrl.replace(/\/$/u, '') !== baseUrl
            || !await account.isCurrent() || !await http.isCurrent() || input.signal?.aborted) return fail('project_trust_storage_unavailable');
    }
    async function modeContext() {
        await assertCurrent();
        const projection = input.authorization?.requesterAccountProjection;
        const result = projection ? { kind: 'resolved' as const, mode: projection.accountEncryptionMode }
            : await readAccountEncryptionModeOnce({ request: () => axios.get(`${baseUrl}/v1/account/encryption`, options)
                .catch(() => fail('project_trust_storage_unavailable')) });
        if (result.kind !== 'resolved') return fail('project_trust_storage_unavailable');
        if (projection?.projectTrustRowCipher) return { mode: result.mode, cipher: projection.projectTrustRowCipher };
        let material: AccountScopedCryptoMaterial | undefined;
        if (result.mode === 'e2ee') {
            if (!input.credentials || !hasUsableAccountSettingsEncryptionMaterial(input.credentials)) return fail('project_trust_encryption_material_unavailable');
            const encryption = input.credentials.encryption;
            material = encryption.type === 'legacy' ? { type: 'legacy', secret: encryption.secret } : { type: 'dataKey', machineKey: encryption.machineKey };
        }
        return { mode: result.mode, cipher: createProjectSetupTrustRowCipher({ mode: result.mode, material: material ?? null }) };
    }
    async function request(operation: 'read' | 'list' | 'mutate', body: unknown): Promise<unknown> {
        await assertCurrent();
        const path = `${PROJECT_TRUST_ROUTE_V1}/${operation}`;
        const requesterHeaders = input.authorization ? await input.authorization.requesterHttpProjection!.createRequestHeaders({
            effectActionId: input.effectActionId ?? input.authorization.binding.actionId, method: 'POST', path, body,
            ...(input.signal ? { signal: input.signal } : {}),
        }) : null;
        if (input.authorization && !requesterHeaders) return fail('project_trust_storage_unavailable');
        let response: AxiosResponse<unknown>;
        try {
            response = await axios.post<unknown>(`${baseUrl}${path}`, body, { ...options,
                ...(requesterHeaders ? { headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...requesterHeaders } } : {}),
                ...(input.signal ? { signal: input.signal } : {}),
            });
        } catch { return fail(operation === 'mutate' ? 'outcome_unknown' : 'project_trust_storage_unavailable'); }
        // A returned refusal is definitive; a transport failure after issuing a mutation is not.
        if (response.status < 200 || response.status >= 300) return fail('project_trust_storage_unavailable');
        await assertCurrent();
        return response.data;
    }
    async function mutate(body: ReturnType<typeof ProjectTrustMutationRequestV1Schema.parse>): Promise<ProjectTrustMutationResponseV1> {
        const parsed = ProjectTrustMutationResponseV1Schema.safeParse(await request('mutate', body));
        if (!parsed.success) return fail('outcome_unknown');
        return parsed.data;
    }
    function open(project: QualifiedProjectTrustProjectV1, content: ProjectTrustContentV1, context: Awaited<ReturnType<typeof modeContext>>): ProjectTrustValueV1 {
        return context.cipher.open(project, content);
    }
    async function read(projectInput: QualifiedProjectTrustProjectV1): Promise<OpenedProjectTrustRead> {
        const project = QualifiedProjectTrustProjectV1Schema.parse(projectInput);
        if (input.authorization) {
            const profileId = input.authorization.requesterAccountProjection?.serverId;
            if (!profileId || !await isServerProfileHomeIdentity(profileId, project.serverId)) return fail('project_trust_identity_mismatch');
        }
        const context = await modeContext();
        const parsed = StoredTrustReadResponseSchema.safeParse(await request('read', { project }));
        if (!parsed.success) return fail('project_trust_storage_unavailable');
        const row = parsed.data;
        return row.status === 'present' ? { status: 'present', revision: row.revision, value: open(project, row.content, context) } : row;
    }
    return {
        read,
        async resolveConsent(project: QualifiedProjectTrustProjectV1, reviewedEffectDigest: string): Promise<
            Readonly<{ kind: 'trusted'; reviewedEffectDigest: string }>
            | Readonly<{ kind: 'pendingApproval'; code: 'project_setup_consent_required'; reviewedEffectDigest: string }>
        > {
            if (!reviewedEffectDigest) return fail('project_setup_effect_unavailable');
            const row = await read(project);
            return row.status === 'present' && row.value.reviewedEffectDigest === reviewedEffectDigest
                ? { kind: 'trusted', reviewedEffectDigest }
                : { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest };
        },
        async list(projectInput?: QualifiedProjectTrustProjectV1): Promise<Array<Readonly<{ project: QualifiedProjectTrustProjectV1; revision: number; value: ProjectTrustValueV1 }>>> {
            const project = projectInput === undefined ? undefined : QualifiedProjectTrustProjectV1Schema.parse(projectInput);
            const context = await modeContext();
            const parsed = StoredTrustListResponseSchema.safeParse(await request('list', project ? { project } : {}));
            if (!parsed.success) return fail('project_trust_storage_unavailable');
            return parsed.data.rows.flatMap(row => {
                if (project && (row.project.serverId !== project.serverId || row.project.projectId !== project.projectId)) return fail('project_trust_identity_mismatch');
                return row.content === null ? [] : [{ project: row.project, revision: row.revision, value: open(row.project, row.content, context) }];
            });
        },
        async approveReviewedEffect(decision: Readonly<ProjectTrustValueV1 & {
            expectedRevision: number | 'absent'; authority: ActionRequiredAuthority; currentEffectDigest: string;
        }>): Promise<ProjectTrustMutationResponseV1> {
            // Only the human-decision consumer calls this producer; Action input has no grant arm.
            if (decision.authority !== 'present_user') return fail('project_setup_consent_required');
            if (decision.reviewedEffectDigest !== decision.currentEffectDigest) return fail('project_setup_effect_changed');
            const value = ProjectTrustValueV1Schema.parse({ project: decision.project, reviewedEffectDigest: decision.reviewedEffectDigest, approvedAtMs: decision.approvedAtMs });
            const context = await modeContext();
            const content = context.cipher.seal(value);
            const body = ProjectTrustMutationRequestV1Schema.parse({ project: value.project, expectedRevision: decision.expectedRevision, content });
            return mutate(body);
        },
        async revoke(revocation: Readonly<{ project: QualifiedProjectTrustProjectV1; expectedRevision: number; expectedEffectDigest: string }>): Promise<ProjectTrustMutationResponseV1 | Readonly<{ status: 'notFound' }>> {
            const row = await read(revocation.project);
            if (row.status !== 'present') return { status: 'notFound' };
            if (row.revision !== revocation.expectedRevision || row.value.reviewedEffectDigest !== revocation.expectedEffectDigest) return { status: 'conflict', revision: row.revision };
            const body = ProjectTrustMutationRequestV1Schema.parse({ project: row.value.project, expectedRevision: row.revision, content: null });
            return mutate(body);
        },
    };
}
