import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { ProjectTrustMutationRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';

import { createProjectSetupTrustClient } from './projectSetupTrust';

describe('approving-Account Project setup trust', () => {
    afterEach(() => vi.restoreAllMocks());
    const project = { serverId: 'home', projectId: 'project-p' };
    const grant = { project, reviewedEffectDigest: 'effect', approvedAtMs: 1 };
    const baseUrl = 'https://requester.example';
    const decision = { ...grant, expectedRevision: 'absent' as const, authority: 'present_user' as const, currentEffectDigest: 'effect' };

    it('replaces one current Project grant and forgets only the selected Project through row CAS, with no Settings write', async () => {
        let content: unknown = null;
        let revision = 0;
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, raw, options) => {
            expect(options?.headers?.Authorization).toBe('Bearer requester');
            const body = raw as { project: typeof project; content: unknown; expectedRevision: number | 'absent' };
            if (!String(url).endsWith('/list')) expect(body.project).toEqual(project);
            if (String(url).endsWith('/read')) return { status: 200, data: content === null
                ? revision === 0 ? { status: 'absent' } : { status: 'deleted', revision }
                : { status: 'present', revision, content } };
            if (String(url).endsWith('/list')) return { status: 200, data: { rows: [{ project, revision, content }] } };
            expect(url).toBe(`${baseUrl}/v1/account/project-trust/mutate`);
            expect(body.expectedRevision).toBe(revision === 0 ? 'absent' : revision);
            content = body.content;
            revision += 1;
            return { status: 200, data: { status: 'updated', revision, cursor: revision } };
        });
        const client = createProjectSetupTrustClient({ credentials: { token: 'requester', encryption: null }, serverHttpBaseUrl: baseUrl });
        expect(await client.read(project)).toEqual({ status: 'absent' });
        expect(await client.approveReviewedEffect(decision)).toMatchObject({ status: 'updated', revision: 1 });
        expect(await client.read(project)).toEqual({ status: 'present', revision: 1, value: grant });
        expect(await client.resolveConsent(project, 'effect')).toEqual({ kind: 'trusted', reviewedEffectDigest: 'effect' });
        expect(await client.resolveConsent(project, 'changed')).toEqual({ kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'changed' });
        const changed = { ...decision, reviewedEffectDigest: 'changed', currentEffectDigest: 'changed', expectedRevision: 1 };
        await client.approveReviewedEffect(changed);
        expect(await client.list(project)).toEqual([{ project, revision: 2, value: { ...grant, reviewedEffectDigest: 'changed' } }]);
        expect(await client.list()).toEqual([{ project, revision: 2, value: { ...grant, reviewedEffectDigest: 'changed' } }]);
        expect(await client.revoke({ project, expectedRevision: 2, expectedEffectDigest: 'effect' })).toEqual({ status: 'conflict', revision: 2 });
        expect(await client.revoke({ project, expectedRevision: 2, expectedEffectDigest: 'changed' })).toMatchObject({ status: 'updated', revision: 3 });
        expect(await client.read(project)).toEqual({ status: 'deleted', revision: 3 });
        expect(post.mock.calls.every(([url]) => String(url).startsWith(`${baseUrl}/v1/account/project-trust/`))).toBe(true);
    });

    it('requires a current human-reviewed effect even if invocation approval was waived', async () => {
        const post = vi.spyOn(axios, 'post');
        const client = createProjectSetupTrustClient({ credentials: { token: 'requester', encryption: null }, serverHttpBaseUrl: baseUrl });
        await expect(client.approveReviewedEffect({ ...decision, authority: 'account_automation' })).rejects.toMatchObject({ code: 'project_setup_consent_required' });
        await expect(client.approveReviewedEffect({ ...decision, currentEffectDigest: 'changed' })).rejects.toMatchObject({ code: 'project_setup_effect_changed' });
        expect(post).not.toHaveBeenCalled();
    });

    it.each(['revoke', 'approve'] as const)('retains an unknown %s write outcome after lost or malformed acknowledgements without replay or raw credentials', async operation => {
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        let receipt: 'lost' | 'malformed' = 'lost';
        const committed: ReturnType<typeof ProjectTrustMutationRequestV1Schema.parse>[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            if (String(url).endsWith('/read')) return { status: 200, data: { status: 'present', revision: 4, content: { t: 'plain', v: grant } } };
            expect(url).toBe(`${baseUrl}/v1/account/project-trust/mutate`);
            committed.push(ProjectTrustMutationRequestV1Schema.parse(body));
            if (receipt === 'lost') throw Object.assign(new Error('Native HTTP response lost'), { config: { headers: { Authorization: 'Bearer private-transport-token' } } });
            return { status: 200, data: { status: 'updated', revision: 'malformed', cursor: 1 } };
        });
        const client = createProjectSetupTrustClient({ credentials: { token: 'requester', encryption: null }, serverHttpBaseUrl: baseUrl });
        const invoke = () => operation === 'revoke'
            ? client.revoke({ project, expectedRevision: 4, expectedEffectDigest: grant.reviewedEffectDigest })
            : client.approveReviewedEffect({ ...decision, expectedRevision: 4 });
        for (const kind of ['lost', 'malformed'] as const) {
            receipt = kind;
            const before = committed.length;
            const error: unknown = await invoke().catch((error: unknown) => error);
            expect(error).toMatchObject({ code: 'outcome_unknown' });
            expect(error).not.toHaveProperty('cause');
            expect(error).not.toHaveProperty('config');
            expect(JSON.stringify(error)).not.toContain('private-transport-token');
            expect(committed).toHaveLength(before + 1);
            expect(committed.at(-1)).toEqual({ project, expectedRevision: 4, content: operation === 'revoke' ? null : { t: 'plain', v: grant } });
        }
    });

    it('retains definitive mutation denial and read failure classifications rather than declaring an unknown write', async () => {
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.spyOn(axios, 'post').mockImplementation(async url => String(url).endsWith('/read')
            ? { status: 200, data: { status: 'present', revision: 4, content: { t: 'plain', v: grant } } }
            : { status: 403, data: { error: 'present_user_required' } });
        const client = createProjectSetupTrustClient({ credentials: { token: 'requester', encryption: null }, serverHttpBaseUrl: baseUrl });
        await expect(client.revoke({ project, expectedRevision: 4, expectedEffectDigest: grant.reviewedEffectDigest }))
            .rejects.toMatchObject({ code: 'project_trust_storage_unavailable' });
        await expect(client.approveReviewedEffect(decision)).rejects.toMatchObject({ code: 'project_trust_storage_unavailable' });
        post.mockRejectedValue(Object.assign(new Error('Read transport lost'), { config: { headers: { Authorization: 'Bearer private-transport-token' } } }));
        await expect(client.read(project)).rejects.toMatchObject({ code: 'project_trust_storage_unavailable' });
    });

    it('opens opaque E2EE only for the exact Project and drops stored extras without granting another Project', async () => {
        const secret = new Uint8Array(32).fill(7);
        const material = { type: 'legacy' as const, secret };
        const ciphertext = sealAccountScopedBlobCiphertext({ kind: 'project_setup_trust', material,
            payload: { ...grant, future: true, project: { ...project, future: true } }, randomBytes: (size) => new Uint8Array(size).fill(8) });
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'present', revision: 1, content: { t: 'encrypted', c: ciphertext, future: true } } });
        const client = createProjectSetupTrustClient({ credentials: { token: 'requester', encryption: { type: 'legacy', secret } }, serverHttpBaseUrl: baseUrl });
        expect(await client.read(project)).toEqual({ status: 'present', revision: 1, value: grant });
        await expect(client.read({ ...project, projectId: 'project-q' })).rejects.toMatchObject({ code: 'project_trust_identity_mismatch' });
        const profileCiphertext = sealAccountScopedBlobCiphertext({ kind: 'account_profile_record', material,
            payload: grant, randomBytes: size => new Uint8Array(size).fill(9) });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'present', revision: 1, content: { t: 'encrypted', c: profileCiphertext } } });
        await expect(client.read(project)).rejects.toMatchObject({ code: 'project_trust_content_mode_mismatch' });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (_url, raw) => {
            const body = raw as { content: { t: 'encrypted'; c: string } };
            expect(body.content.t).toBe('encrypted');
            expect(openAccountScopedBlobCiphertext({ kind: 'project_setup_trust', material, ciphertext: body.content.c })?.value).toEqual(grant);
            return { status: 200, data: { status: 'updated', revision: 2, cursor: 2 } };
        });
        await client.approveReviewedEffect({ ...decision, expectedRevision: 1 });
        expect(post).toHaveBeenCalled();
    });

    it('does not turn mode mismatch, missing material, invalid payload, or storage failure into absent trust', async () => {
        const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
        const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: grant } } });
        const client = createProjectSetupTrustClient({ credentials: { token: 'requester', encryption: null }, serverHttpBaseUrl: baseUrl });
        await expect(client.read(project)).rejects.toMatchObject({ code: 'project_trust_encryption_material_unavailable' });
        expect(post).not.toHaveBeenCalled();
        get.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        post.mockResolvedValue({ status: 503, data: { error: 'project_trust_storage_unavailable' } });
        await expect(client.read(project)).rejects.toMatchObject({ code: 'project_trust_storage_unavailable' });
        post.mockResolvedValue({ status: 200, data: { status: 'present', revision: 1, content: { t: 'encrypted', c: 'bad' } } });
        await expect(client.read(project)).rejects.toMatchObject({ code: 'project_trust_content_mode_mismatch' });
        post.mockResolvedValue({ status: 200, data: { status: 'present', revision: 1, content: { t: 'plain', v: { project } } } });
        await expect(client.read(project)).rejects.toMatchObject({ code: 'project_trust_storage_unavailable' });
        post.mockRejectedValue(Object.assign(new Error('HTTP transport failed'), { config: { headers: { Authorization: 'Bearer requester' } } }));
        await expect(client.read(project)).rejects.toMatchObject({ code: 'project_trust_storage_unavailable' });
        await expect(client.read(project)).rejects.not.toHaveProperty('config');
        get.mockRejectedValue(Object.assign(new Error('Mode transport failed'), { config: { headers: { Authorization: 'Bearer requester' } } }));
        await expect(client.read(project)).rejects.toMatchObject({ code: 'project_trust_storage_unavailable' });
        await expect(client.read(project)).rejects.not.toHaveProperty('config');
    });
});
