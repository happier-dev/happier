import axios from 'axios';
import { x25519 } from '@noble/curves/ed25519';
import { z } from 'zod/mini';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent,
    WorkBoardV1Schema, buildHomeHubArtifactIdV1, buildWorkBoardItemKeyV1, createActionExecutor, createWorkBoardV1 } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { buildWidgetSurfaceArtifactIdV1 } from '@happier-dev/protocol/widgets';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { createCliActionDeps } from './createCliActionDeps';
import { createCliActionExecutor } from './createCliActionExecutor';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createPluginRuntimeOccurrenceId } from '@/plugins/runtime/runtimeSlots';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });

// A Home that indexes kinds advertises it on its features route, so CLI writes carry their stored kind.
const advertiseKindIndexing = () => vi.stubGlobal('fetch', async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({
        features: { artifacts: { queryHints: { enabled: true } } }, capabilities: {} });
    throw new Error(`unexpected_fetch:${path}`);
});
const coarseKindOf = (storedKind: string | undefined) => storedKind?.split(':')[1];

describe('CLI Board Actions through the Artifact owner', () => {
    it.each([['plain', false], ['plain', true], ['e2ee', false], ['e2ee', true]] as const)(
        'round-trips Board create/list/edit/delete through the existing %s Artifact codec (Home read unavailable: %s)', async (mode, initiallyUnavailable) => {
        advertiseKindIndexing();
        const secret = new Uint8Array(32).fill(7);
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: mode === 'plain' ? null
            : { type: 'dataKey' as const, machineKey: secret, publicKey: x25519.getPublicKey(secret) } };
        const privateRevisionMetadata = {
            provenance: z.optional(z.nullable(z.string())),
            provenanceDataEncryptionKey: z.optional(z.nullable(z.string())),
            kind: z.optional(z.string()),
        };
        const createSchema = z.strictObject({ id: z.string(), header: z.string(), body: z.string(), dataEncryptionKey: z.string(),
            ...privateRevisionMetadata });
        const updateSchema = z.strictObject({ header: z.string(), body: z.string(), expectedHeaderVersion: z.number(), expectedBodyVersion: z.number(),
            ...privateRevisionMetadata });
        const rows = new Map<string, z.infer<typeof createSchema> & { headerVersion: number; bodyVersion: number; seq: number; createdAt: number; updatedAt: number;
            ownerAccountId: string; access: 'owner'; encryptionMode: 'plain' | 'e2ee' }>();
        const homeArtifactId = buildHomeHubArtifactIdV1('owner');
        const area = { serverId: 'board-home', accountId: 'owner',
            owner: { kind: 'pluginArea', pluginId: 'com.acme.test', pageId: 'dashboard', area: 'main' } } as const;
        const areaArtifactId = buildWidgetSurfaceArtifactIdV1(area);
        let withholdCreatedHome = initiallyUnavailable;
        let withholdCreatedAreaOnce = initiallyUnavailable;
        let homeCreates = 0;
        let areaCreates = 0;
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            expect(new URL(url).origin).toBe('https://board-home.test');
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 1 } };
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: null, version: 0 } };
            if (path === '/v1/artifacts') {
                const kind = new URL(url).searchParams.get('kind');
                // The Artifact server selects by its stored coarse kind; every row here is classified.
                return { status: 200, data: artifactListResponse(url, kind ? [...rows.values()].filter(row => coarseKindOf(row.kind) === kind) : [...rows.values()]) };
            }
            const artifactId = decodeURIComponent(path.split('/')[3] ?? '');
            const row = rows.get(artifactId);
            // A create receipt is not readable content. Only the exact Home read is temporarily unavailable.
            if (withholdCreatedHome && row && path === `/v1/artifacts/${homeArtifactId}`) return { status: 404 };
            if (withholdCreatedAreaOnce && row && path === `/v1/artifacts/${areaArtifactId}`) {
                withholdCreatedAreaOnce = false;
                return { status: 404 };
            }
            if (path.endsWith('/access/recipients') && row) return { status: 200, data: {
                artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, encryptionMode: mode,
                dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
                provenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null,
                callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey ?? null, recipients: [],
            } };
            if (path.endsWith('/access/grants') && row) return { status: 200, data: {
                artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, grants: [],
            } };
            return row ? { status: 200, data: { ...row, publicAudience: 'none' } } : { status: 404 };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, input) => {
            if (new URL(url).pathname === '/v1/artifacts') {
                const parsed = createSchema.parse(input);
                if (parsed.id === homeArtifactId) homeCreates++;
                if (parsed.id === areaArtifactId) areaCreates++;
                const incumbent = rows.get(parsed.id);
                if (incumbent) return { status: 200, data: incumbent };
                const row = { ...parsed, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
                    ownerAccountId: 'owner', access: 'owner' as const, encryptionMode: mode };
                rows.set(row.id, row); return { status: 200, data: row };
            }
            const artifactId = decodeURIComponent(new URL(url).pathname.split('/')[3] ?? '');
            const row = rows.get(artifactId)!;
            const next = updateSchema.parse(input);
            expect(next.expectedHeaderVersion).toBe(row.headerVersion); expect(next.expectedBodyVersion).toBe(row.bodyVersion);
            const updated = { ...row, header: next.header, body: next.body,
                ...(next.provenance === undefined ? {} : { provenance: next.provenance }),
                ...(next.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: next.provenanceDataEncryptionKey }),
                headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 };
            rows.set(row.id, updated);
            return { status: 200, data: { success: true, headerVersion: updated.headerVersion, bodyVersion: updated.bodyVersion } };
        });
        vi.spyOn(axios, 'delete').mockImplementation(async url => {
            const artifactId = decodeURIComponent(new URL(url).pathname.split('/')[3]!);
            const row = rows.get(artifactId)!;
            expect(new URL(url).pathname).toBe(`/v1/artifacts/${artifactId}/revision/${row.headerVersion}/${row.bodyVersion}`);
            rows.delete(artifactId); return { status: 200, data: { success: true } };
        });
        // Session storage mode is independent of the Account's Artifact mode; no Session key is fabricated.
        const inputType = { pluginId: 'external.directory-widgets', localId: 'count-kind' };
        const occurrenceId = createPluginRuntimeOccurrenceId(inputType.pluginId);
        const countOptions = [{ value: 'files', label: 'Files' }, { value: 'folders', label: 'Folders', disabled: true }];
        let projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {
            inputTypes: { family: 'inputTypes', entriesById: { 'external.directory-widgets/count-kind': {
                id: 'external.directory-widgets/count-kind', pluginId: inputType.pluginId, pluginVersion: '1.0.0',
                occurrenceId, definition: { id: inputType.localId, title: 'Count kind',
                    semantic: 'directory-count-kind', valueSchema: { type: 'string', enum: ['files', 'folders'] },
                    options: { resource: 'count-kinds' } },
            } } },
        } });
        const type = projection.familiesById.inputTypes!.entriesById['external.directory-widgets/count-kind']!;
        const registry = createResolvedContributionRegistry({ occurrenceIdsByPluginId: { [inputType.pluginId]: occurrenceId },
            inputTypes: [{ provenance: 'external', source: { kind: 'path' }, pluginId: inputType.pluginId,
                identity: inputType, manifestPath: '/plugins/directory/plugin.json', definition: type.definition }],
            resources: [{ provenance: 'external', source: { kind: 'path' }, pluginId: inputType.pluginId,
                definition: { kindVersion: 1, id: 'count-kinds', source: 'dynamic', type: 'config', scope: 'global', contentType: 'application/json' } }],
        });
        const inputTypeDeps = createRegistryInputTypeDeps({ contributes: registry, readUiResource: async () => ({
            resource: { pluginId: inputType.pluginId, localId: 'count-kinds' }, kind: 'config',
            contentType: 'application/json', digest: `sha256:${'a'.repeat(64)}`, bytes: new TextEncoder().encode(JSON.stringify(countOptions)),
        }) });
        const daemon = createCliActionExecutor({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: 'board-home', serverHttpBaseUrl: 'https://board-home.test', pluginActionExecutionOwner: 'current_process', inputTypeDeps,
            machineActionDirectTargetTransport: { machineId: 'widget-machine', invoke: async () => ({ protocolVersion: 1, projection }) } });
        const executor = createCliActionExecutor({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: 'board-home', serverHttpBaseUrl: 'https://board-home.test',
            ...(initiallyUnavailable ? { pluginActionExecutionOwner: 'current_process' as const,
                inputTypeDeps } : { readAdmittedInputTypeOptions: async ({ input, context }) => {
                    // Model only the process transport; the receiving built-in
                    // options owner validates the real consumer and Resource.
                    const result = await daemon.execute('action.options.resolve', input, context);
                    return result.ok ? result.result : result;
                } }),
            machineActionDirectTargetTransport: { machineId: 'widget-machine', invoke: async () => ({ protocolVersion: 1, projection }) } });
        const context = { surface: 'cli', bypassApprovals: true } as const;
        const created = await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222228', name: 'Board title' } } }, context);
        expect(created, JSON.stringify(created))
            .toMatchObject({ ok: true, result: { board: { id: '22222222-2222-4222-8222-222222222228', name: 'Board title' } } });
        expect(rows.get('22222222-2222-4222-8222-222222222228')?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
        const updated = await executor.execute('boards.apply', { intent: { kind: 'update', boardId: '22222222-2222-4222-8222-222222222228', patch: { pinnedInSessions: true, mode: 'by_status' } } }, context);
        expect(updated, JSON.stringify(updated))
            .toMatchObject({ ok: true, result: { board: { pinnedInSessions: true, mode: 'by_status' } } });
        expect(await executor.execute('boards.list', {}, context)).toMatchObject({ ok: true, result: { boards: [{ id: '22222222-2222-4222-8222-222222222228', name: 'Board title', pinnedInSessions: true }] } });
        const surface = { serverId: 'board-home', accountId: 'owner', owner: { kind: 'workBoard', boardId: '22222222-2222-4222-8222-222222222228' } } as const;
        const typedDefinition = { name: 'Directory count',
            sizeDeclaration: { sizes: ['small'], defaultSize: 'small' },
            body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Count' } } },
            inputs: { fields: [{ path: 'filter', title: 'Count', widget: 'select', required: true, inputType }] },
            inputSchema: { type: 'object', properties: { filter: { type: 'string' } }, required: ['filter'], additionalProperties: false },
        } as const;
        expect(await executor.execute('widgets.definition.create', { account: { serverId: 'board-home', accountId: 'owner' },
            artifactId: 'e5e9fe52-0e70-405a-840d-febd148824dc', definition: typedDefinition }, context)).toMatchObject({ ok: true });
        const typedInstance = { v: 1, id: 'typed-counter', definition: { kind: 'artifact', artifactId: 'e5e9fe52-0e70-405a-840d-febd148824dc' },
            bindings: { filter: { kind: 'value', value: 'files' } } } as const;
        const typedRef = { surface, instanceId: typedInstance.id };
        const typedAdd = await executor.execute('widgets.item.add', { surface, instance: typedInstance }, context);
        expect(typedAdd, JSON.stringify(typedAdd)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: typedRef, bindings: typedInstance.bindings }, context))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { filter: 'files' } } });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: typedRef, bindings: { filter: { kind: 'value', value: 'other' } } }, context))
            .toMatchObject({ ok: true, result: { status: 'invalid', fields: [{ path: 'filter', reasonCode: 'input_type_value_invalid' }] } });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: typedRef, bindings: { filter: { kind: 'value', value: 'folders' } } }, context))
            .toMatchObject({ ok: true, result: { status: 'invalid', fields: [{ path: 'filter', reasonCode: 'widget_input_option_unavailable' }] } });
        const availableProjection = projection;
        projection = PluginProjectionV2Schema.parse({ v: 2, generation: 2 });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: typedRef, bindings: typedInstance.bindings }, context))
            .toMatchObject({ ok: true, result: { status: 'unavailable', fields: [{ path: 'filter', reasonCode: 'input_type_unavailable' }] } });
        projection = availableProjection;
        expect(await executor.execute('widgets.item.remove', { ref: typedRef }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.definition.delete', { account: { serverId: 'board-home', accountId: 'owner' },
            artifactId: 'e5e9fe52-0e70-405a-840d-febd148824dc' }, context)).toMatchObject({ ok: true });
        const authoredInputs = { fields: [{ path: 'repo', title: 'Repository', widget: 'text' },
            { path: 'filter', title: 'Count', widget: 'select', inputType }] } as const;
        for (const [artifactId, body] of [
            ['6679b75f-64af-4a8c-865d-a2dfb6a6e081', { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } }],
            ['871ea8fd-5f1e-4cba-884e-c21029fb9173', { kind: 'html', source: { v: 1, entrypoint: 'index.html', files: {
                'index.html': { mime: 'text/html', contentBase64: 'PGgxPkNvcHk8L2gxPg==' },
            } } }],
            ['4fe1998b-c5c2-497e-8e3c-8610d7e9ef6c', { kind: 'installed', surface: { pluginId: 'com.acme.removed', localId: 'checks' } }],
        ] as const) {
            expect(await executor.execute('widgets.definition.create', { account: { serverId: 'board-home', accountId: 'owner' }, artifactId,
                definition: { name: artifactId, sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' }, inputs: authoredInputs,
                    inputSchema: { type: 'object', properties: { repo: { type: 'string' }, filter: { type: 'string' } } }, body } }, context))
                .toMatchObject({ ok: true });
        }
        const beforeCatalog = get.mock.calls.length;
        const catalog = await executor.execute('widgets.catalog.list', { surface }, context);
        expect(catalog, JSON.stringify(catalog)).toMatchObject({ ok: true, result: { entries: expect.any(Array) } });
        if (!catalog.ok) throw new Error('Expected catalog');
        expect(catalog.result).toMatchObject({ entries: expect.arrayContaining([
            expect.objectContaining({ definition: { kind: 'artifact', artifactId: '6679b75f-64af-4a8c-865d-a2dfb6a6e081' }, fields: authoredInputs.fields, availability: 'available' }),
            expect.objectContaining({ definition: { kind: 'artifact', artifactId: '871ea8fd-5f1e-4cba-884e-c21029fb9173' }, fields: authoredInputs.fields, availability: 'available' }),
            expect.objectContaining({ definition: { kind: 'artifact', artifactId: '4fe1998b-c5c2-497e-8e3c-8610d7e9ef6c' }, fields: authoredInputs.fields, availability: 'unavailable' }),
        ]) });
        expect(get.mock.calls.slice(beforeCatalog).some(call => ['/v1/artifacts/checks-definition', '/v1/artifacts/removed-definition'].includes(new URL(call[0]).pathname))).toBe(false);
        const instance = { v: 1, id: 'widget-copy', definition: { kind: 'artifact', artifactId: '6679b75f-64af-4a8c-865d-a2dfb6a6e081' }, bindings: {} } as const;
        const ref = { surface, instanceId: instance.id };
        expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: '22222222-2222-4222-8222-222222222228', ref, instance } }, context))
            .toMatchObject({ ok: true, result: { board: { mode: 'by_status', widgets: [{ instance, size: 'medium' }] } } });
        expect(await executor.execute('widgets.item.list', { surface }, context))
            .toMatchObject({ ok: true, result: { instances: [{ instance, size: 'medium' }] } });
        expect(await executor.execute('widgets.item.size.set', { ref, size: 'full' }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.list', { surface }, context))
            .toMatchObject({ ok: true, result: { instances: [{ instance, size: 'full' }] } });
        const home = { ...surface, owner: { kind: 'home' } } as const;
        const homeInstance = { v: 1, id: 'home-copy', displayName: 'Named Home copy',
            definition: { kind: 'artifact', artifactId: '6679b75f-64af-4a8c-865d-a2dfb6a6e081' }, bindings: {
                repo: { kind: 'value', value: 'my/repo' }, filter: { kind: 'value', value: 'files' },
            } } as const;
        const homeRef = { surface: home, instanceId: homeInstance.id };
        if (initiallyUnavailable) {
            const unreadableHome = await executor.execute('widgets.item.add', { surface: home, instance: homeInstance }, context);
            expect(unreadableHome, JSON.stringify(unreadableHome)).toMatchObject({ ok: false, errorCode: 'widget_add_unknown',
                details: { reasonCode: 'widget_write_ack_unknown' } });
            expect(rows.has(homeArtifactId)).toBe(true);
            // Recovery reads the same already-written singleton instead of inventing acknowledged content.
            withholdCreatedHome = false;
        }
        const addedHome = await executor.execute('widgets.item.add', { surface: home, instance: homeInstance }, context);
        expect(addedHome, JSON.stringify(addedHome)).toMatchObject(initiallyUnavailable
            ? { ok: false, errorCode: 'widget_instance_already_exists' } : { ok: true });
        expect(await executor.execute('widgets.item.list', { surface: home }, context)).toMatchObject({ ok: true, result: {
            instances: expect.arrayContaining([expect.objectContaining({ instance: homeInstance })]),
        } });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: homeRef, bindings: homeInstance.bindings }, context))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { repo: 'my/repo', filter: 'files' } } });
        expect(homeCreates).toBe(1);
        expect(await executor.execute('widgets.item.size.set', { ref: homeRef, size: 'full' }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.frame.set', { ref: homeRef, frameStyle: 'plain' }, context)).toMatchObject({ ok: true });
        const movedHome = await executor.execute('widgets.item.move', { ref: homeRef, to: { surface, index: 0 } }, context);
        expect(movedHome, JSON.stringify(movedHome))
            .toMatchObject({ ok: true, result: { status: 'moved' } });
        expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true, result: { instances: [
            { instance: homeInstance, size: 'full', frameStyle: 'plain' }, { instance, size: 'full' },
        ] } });
        expect(await executor.execute('widgets.catalog.list', { surface }, context)).toMatchObject({ ok: true, result: { entries: expect.arrayContaining([
            expect.objectContaining({ definition: homeInstance.definition, instanceCount: 2 }),
            expect.objectContaining({ definition: { kind: 'artifact', artifactId: '4fe1998b-c5c2-497e-8e3c-8610d7e9ef6c' }, instanceCount: 0 }),
        ]) } });
        const areaInstance = { ...homeInstance, id: 'area-copy', bindings: { ...homeInstance.bindings,
            filter: { kind: 'context', slot: 'filter' },
        } } as const;
        const areaContext = { ...context, widgetAreaContext: { surface: area, values: { filter: ['files'] } } };
        if (initiallyUnavailable) {
            const unreadableArea = await executor.execute('widgets.item.add', { surface: area, instance: areaInstance }, areaContext);
            expect(unreadableArea, JSON.stringify(unreadableArea)).toMatchObject({ ok: false, errorCode: 'widget_add_unknown',
                details: { reasonCode: 'artifact_content_unavailable' } });
            expect(rows.has(areaArtifactId)).toBe(true);
        }
        const addedArea = await executor.execute('widgets.item.add', { surface: area, instance: areaInstance }, areaContext);
        expect(addedArea, JSON.stringify(addedArea)).toMatchObject({ ok: true });
        expect(areaCreates).toBe(1);
        expect(await executor.execute('widgets.item.list', { surface: area }, context)).toMatchObject({ ok: true, result: {
            instances: [{ instance: areaInstance, size: 'medium' }],
        } });
        expect(await executor.execute('widgets.item.inputs.validate', { ref: { surface: area, instanceId: areaInstance.id },
            bindings: areaInstance.bindings }, areaContext))
            .toMatchObject({ ok: true, result: { status: 'ready', input: { repo: 'my/repo', filter: 'files' } } });
        const homeState = await executor.execute('widgets.item.list', { surface: home }, context);
        expect(homeState).toMatchObject({ ok: true, result: { instances: expect.not.arrayContaining([expect.objectContaining({ instance: homeInstance })]) } });
        expect(await executor.execute('widgets.item.remove', { ref: { surface, instanceId: homeInstance.id } }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.remove', { ref }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.item.list', { surface }, context)).toMatchObject({ ok: true, result: { instances: [] } });
        expect(await executor.execute('boards.apply', { intent: { kind: 'delete', boardId: '22222222-2222-4222-8222-222222222228' } }, context)).toMatchObject({ ok: true, result: { board: null } });
        expect(rows.has('22222222-2222-4222-8222-222222222228')).toBe(false);
    });
    it('writes one Board, replays a position conflict, and leaves another Board and settings untouched', async () => {
        advertiseKindIndexing();
        const key = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: 'board-home', id: 's1' } });
        const otherKey = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: 'board-home', id: 's2' } });
        let board = createWorkBoardV1({ id: 'b1', name: 'CLI Board' });
        const other = createWorkBoardV1({ id: 'other', name: 'Other Board' });
        let version = 1;
        let conflict = true;
        const row = (id: string) => ({ id, header: encodePlainArtifactStoredContent({ kind: 'work-board.v1', v: 1, title: id === 'b1' ? board.name : other.name, pinnedInSessions: false, readsNeedsYou: false }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(id === 'b1' ? board : other) }), headerVersion: version, bodyVersion: version,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: version, createdAt: 1, updatedAt: version,
            ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain', publicAudience: 'none' });
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: { unrelated: 'x'.repeat(600_000) } }, version: 1 } };
            if (url.endsWith('/access/grants')) return { status: 200, data: {
                artifactId: new URL(url).pathname.split('/')[3], ownerAccountId: 'owner', access: 'owner', grants: [],
            } };
            if (url.includes('/v1/artifacts?')) {
                const items = [row('b1'), row('other')];
                return { status: 200, data: artifactListResponse(url, items) };
            }
            if (url.endsWith('/v1/artifacts/b1')) return { status: 200, data: row('b1') };
            if (url.endsWith('/v1/artifacts/other')) return { status: 200, data: row('other') };
            // The legacy path has a real empty response, so missing mock setup cannot supply RED.
            if (url.includes('/v1/kv/')) return { status: 404 };
            throw new Error(`unexpected_get:${url}`);
        });
        const post = vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            expect(url).toBe('https://board-home.test/v1/artifacts/b1');
            const write = z.object({ body: z.string(), expectedBodyVersion: z.number() }).parse(body);
            expect(write.expectedBodyVersion).toBe(version);
            if (conflict) {
                conflict = false;
                board = { ...board, positionsByItemRef: { [otherKey]: { x: 3, y: 4 } } };
                version++;
                return { status: 200, data: { success: false, error: 'version-mismatch' } };
            }
            const opened = decodePlainArtifactStoredContent(write.body);
            if (!opened || typeof opened !== 'object' || !('body' in opened) || typeof opened.body !== 'string') throw new Error('invalid Artifact body');
            board = WorkBoardV1Schema.parse(JSON.parse(opened.body));
            version++;
            return { status: 200, data: { success: true, headerVersion: version, bodyVersion: version } };
        });
        const executor = createActionExecutor(createCliActionDeps({ token: 'board-token', credentials: { token: 'board-token', encryption: null }, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: 'board-home', serverHttpBaseUrl: 'https://board-home.test' }));
        const context = { surface: 'cli', bypassApprovals: true } as const;
        const positioned = await executor.execute('boards.apply', { intent: { kind: 'set_positions', boardId: 'b1', positionsByItemRef: { [key]: { x: 48, y: 96 } } } }, context);
        expect(positioned, JSON.stringify(positioned)).toMatchObject({ ok: true });
        expect(board.positionsByItemRef).toEqual({ [key]: { x: 48, y: 96 }, [otherKey]: { x: 3, y: 4 } });
        expect(await executor.execute('boards.list', {}, context)).toMatchObject({ ok: true, result: { boards: [{ id: 'other' }, { id: 'b1' }] } }); // equal updatedAt: the Artifact list order is id-descending
        expect(post.mock.calls.every(call => call[0] === 'https://board-home.test/v1/artifacts/b1')).toBe(true);
        expect(get.mock.calls.some(call => call[0].includes('/v1/kv/'))).toBe(false);
    });
});
