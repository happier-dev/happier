import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProjectSourceActionDeps } from './projectSourceActions';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { resetRuntimeFetch } from '@/utils/system/runtimeFetch';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

const scope = { serverId: 'home-a', accountId: 'account-a', credentialAuthorityKind: 'account' as const };
const artifact = (kind: string) => ({ artifactId: 'layout', header: { kind }, body: '',
    revision: { headerVersion: 1, bodyVersion: 1 }, ownerAccountId: scope.accountId, access: 'owner' as const,
    publicAudience: 'none' as const, shared: false });
const dashboard = { purpose: 'dashboard' as const, ref: { kind: 'doc' as const, artifactId: 'layout' } };
const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
    repository: { nameWithOwner: 'owner/repo', visibility: 'private' }, protocol: 'https' } satisfies ProjectSourceRepositorySelectorV1;
let fixture: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; resetRuntimeFetch(); vi.restoreAllMocks(); });

describe('authenticated Source Action transport', () => {
    it('refuses attachment kind mismatches before issuing a Source mutation', async () => {
        let mutated = false;
        const deps = createProjectSourceActionDeps({ ...scope, assertCurrent() {},
            workflowArtifacts: { read: async () => artifact('prompt_doc.v2') },
            request: async () => { mutated = true; return new Response('{}'); },
        });
        expect(await deps.projectSourcesUpdate({ serverId: scope.serverId, sourceId: 'source-a', expectedRevision: 1,
            patch: { attachment: { kind: 'attach', attachment: dashboard } } })).toEqual({ ok: false, error: 'artifact_wrong_kind' });
        expect(mutated).toBe(false);
    });

    it('detaches the exact dashboard reference without reading content or changing Artifact grants', async () => {
        let input: unknown;
        const deps = createProjectSourceActionDeps({ ...scope, assertCurrent() {},
            workflowArtifacts: { read: async () => { throw new Error('detach must not open a document'); } },
            request: async (_path, init) => {
                input = JSON.parse(String(init?.body));
                return new Response(JSON.stringify({ ok: false, error: 'source_conflict' }), { status: 409 });
            },
        });
        const result = await deps.projectSourcesUpdate({ serverId: scope.serverId, sourceId: 'source-a', expectedRevision: 1,
            patch: { attachment: { kind: 'detach', purpose: 'dashboard', ref: dashboard.ref } } });
        expect(result).toEqual({ ok: false, error: 'source_conflict' });
        expect(input).toEqual({ serverId: scope.serverId, sourceId: 'source-a', expectedRevision: 1,
            patch: { attachment: { kind: 'detach', purpose: 'dashboard', ref: dashboard.ref } } });
    });

    it('reads the current Artifact kind again for every attachment admission', async () => {
        let kind = 'widget-area-layout.v1';
        let revision = 1;
        const deps = createProjectSourceActionDeps({ ...scope, assertCurrent() {},
            workflowArtifacts: { read: async () => artifact(kind) },
            request: async () => new Response(JSON.stringify({ ok: true, canManage: true, source: {
                id: 'source-a', revision: ++revision, name: 'Repository', createdByAccountId: scope.accountId, audience: [],
                repository,
                attachments: [dashboard],
            } })),
        });
        const input = { serverId: scope.serverId, sourceId: 'source-a', expectedRevision: 1,
            patch: { attachment: { kind: 'attach' as const, attachment: dashboard } } };
        expect(await deps.projectSourcesUpdate(input)).toMatchObject({ ok: true });
        kind = 'prompt_doc.v2';
        expect(await deps.projectSourcesUpdate({ ...input, expectedRevision: 2 })).toEqual({ ok: false, error: 'artifact_wrong_kind' });
        expect(revision).toBe(2);
    });

    it('reports a refused legacy endpoint separately from an unreachable Home', async () => {
        const deps = createProjectSourceActionDeps({ ...scope, assertCurrent() {}, workflowArtifacts: { read: async () => null },
            request: async () => new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 }),
        });
        expect(await deps.projectSourcesList({ serverId: scope.serverId })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    });

    it('does not disclose an authenticated read after its captured Account port retires', async () => {
        let current = true;
        const deps = createProjectSourceActionDeps({ ...scope,
            assertCurrent() { if (!current) throw Object.assign(new Error('scope retired'), { code: 'action_account_scope_changed' }); },
            workflowArtifacts: { read: async () => null },
            request: async () => {
                current = false;
                return new Response(JSON.stringify({ ok: true, sources: [{
                    id: 'source-a', revision: 1, name: 'Private repository', createdByAccountId: scope.accountId, audience: [],
                    repository,
                }], coverage: { complete: true, nextCursor: null } }));
            },
        });
        const result = await deps.projectSourcesList({ serverId: scope.serverId });
        expect(result).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(result).not.toHaveProperty('sources');
    });

    it('preserves typed Home mismatch and retired attachment refusals before any Source effect', async () => {
        let current = true;
        let requests = 0;
        const deps = createProjectSourceActionDeps({ ...scope,
            assertCurrent() { if (!current) throw Object.assign(new Error('scope retired'), { code: 'action_account_scope_changed' }); },
            workflowArtifacts: { read: async () => { current = false; return artifact('widget-area-layout.v1'); } },
            request: async () => { requests += 1; return Response.json({}); },
        });
        expect(await deps.projectSourcesList({ serverId: 'other-home' })).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(await deps.projectSourcesUpdate({ serverId: scope.serverId, sourceId: 'source-a', expectedRevision: 1,
            patch: { attachment: { kind: 'attach', attachment: dashboard } } })).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(requests).toBe(0);
    });

    it('refuses API-token foreign-Home attachment authority before opening any transport', async () => {
        let opened = false;
        const deps = createProjectSourceActionDeps({ ...scope, credentialAuthorityKind: 'api_token', assertCurrent() {},
            workflowArtifacts: { read: async () => { opened = true; throw new Error('foreign admission must not open the local document'); } },
            request: async () => { opened = true; throw new Error('foreign admission must not mutate the Source'); },
        });
        expect(await deps.projectSourcesUpdate({ serverId: scope.serverId, sourceId: 'source-a', expectedRevision: 1,
            patch: { attachment: { kind: 'attach', attachment: { ...dashboard, ref: { ...dashboard.ref, serverId: 'home-b' } } } } }))
            .toEqual({ ok: false, error: 'artifact_unavailable' });
        expect(opened).toBe(false);
    });

    it('reads the qualified foreign Artifact through its real Home instead of substituting a same-id local Artifact', async () => {
        let grantReadAvailable = true;
        fixture = await createPlainArtifactHomeFixture('https://source-qualified-artifact.test', {
            // The real dashboard Artifact reader also opens its current audience.
            // This HTTP boundary must serve that existing route, not just content bytes.
            handleRequest: async path => {
                if (path === '/v1/artifacts/layout') {
                    const artifact = fixture?.boundary.read('layout');
                    return artifact ? Response.json({ ...artifact, publicAudience: 'none' }) : null;
                }
                if (path !== '/v1/artifacts/layout/access/grants') return null;
                const ownerAccountId = fixture?.boundary.read('layout')?.ownerAccountId;
                return grantReadAvailable && ownerAccountId
                    ? Response.json({ artifactId: 'layout', ownerAccountId, access: 'owner', grants: [] })
                    : Response.json({ error: 'artifact_access_unavailable' }, { status: 404 });
            },
        });
        await fixture.boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'layout', header: encodePlainArtifactStoredContent({ v: 1, kind: 'widget-area-layout.v1', title: 'Foreign layout' }),
            body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        }) });
        let localRead = false;
        let localKind = 'prompt_doc.v2';
        let written: unknown;
        const deps = createProjectSourceActionDeps({ ...scope, assertCurrent() {},
            workflowArtifacts: { read: async () => { localRead = true; return artifact(localKind); } },
            request: async (_path, init) => { written = JSON.parse(String(init?.body)); return Response.json({ ok: false, error: 'source_conflict' }, { status: 409 }); },
        });
        const input = { serverId: scope.serverId, sourceId: 'source-a', expectedRevision: 1,
            patch: { attachment: { kind: 'attach' as const, attachment: { ...dashboard, ref: { ...dashboard.ref, serverId: fixture.home.id } } } } };
        expect(await deps.projectSourcesUpdate(input)).toEqual({ ok: false, error: 'source_conflict' });
        expect(localRead).toBe(false);
        expect(written).toEqual(input);
        expect(fixture.requests.some(({ path }) => path === '/v1/artifacts/layout')).toBe(true);
        expect(fixture.requests.some(({ path }) => path === '/v1/artifacts/layout/access/grants')).toBe(true);
        const delegationContexts = [{ externalActionCredential: { accountId: scope.accountId,
            principalId: 'delegated-principal', credentialId: 'delegated', grant: API_TOKEN_FULL_GRANT_V1 } },
            { externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse({
                v: 1, token: 'signed-requester-authorization', binding: {
                    accountId: scope.accountId, principalId: scope.accountId, credentialId: 'public-token', grant: API_TOKEN_FULL_GRANT_V1,
                    serverIdentityId: 'source-home-identity', machineId: 'source-machine', custodianAccountId: scope.accountId,
                    installationId: 'source-installation', actionId: 'projects.sources.update', requestId: 'source-request',
                    requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'session', sessionId: 'source-session' },
                },
            }) }] satisfies ActionExecutorContext[];
        const foreignRequests = fixture.requests.length;
        for (const context of delegationContexts) {
            written = undefined;
            expect(await deps.projectSourcesUpdate(input, context)).toEqual({ ok: false, error: 'artifact_unavailable' });
            expect(written).toBeUndefined();
            expect(fixture.requests).toHaveLength(foreignRequests);
            expect(localRead).toBe(false);
        }
        // Neither carrier prevents admission through the already captured Source Home.
        localKind = 'widget-area-layout.v1';
        for (const context of delegationContexts) {
            written = undefined;
            expect(await deps.projectSourcesUpdate({ ...input,
                patch: { attachment: { kind: 'attach', attachment: dashboard } } }, context))
                .toEqual({ ok: false, error: 'source_conflict' });
            expect(written).toBeDefined();
        }
        expect(localRead).toBe(true);
        expect(fixture.requests).toHaveLength(foreignRequests);
        // An unavailable audience is still fail-closed, never a fabricated private grant.
        grantReadAvailable = false;
        written = undefined;
        expect(await deps.projectSourcesUpdate(input)).toEqual({ ok: false, error: 'artifact_unavailable' });
        expect(written).toBeUndefined();
    });

    it('reports an aborted read as cancellation even after the transport was issued', async () => {
        const abort = new AbortController();
        const deps = createProjectSourceActionDeps({ ...scope, assertCurrent() {}, workflowArtifacts: { read: async () => null },
            request: async (_path, _init, options) => { options?.onIssued?.(); abort.abort(); throw abort.signal.reason; },
        });
        expect(await deps.projectSourcesList({ serverId: scope.serverId }, { signal: abort.signal }))
            .toMatchObject({ ok: false, errorCode: 'cancelled' });
    });

    it('does not disclose a fulfilled Source read that resolves after cancellation', async () => {
        const abort = new AbortController();
        const deps = createProjectSourceActionDeps({ ...scope, assertCurrent() {}, workflowArtifacts: { read: async () => null },
            request: async (_path, _init, options) => {
                options?.onIssued?.();
                abort.abort();
                return new Response(JSON.stringify({ ok: true, sources: [{
                    id: 'source-a', revision: 1, name: 'Private repository', createdByAccountId: scope.accountId, audience: [], repository,
                }], coverage: { complete: true, nextCursor: null } }));
            },
        });
        const result = await deps.projectSourcesList({ serverId: scope.serverId }, { signal: abort.signal });
        expect(result).toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(result).not.toHaveProperty('sources');
    });
});
