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

/** The Home features and Account facts every CLI Action composition reads before an Artifact write. */
export function registerAccountHomeHttp(app: FastifyInstance, input: Readonly<{ accountId: string; serverId: string;
    settings?: Pick<AccountSettings, 'actionsSettingsV1'> }>) {
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v1/account/profile', async () => ({ id: input.accountId }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: input.settings ?? {} }, version: 1 }));
    return FeaturesResponseSchema.parse({ features: { sessions: { enabled: true, board: { enabled: true } } },
        capabilities: { serverIdentity: { serverIdentityId: input.serverId } } });
}

type ArtifactRow<Mode extends 'plain' | 'e2ee'> = {
    id: string; ownerAccountId: string; access: 'owner'; encryptionMode: Mode; publicAudience: 'none';
    header: string; body: string; dataEncryptionKey: string;
    headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number;
};

/** The Account Artifact HTTP surface; content remains opaque on the encrypted branch. */
export function registerAccountArtifactRoutes<const Mode extends 'plain' | 'e2ee'>(app: FastifyInstance, accountId: string,
    { encryptionMode }: Readonly<{ encryptionMode: Mode }>) {
    const rows = new Map<string, ArtifactRow<Mode>>();
    const seed = (id: string, header: string, body: string, dataEncryptionKey = ARTIFACT_PLAIN_DATA_KEY_MARKER) => {
        if (isPlainArtifactDataKeyMarker(dataEncryptionKey) !== (encryptionMode === 'plain')) throw new Error('artifact_mode_mismatch');
        rows.set(id, { id, ownerAccountId: accountId, access: 'owner', encryptionMode, publicAudience: 'none', header, body,
            dataEncryptionKey, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    };
    const idOf = (params: unknown) => String((params as { id: string }).id);
    app.get('/v1/artifacts', async (request, reply) => {
        const query = new URL(request.url, 'http://fixture.test').searchParams;
        const kind = query.get('kind');
        const exactKinds = query.get('kinds');
        const unclassified = query.get('unclassified');
        if ([kind, exactKinds, unclassified].filter(value => value !== null).length > 1) {
            return reply.code(400).send({ error: 'Failed to get artifacts' });
        }
        let selectedKinds: string[] | undefined;
        if (exactKinds !== null) {
            try {
                selectedKinds = z.array(z.string().check(z.minLength(1))).parse(JSON.parse(exactKinds));
            } catch {
                return reply.code(400).send({ error: 'Failed to get artifacts' });
            }
        }
        const items = [...rows.values()];
        if (kind === null && selectedKinds === undefined && unclassified === null) return items;
        return { items: unclassified !== null ? [] : items.filter(row => {
            const classification = deriveArtifactKindV1(z.looseObject({}).parse(decodePlainArtifactStoredContent(row.header)));
            return kind !== null ? classification.kind === kind
                : classification.kindHint !== null && selectedKinds?.includes(classification.kindHint) === true;
        }), hasUnclassified: false };
    });
    app.get('/v1/artifacts/:id', async (request, reply) => rows.get(idOf(request.params)) ?? reply.code(404).send({ error: 'not_found' }));
    app.get('/v1/artifacts/:id/access/recipients', async (request, reply) => {
        const row = rows.get(idOf(request.params));
        return row ? { artifactId: row.id, ownerAccountId: accountId, access: 'owner', encryptionMode,
            dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
            provenanceDataEncryptionKey: null, callerProvenanceDataEncryptionKey: null, recipients: [] } : reply.code(404).send({ error: 'not_found' });
    });
    app.get('/v1/artifacts/:id/access/grants', async (request, reply) => {
        const row = rows.get(idOf(request.params));
        return row ? { artifactId: row.id, ownerAccountId: accountId, access: 'owner', grants: [] } : reply.code(404).send({ error: 'not_found' });
    });
    app.post('/v1/artifacts', async (request, reply) => {
        const parsed = ArtifactJsonCreateHttpInputV1Schema.safeParse(request.body);
        if (!parsed.success) return reply.code(400).send({ error: 'invalid-params' });
        const create = parsed.data;
        const incumbent = rows.get(create.id);
        if (incumbent) return incumbent;
        seed(create.id, create.header, create.body, create.dataEncryptionKey);
        return rows.get(create.id);
    });
    app.post('/v1/artifacts/:id', async request => {
        const row = rows.get(idOf(request.params));
        if (!row) throw new Error('artifact_missing');
        const update = z.looseObject({ header: z.string(), body: z.string(), expectedHeaderVersion: z.number(), expectedBodyVersion: z.number() }).parse(request.body);
        if (update.expectedHeaderVersion !== row.headerVersion || update.expectedBodyVersion !== row.bodyVersion) return { success: false, error: 'version-mismatch' };
        const next = { ...row, header: update.header, body: update.body, headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 };
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
