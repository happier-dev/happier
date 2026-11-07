import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { type ArtifactCallerAccessV1, type ArtifactAccessGrantRowV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { deriveArtifactCoarseKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { buildHomeHubArtifactIdV1, HOME_HUB_ARTIFACT_KIND_V1, getHomeHubDefaultLayoutV1, HomeHubLayoutV1Schema, type HomeHubLayoutV1 } from '@happier-dev/protocol/home';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { FetchedMachineRow } from '@/sync/engine/machines/syncMachines';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse } from './artifactStoreBoundary';

/** HTTP persistence boundary: the real Account mode, Artifact codec, Action and Home owners run above it. */
export function createHomeHubArtifactHttpBoundary(
    accountId: string,
    profile: ReturnType<typeof AccountProfileSchema.parse> | (() => ReturnType<typeof AccountProfileSchema.parse>) = AccountProfileSchema.parse({ id: accountId }),
    options?: Readonly<{ machines?: readonly FetchedMachineRow[] }>,
): ReturnType<typeof createLayoutArtifactHttpBoundary<HomeHubLayoutV1>> {
    const boundary = createLayoutArtifactHttpBoundary(accountId, { artifactId: buildHomeHubArtifactIdV1(accountId), kind: HOME_HUB_ARTIFACT_KIND_V1,
        defaultLayout: getHomeHubDefaultLayoutV1(), parseLayout: value => HomeHubLayoutV1Schema.parse(value) });
    return { ...boundary, request: async (input: RequestInfo | URL, init?: RequestInit) => {
        // The signed-in Account establishes the Home lifetime. A shared layout's
        // owner is a different principal and must never supply this Profile.
        const path = new URL(String(input)).pathname;
        if (path === '/v1/machines' && options?.machines) return Response.json(options.machines);
        if (path === '/v1/account/profile') {
            const currentProfile = AccountProfileSchema.parse(typeof profile === 'function' ? profile() : profile);
            if (currentProfile.id !== accountId) throw new Error('Home HTTP profile must belong to the signed-in Account');
            return Response.json(currentProfile);
        }
        return boundary.request(input, init);
    } };
}

/** The same HTTP/codec/CAS boundary serves personal Home and declared-area layouts. */
export function createLayoutArtifactHttpBoundary<T>(accountId: string, definition: Readonly<{
    artifactId: string; kind: string; defaultLayout: T; parseLayout(value: unknown): T; buildHeader?(value: T): Readonly<Record<string, unknown>>;
}>) {
    const { artifactId } = definition;
    let artifact: Artifact | null = null;
    let callerAccess: ArtifactCallerAccessV1 | null = 'owner';
    let grants: readonly ArtifactAccessGrantRowV1[] = [];
    const writes: T[] = [];
    let accountSettings: { content: unknown; version: number } = { content: { t: 'plain', v: {} }, version: 1 };
    /** The Account's Project rows census the Home serves; widget input admission checks checkouts against it. */
    let workspaceRefs: readonly WorkspaceRefV1[] = [];
    const layout = () => {
        if (!artifact?.body) return definition.defaultLayout;
        const opened: unknown = decodePlainArtifactStoredContent(artifact.body);
        if (!opened || typeof opened !== 'object' || typeof Reflect.get(opened, 'body') !== 'string') throw new Error('Expected text Home Artifact body');
        return definition.parseLayout(JSON.parse(String(Reflect.get(opened, 'body'))));
    };
    /** The server stores the coarse kind hint with every row; without it, inventory sync would write a backfill. */
    const served = (row: Artifact): Artifact => {
        const header: unknown = decodePlainArtifactStoredContent(row.header);
        return { ...row, kind: header && typeof header === 'object' && !Array.isArray(header)
            ? deriveArtifactCoarseKindV1(header as Readonly<Record<string, unknown>>) : null };
    };
    const seed = (value: T) => {
        artifact = {
            id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none',
            header: encodePlainArtifactStoredContent(definition.buildHeader?.(value) ?? { kind: definition.kind, v: 1, title: 'Personal layout' }),
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
        if (path === '/v2/account/settings') {
            // Account settings are a versioned compare-and-set document: a setting Action's write is
            // acknowledged and read back, as the Home would.
            if (init?.method === 'POST') {
                const update = JSON.parse(String(init.body)) as { content: unknown; expectedVersion: number };
                if (update.expectedVersion !== accountSettings.version) {
                    return Response.json({ success: false, error: 'version-mismatch', currentVersion: accountSettings.version, currentContent: accountSettings.content });
                }
                accountSettings = { content: update.content, version: accountSettings.version + 1 };
                return Response.json({ success: true, version: accountSettings.version });
            }
            return Response.json(accountSettings);
        }
        if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(workspaceRefs.length === 0
            ? ProjectAccountRowListResponseV1Schema.parse({ status: 'listed', rows: [], coverage: 'complete' })
            : createPlainProjectAccountRowListFixture({ workspaceRefs }));
        if (path === AUTHORING_MEMORY_ROUTE_V1 && (!init?.method || init.method === 'GET')) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
        if (path === '/v1/artifacts/read' && init?.method === 'POST') {
            return createArtifactReadBatchHttpResponse(JSON.parse(String(init.body)), id => !artifact || id !== artifactId
                ? { artifactId: id, ok: false, error: 'artifact_not_found', status: 404, retryable: false }
                : callerAccess === null
                    ? { artifactId: id, ok: false, error: 'artifact_access_forbidden', status: 403, retryable: false }
                    : { artifactId: id, ok: true, artifact: { ...served(artifact), access: callerAccess }, recipientCensus: null });
        }
        if (path === '/v1/artifacts' && init?.method !== 'POST') {
            return createArtifactListHttpResponse(new URL(String(input)), artifact ? [served(artifact)] : []);
        }
        // The server's grants reader admits every current grantee; management is separate.
        if (path === `/v1/artifacts/${artifactId}/access/grants`) return artifact && callerAccess !== null
            ? Response.json({ artifactId, ownerAccountId: artifact.ownerAccountId, access: callerAccess, grants })
            : Response.json({ error: 'artifact_access_forbidden' }, { status: 403 });
        if (path !== '/v1/artifacts' && path !== `/v1/artifacts/${artifactId}`) return Response.json({ error: 'not_found' }, { status: 404 });
        if (callerAccess === null) return Response.json({ error: 'artifact_access_forbidden' }, { status: 403 });
        if (init?.method !== 'POST') return artifact ? Response.json({ ...served(artifact), access: callerAccess }) : Response.json({ error: 'not_found' }, { status: 404 });
        if (callerAccess === 'view') return Response.json({ error: 'artifact_access_forbidden' }, { status: 403 });
        const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        if (!body || typeof body !== 'object' || typeof Reflect.get(body, 'header') !== 'string' || typeof Reflect.get(body, 'body') !== 'string') throw new Error('Expected encoded Artifact write');
        const header = String(Reflect.get(body, 'header'));
        const encodedBody = String(Reflect.get(body, 'body'));
        if (path === '/v1/artifacts') {
            if (artifact) return Response.json({ error: 'conflict' }, { status: 409 });
            if (Reflect.get(body, 'id') !== artifactId || Reflect.get(body, 'dataEncryptionKey') !== ARTIFACT_PLAIN_DATA_KEY_MARKER) throw new Error('Unexpected Home Artifact identity or mode');
            artifact = { id: artifactId, ownerAccountId: accountId, access: 'owner', encryptionMode: 'plain', publicAudience: 'none', header, body: encodedBody,
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
    return { artifactId, request, seed, layout, writes,
        setWorkspaceRefs: (next: readonly WorkspaceRefV1[]) => { workspaceRefs = next; },
        setCallerAccess: (access: ArtifactCallerAccessV1 | null) => { callerAccess = access; },
        setGrants: (next: readonly ArtifactAccessGrantRowV1[]) => { grants = next; },
    };
}
