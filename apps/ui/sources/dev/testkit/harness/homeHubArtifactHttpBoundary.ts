import { ARTIFACT_PLAIN_DATA_KEY_MARKER, AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { buildHomeHubArtifactIdV1, HOME_HUB_ARTIFACT_KIND_V1, HOME_HUB_DEFAULT_LAYOUT, HomeHubLayoutV1Schema } from '@happier-dev/protocol/home';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

/** HTTP persistence boundary: the real Account mode, Artifact codec, Action and Home owners run above it. */
export function createHomeHubArtifactHttpBoundary(accountId: string) {
    return createLayoutArtifactHttpBoundary(accountId, { artifactId: buildHomeHubArtifactIdV1(accountId), kind: HOME_HUB_ARTIFACT_KIND_V1,
        defaultLayout: HOME_HUB_DEFAULT_LAYOUT, parseLayout: value => HomeHubLayoutV1Schema.parse(value) });
}

/** The same HTTP/codec/CAS boundary serves personal Home and declared-area layouts. */
export function createLayoutArtifactHttpBoundary<T>(accountId: string, definition: Readonly<{
    artifactId: string; kind: string; defaultLayout: T; parseLayout(value: unknown): T;
}>) {
    const { artifactId } = definition;
    let artifact: Artifact | null = null;
    const writes: T[] = [];
    const layout = () => {
        if (!artifact?.body) return definition.defaultLayout;
        const opened: unknown = decodePlainArtifactStoredContent(artifact.body);
        if (!opened || typeof opened !== 'object' || typeof Reflect.get(opened, 'body') !== 'string') throw new Error('Expected text Home Artifact body');
        return definition.parseLayout(JSON.parse(String(Reflect.get(opened, 'body'))));
    };
    const seed = (value: T) => {
        artifact = {
            id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain',
            header: encodePlainArtifactStoredContent({ kind: definition.kind, v: 1, title: 'Personal layout' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(definition.parseLayout(value)) }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1,
        };
    };
    const request = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const path = new URL(String(input)).pathname;
        if (path === '/health' || path === '/v1/auth/ping') return Response.json({});
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        if (path === AUTHORING_MEMORY_ROUTE_V1 && (!init?.method || init.method === 'GET')) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
        if (path === '/v1/artifacts' && init?.method !== 'POST') return Response.json(artifact ? [artifact] : []);
        if (path !== '/v1/artifacts' && path !== `/v1/artifacts/${artifactId}`) return Response.json({ error: 'not_found' }, { status: 404 });
        if (init?.method !== 'POST') return artifact ? Response.json(artifact) : Response.json({ error: 'not_found' }, { status: 404 });
        const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'header') !== 'string' || typeof Reflect.get(body, 'body') !== 'string') throw new Error('Expected encoded Artifact write');
        const header = String(Reflect.get(body, 'header'));
        const encodedBody = String(Reflect.get(body, 'body'));
        if (path === '/v1/artifacts') {
            if (artifact) return Response.json({ error: 'conflict' }, { status: 409 });
            if (Reflect.get(body, 'id') !== artifactId || Reflect.get(body, 'dataEncryptionKey') !== ARTIFACT_PLAIN_DATA_KEY_MARKER) throw new Error('Unexpected Home Artifact identity or mode');
            artifact = { id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', header, body: encodedBody,
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            writes.push(layout());
            return Response.json(artifact);
        }
        if (!artifact) return Response.json({ error: 'not_found' }, { status: 404 });
        if (Reflect.get(body, 'expectedHeaderVersion') !== artifact.headerVersion || Reflect.get(body, 'expectedBodyVersion') !== artifact.bodyVersion) return Response.json({ success: false, error: 'version-mismatch', currentHeaderVersion: artifact.headerVersion, currentBodyVersion: artifact.bodyVersion });
        artifact = { ...artifact, header, body: encodedBody, headerVersion: artifact.headerVersion + 1, bodyVersion: (artifact.bodyVersion ?? 0) + 1, updatedAt: artifact.updatedAt + 1 };
        writes.push(layout());
        return Response.json({ success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion });
    };
    return { artifactId, request, seed, layout, writes };
}
