import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createArtifact, fetchArtifactListPage, restoreArtifactRevision, updateArtifact } from './apiArtifacts';
import { decodeArtifactUploadMetadataV1 } from '@happier-dev/transfers';

// This HTTP boundary consumes browser Blob bodies, not native file-URI bodies.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

const row = { id: 'skill', ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
    header: 'header', headerVersion: 2, body: 'body', bodyVersion: 3,
    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: 0, createdAt: 1, updatedAt: 1 } as const;

describe('Artifact coarse-kind transport', () => {
    it('preserves the typed Team classification refusal and generic server retryability', async () => {
        const options = { sharedWithTeamId: 'team-selected', teamResourceKind: 'projectDocuments' as const, retry: 'none' as const };
        await expect(fetchArtifactListPage({ token: 'team-classification-unavailable' }, { ...options,
            request: async () => Response.json({ error: 'artifact_content_unavailable' }, { status: 503 }),
        })).rejects.toMatchObject({ code: 'artifact_content_unavailable', status: 503, canTryAgain: true });
        await expect(fetchArtifactListPage({ token: 'team-classification-generic-error' }, { ...options,
            request: async () => Response.json({ error: 'upstream_unavailable' }, { status: 503 }),
        })).rejects.toMatchObject({ code: undefined, status: 503, canTryAgain: true, message: 'Failed to fetch artifacts: 503' });
    });
    it('retains safe locked Team rows without requiring ciphertext or a recipient key', async () => {
        const paths: string[] = [];
        const locked = { id: 'locked-team-artifact', ownerAccountId: 'author', access: 'view', encryptionMode: 'e2ee',
            kind: 'other', kindHint: null, headerVersion: 2, bodyVersion: 3, seq: 4, createdAt: 1, updatedAt: 2,
            publicAudience: 'retained', sharedTeamIds: ['team-selected'], sharedWithTeamScope: 'group',
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } };
        const page = await fetchArtifactListPage({ token: 'locked-team-page' }, {
            sharedWithTeamId: 'team-selected', teamResourceKind: 'otherArtifacts', limit: 1, cursor: 'frontier', retry: 'none',
            request: async path => { paths.push(path); return Response.json({ items: [locked], hasUnclassified: false,
                coverage: { status: 'complete', unclassifiedCount: 0 } }); },
        });
        expect(page.items).toEqual([locked]);
        const query = new URL(paths[0]!, 'https://home.invalid').searchParams;
        expect(query.get('sharedWithTeamId')).toBe('team-selected');
        expect(query.get('teamResourceKind')).toBe('otherArtifacts');
        expect(query.get('cursor')).toBe('frontier');
        expect(query.has('includeBody')).toBe(false);
    });
    it('preserves received membership and structural continuation through the existing header transport', async () => {
        const paths: string[] = [];
        const selection = { audience: 'received' as const, kinds: ['bot_template.v1'], limit: 1, cursor: 'frontier' };
        await fetchArtifactListPage({ token: 'received-header-page' }, { ...selection, retry: 'none',
            request: async path => { paths.push(path); return Response.json({ items: [], hasUnclassified: false,
                coverage: { status: 'complete', unclassifiedCount: 0 } }); } });
        const query = new URL(paths[0]!, 'https://home.invalid').searchParams;
        expect(query.get('audience')).toBe('received');
        expect(query.get('kinds')).toBe('["bot_template.v1"]');
        expect(query.get('cursor')).toBe('frontier');
        expect(query.has('includeBody')).toBe(false);
    });
    it('requires the typed witness for browser selection instead of accepting an unfiltered array', async () => {
        const selection = { browserListed: true as const };
        await expect(fetchArtifactListPage({ token: 'browser-witness' }, { ...selection, retry: 'none',
            request: async () => Response.json([]) })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    });
    it('carries browser selection and its typed witness through the existing list transport', async () => {
        const paths: string[] = [];
        const selection = { browserListed: true as const };
        const page = await fetchArtifactListPage({ token: 'browser-selection' }, { ...selection, retry: 'none',
            request: async path => { paths.push(path); return Response.json({ items: [{ ...row, kind: 'other', kindHint: null }],
                hasUnclassified: false, coverage: { status: 'complete', unclassifiedCount: 0 } }); } });
        expect(paths).toEqual(['/v1/artifacts?browserListed=true']);
        expect(page).toMatchObject({ items: [{ kindHint: null }], kindCoverage: { status: 'complete', unclassifiedCount: 0 } });
    });
    it.each([false, true])('rejects exact-kind HTTP without typed coverage with hasUnclassified=%s', async hasUnclassified => {
        let requests = 0;
        await expect(fetchArtifactListPage({ token: 't' }, { kinds: ['prompt_doc.v2'],
            request: async () => { requests++; return Response.json({ items: [], hasUnclassified }); } }))
            .rejects.toMatchObject({ code: 'artifact_content_unavailable', retryable: false });
        expect(requests).toBe(1);
    });
    it('selects exact kind sets and owner repair headers without losing the classification witness', async () => {
        const paths: string[] = [];
        const request = async (path: string) => {
            paths.push(path);
            return Response.json({ items: [{ ...row, kind: 'other', kindHint: null }], hasUnclassified: false,
                coverage: { status: 'complete', unclassifiedCount: 0 } });
        };
        const selected = await fetchArtifactListPage({ token: 't' }, { request, retry: 'none', kinds: ['role.v1', 'account_notice.v1'] });
        await fetchArtifactListPage({ token: 't' }, { request, retry: 'none', unclassified: true, limit: 500 });
        await fetchArtifactListPage({ token: 't' }, { request, retry: 'none', unclassified: 'coarse', limit: 500 });
        expect(new URL(paths[0]!, 'http://localhost').searchParams.get('kinds')).toBe('["role.v1","account_notice.v1"]');
        expect(paths[1]).toBe('/v1/artifacts?limit=500&unclassified=true');
        expect(paths[2]).toBe('/v1/artifacts?limit=500&unclassified=coarse');
        expect(selected).toMatchObject({ items: [{ kindHint: null }], hasUnclassified: false });
    });
    it.each(['widget_area_layout', 'widget_definition', 'widget_layout_fragment'] as const)('reads only %s headers through the existing filtered endpoint', async coarseKind => {
        const paths: string[] = [];
        const page = await fetchArtifactListPage({ token: 't' }, { coarseKind, limit: 500, retry: 'none',
            request: async path => { paths.push(path); return Response.json({ items: [{ ...row, kind: coarseKind }], hasUnclassified: true }); } });
        expect(paths).toEqual([`/v1/artifacts?limit=500&kind=${coarseKind}`]);
        expect(page).toMatchObject({ items: [{ kind: coarseKind }], hasUnclassified: true });
    });
    it('sends coarse kind for queries, writes and binary uploads', async () => {
        const paths: string[] = [];
        const writes: Record<string, unknown>[] = [];
        const uploads: unknown[] = [];
        const request = async (path: string, init?: RequestInit) => {
            paths.push(path);
            if ((init?.method ?? 'GET') === 'GET') return Response.json({ items: [{ ...row, kind: 'skill' }], hasUnclassified: true });
            if (path === '/v1/artifacts/content/upload') {
                const wire = new Uint8Array(await new Response(init?.body).arrayBuffer());
                uploads.push(decodeArtifactUploadMetadataV1(wire.subarray(0, wire.indexOf(10))));
                return Response.json(uploads.length === 1 ? row : { success: true });
            }
            writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return Response.json(path === '/v1/artifacts' ? row : { success: true, headerVersion: 3, bodyVersion: 4 });
        };
        const options = { request, retry: 'none' as const, serverId: 'kind-api-home' };
        const page = await fetchArtifactListPage({ token: 't' }, { ...options, coarseKind: 'skill', limit: 500 });
        expect(paths[0]).toBe('/v1/artifacts?limit=500&kind=skill');
        expect(page.hasUnclassified).toBe(true);
        await createArtifact({ token: 't' }, { id: 'skill', kind: 'skill', header: 'header', body: 'body',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER }, options);
        await updateArtifact({ token: 't' }, 'skill', { kind: 'skill', header: 'header', expectedHeaderVersion: 2 }, options);
        await restoreArtifactRevision({ token: 't' }, { artifactId: 'skill', kind: 'prompt', header: 'restored-header',
            bodyVersion: 1, expectedRevision: { headerVersion: 2, bodyVersion: 3 } }, options);
        expect(writes.map(write => write.kind)).toEqual(['skill', 'skill', 'prompt']);
        const blob = { blobId: '00000000-0000-4000-8000-000000000002', content: { t: 'plain' as const, v: 'AA==' } };
        await createArtifact({ token: 't' }, { id: '00000000-0000-4000-8000-000000000001', kind: 'plugin_ui',
            header: 'header', body: 'body', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, blob }, options);
        await updateArtifact({ token: 't' }, '00000000-0000-4000-8000-000000000001', { kind: 'plugin_ui',
            header: 'header', expectedHeaderVersion: 2, body: 'body', expectedBodyVersion: 3, blob }, options);
        expect(uploads.map(input => input && typeof input === 'object' ? Reflect.get(input, 'artifactKind') : undefined))
            .toEqual(['plugin_ui', 'plugin_ui']);
    });

    it('refuses filtered responses without completeness metadata', async () => {
        await expect(fetchArtifactListPage({ token: 't' }, { serverId: 'kind-api-home', coarseKind: 'skill', retry: 'none',
            request: async () => Response.json({ items: [row] }) })).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
    });

});
