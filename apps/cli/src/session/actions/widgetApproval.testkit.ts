import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod/mini';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, ArtifactJsonCreateHttpInputV1Schema, FeaturesResponseSchema, decodePlainArtifactStoredContent, isPlainArtifactDataKeyMarker, type AccountSettings } from '@happier-dev/protocol';
import { deriveArtifactKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { PluginProjectionV2Schema, type PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { normalizePluginUiInlineSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';
import { artifactKindListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import type { ArtifactCallerAccessV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { decodeExternalActionHttpBodyV1, EXTERNAL_ACTION_HTTP_BODY_HEADER_V1,
    EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1, EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

export type CounterWidgetFixture = Readonly<{
    pluginId: string;
    inputType: Readonly<{ pluginId: string; localId: string }>;
    projection: PluginProjectionV2;
    registry: ResolvedContributionRegistry;
    readUiResource: NonNullable<ResolvedExecutablePluginRuntimeRegistry['readUiResource']>;
    definition: Readonly<{ kind: 'installed'; surface: Readonly<{ pluginId: string; localId: string }> }>;
}>;

/** One installed App-target widget with a contributed input type, as the daemon projects it. */
export function createCounterWidgetFixture(): CounterWidgetFixture {
    const pluginId = 'example.widgets';
    const inputType = { pluginId, localId: 'count-kind' };
    const occurrenceId = createPluginRuntimeOccurrenceId(pluginId);
    const type = { id: inputType.localId, title: 'Count', semantic: 'count-kind',
        valueSchema: { type: 'string' as const, enum: ['files', 'folders'] }, options: { resource: 'count-kinds' } };
    const binding = normalizePluginUiInlineSurfaceBindingV1({ pluginId, surfaceId: 'counter', rendererId: 'counter', role: 'widget', target: { kind: 'app' } });
    if (!binding) throw new Error('Expected widget binding');
    const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
        pluginUi: { family: 'pluginUi', entriesById: { counter: { id: 'counter', pluginId, contributionKind: 'surfacePlacement',
            descriptorId: 'counter', occurrenceId, binding, target: binding.target, display: { title: 'Directory count' },
            sizeDeclaration: { sizes: ['medium'], defaultSize: 'medium' },
            inputs: { fields: [{ path: 'filter', title: 'Count', widget: 'select', required: true, inputType }] },
            inputSchema: { type: 'object', properties: { filter: type.valueSchema }, required: ['filter'], additionalProperties: false },
        } } }, inputTypes: { family: 'inputTypes', entriesById: { [`${pluginId}/count-kind`]: {
            id: `${pluginId}/count-kind`, pluginId, pluginVersion: '1.0.0', occurrenceId, definition: type,
        } } },
    } });
    const registry = createResolvedContributionRegistry({ occurrenceIdsByPluginId: { [pluginId]: occurrenceId },
        inputTypes: [{ provenance: 'external', source: { kind: 'path' }, pluginId, identity: inputType,
            manifestPath: '/plugins/widgets/plugin.json', definition: type }],
        resources: [{ provenance: 'external', source: { kind: 'path' }, pluginId,
            definition: { kindVersion: 1, id: 'count-kinds', source: 'dynamic', type: 'config', scope: 'global', contentType: 'application/json' } }],
    });
    const readUiResource = async () => ({ resource: { pluginId, localId: 'count-kinds' }, kind: 'config' as const,
        contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`,
        bytes: new TextEncoder().encode(JSON.stringify([{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders' }])) });
    return { pluginId, inputType, projection, registry, readUiResource,
        definition: { kind: 'installed' as const, surface: { pluginId, localId: 'counter' } } };
}

/** Model the Home's HTTP proof framing at the substituted transport boundary. */
function registerActionHttpBodyBoundary(app: FastifyInstance) {
    app.addConstraintStrategy({
        name: 'externalActionRead', mustMatchWhenDerived: true,
        storage() {
            type Storage = ReturnType<Parameters<typeof app.addConstraintStrategy>[0]['storage']>;
            const handlers = new Map<unknown, Parameters<Storage['set']>[1]>();
            return { get: value => handlers.get(value) ?? null, set: (value, handler) => { handlers.set(value, handler); } };
        },
        deriveConstraint: request => request.method === 'POST'
            && request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1] === EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1 ? 'v1' : undefined,
    });
    app.addHook('onRoute', function (route) {
        if (!(Array.isArray(route.method) ? route.method : [route.method]).includes('GET')) return;
        this.route({ ...route, method: 'POST', url: route.url.slice(this.prefix.length) || '/',
            constraints: { ...route.constraints, externalActionRead: 'v1' } });
    });
    app.addHook('preValidation', async (request, reply) => {
        const marker = request.headers[EXTERNAL_ACTION_HTTP_BODY_HEADER_V1];
        if (marker === undefined) return;
        const isRead = marker === EXTERNAL_ACTION_HTTP_READ_BODY_MARKER_V1;
        const decoded = decodeExternalActionHttpBodyV1(request.body);
        if ((marker !== 'v1' && !isRead) || (isRead && request.method !== 'POST')
            || EXTERNAL_ACTION_HTTP_PROOF_HEADERS_V1.some(header => request.headers[header] !== undefined)
            || decoded === null || (isRead && decoded.body !== undefined)) {
            return reply.code(400).send({ error: 'invalid_request' });
        }
        if (isRead) request.raw.method = 'GET';
        Object.assign(request.headers, decoded.headers);
        request.body = decoded.body;
    });
}

/** The Home features and Account facts every CLI Action composition reads before an Artifact write. */
export function registerAccountHomeHttp(app: FastifyInstance, input: Readonly<{ accountId: string; serverId: string;
    settings?: Pick<AccountSettings, 'actionsSettingsV1'>; encryptionMode?: 'plain' | 'e2ee' }>) {
    registerActionHttpBodyBoundary(app);
    const mode = input.encryptionMode ?? 'plain';
    app.get('/v1/account/encryption', async () => ({ mode, updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode, version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/profile', async () => ({ id: input.accountId }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: input.settings ?? {} }, version: 1 }));
    return FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: input.serverId } } });
}

type ArtifactRow<Mode extends 'plain' | 'e2ee'> = {
    id: string; ownerAccountId: string; access: ArtifactCallerAccessV1; encryptionMode: Mode; publicAudience: 'none';
    header: string; body: string; dataEncryptionKey: string;
    provenance?: string; provenanceDataEncryptionKey?: string;
    headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number;
};

/** The Account Artifact HTTP surface; content remains opaque on the encrypted branch. */
export function registerAccountArtifactRoutes<const Mode extends 'plain' | 'e2ee'>(app: FastifyInstance, accountId: string,
    { encryptionMode }: Readonly<{ encryptionMode: Mode }>) {
    const rows = new Map<string, ArtifactRow<Mode>>();
    const seed = (id: string, header: string, body: string, dataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER,
        ownership: Readonly<{ ownerAccountId: string; access: ArtifactCallerAccessV1 }> = { ownerAccountId: accountId, access: 'owner' }) => {
        if (isPlainArtifactDataKeyMarker(dataEncryptionKey) !== (encryptionMode === 'plain')) throw new Error('artifact_mode_mismatch');
        rows.set(id, { id, ...ownership, encryptionMode, publicAudience: 'none', header, body,
            dataEncryptionKey, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    };
    const idOf = (params: unknown) => String((params as { id: string }).id);
    app.get('/v1/artifacts', async (request, reply) => {
        const query = new URL(request.url, 'http://fixture.test').searchParams;
        const kind = query.get('kind');
        const exactKinds = query.get('kinds');
        const indexedKinds = query.get('indexedKinds');
        const unclassified = query.get('unclassified');
        if ([kind, exactKinds, indexedKinds, unclassified].filter(value => value !== null).length > 1) {
            return reply.code(400).send({ error: 'Failed to get artifacts' });
        }
        let selectedKinds: string[] | undefined;
        if (exactKinds !== null || indexedKinds !== null) {
            try {
                selectedKinds = z.array(z.string().check(z.minLength(1))).parse(JSON.parse((exactKinds ?? indexedKinds)!));
            } catch {
                return reply.code(400).send({ error: 'Failed to get artifacts' });
            }
        }
        const items = [...rows.values()];
        if (kind === null && selectedKinds === undefined && unclassified === null) return items;
        if (encryptionMode === 'e2ee') return {
            items: unclassified !== null ? items : [], hasUnclassified: items.length > 0,
            coverage: items.length > 0 ? { status: 'partial', unclassifiedCount: items.length, reason: 'unclassified_legacy_rows' }
                : { status: 'complete', unclassifiedCount: 0 },
        };
        return artifactKindListResponse(unclassified !== null ? [] : items.filter(row => {
            const classification = deriveArtifactKindV1(z.looseObject({}).parse(decodePlainArtifactStoredContent(row.header)));
            return kind !== null ? classification.kind === kind
                : classification.kindHint !== null && selectedKinds?.includes(classification.kindHint) === true;
        }));
    });
    app.post('/v1/artifacts/read', async request => artifactReadResponse(request.body, id => rows.get(id) ?? null).data);
    app.get('/v1/artifacts/:id', async (request, reply) => rows.get(idOf(request.params)) ?? reply.code(404).send({ error: 'not_found' }));
    app.get('/v1/artifacts/:id/access/recipients', async (request, reply) => {
        const row = rows.get(idOf(request.params));
        return row ? { artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, encryptionMode,
            dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
            provenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null,
            callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null, recipients: [] } : reply.code(404).send({ error: 'not_found' });
    });
    app.get('/v1/artifacts/:id/access/grants', async (request, reply) => {
        const row = rows.get(idOf(request.params));
        return row ? { artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, grants: [] } : reply.code(404).send({ error: 'not_found' });
    });
    app.post('/v1/artifacts', async (request, reply) => {
        const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid-params' });
        const create = parsed.data;
        const incumbent = rows.get(create.id);
        if (incumbent) return incumbent;
        seed(create.id, create.header, create.body, create.dataEncryptionKey);
        const row = rows.get(create.id)!;
        if (create.provenance != null) row.provenance = create.provenance;
        if (create.provenanceDataEncryptionKey != null) row.provenanceDataEncryptionKey = create.provenanceDataEncryptionKey;
        return row;
    });
    app.post('/v1/artifacts/:id', async request => {
        const row = rows.get(idOf(request.params));
        if (!row) throw new Error('artifact_missing');
        const update = z.looseObject({ header: z.string(), body: z.string(), expectedHeaderVersion: z.number(), expectedBodyVersion: z.number(),
            provenance: z.optional(z.string()), provenanceDataEncryptionKey: z.optional(z.string()) }).parse(request.body);
        if (update.expectedHeaderVersion !== row.headerVersion || update.expectedBodyVersion !== row.bodyVersion) return { success: false, error: 'version-mismatch' };
        const next = { ...row, header: update.header, body: update.body, headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1,
            ...(update.provenance === undefined ? {} : { provenance: update.provenance }),
            ...(update.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: update.provenanceDataEncryptionKey }) };
        rows.set(row.id, next);
        return { success: true, headerVersion: next.headerVersion, bodyVersion: next.bodyVersion };
    });
    return { seed, read: (id: string) => rows.get(id) };
}

/** Existing keyless callers retain their original storage boundary and defaults. */
export function registerPlainArtifactRoutes(app: FastifyInstance, accountId: string) {
    return registerAccountArtifactRoutes(app, accountId, { encryptionMode: 'plain' });
}

/** Preserve the published list envelope when an HTTP-boundary fixture has no Artifacts. */
export async function readEmptyPlainArtifactListFixture(url: string, accountId: string) {
    const app = Fastify();
    registerPlainArtifactRoutes(app, accountId);
    try {
        const requestUrl = new URL(url);
        const response = await app.inject({ method: 'GET', url: requestUrl.pathname + requestUrl.search });
        return { status: response.statusCode, data: response.json() };
    } finally { await app.close(); }
}
