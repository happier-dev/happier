import axios from 'axios';
import { x25519 } from '@noble/curves/ed25519';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, decodePlainArtifactStoredContent,
    WorkBoardV1Schema, buildHomeHubArtifactIdV1, buildWorkBoardItemKeyV1, createActionExecutor, createWorkBoardV1 } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { buildWidgetSurfaceArtifactIdV1 } from '@happier-dev/protocol/widgets';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

describe('CLI Board Actions through the Artifact owner', () => {
    it.each([['plain', false], ['plain', true], ['e2ee', false], ['e2ee', true]] as const)(
        'round-trips Board create/list/edit/delete through the existing %s Artifact codec (Home read unavailable: %s)', async (mode, initiallyUnavailable) => {
        const secret = new Uint8Array(32).fill(7);
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials = { token, encryption: mode === 'plain' ? null
            : { type: 'dataKey' as const, machineKey: secret, publicKey: x25519.getPublicKey(secret) } };
        const createSchema = z.object({ id: z.string(), header: z.string(), body: z.string(), dataEncryptionKey: z.string() });
        const updateSchema = z.object({ header: z.string(), body: z.string(), expectedHeaderVersion: z.number(), expectedBodyVersion: z.number() });
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
            if (path === '/v1/artifacts') return { status: 200, data: [...rows.values()] };
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
                dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey, recipients: [],
            } };
            return row ? { status: 200, data: row } : { status: 404 };
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
            const updated = { ...row, header: next.header, body: next.body, headerVersion: row.headerVersion + 1, bodyVersion: row.bodyVersion + 1 };
            rows.set(row.id, updated);
            return { status: 200, data: { success: true, headerVersion: updated.headerVersion, bodyVersion: updated.bodyVersion } };
        });
        vi.spyOn(axios, 'delete').mockImplementation(async url => {
            const row = rows.get('new-board')!;
            expect(new URL(url).pathname).toBe(`/v1/artifacts/new-board/revision/${row.headerVersion}/${row.bodyVersion}`);
            rows.delete('new-board'); return { status: 200, data: { success: true } };
        });
        // Session storage mode is independent of the Account's Artifact mode; no Session key is fabricated.
        const executor = createActionExecutor(createCliActionDeps({ token: credentials.token, credentials, sessionId: 'cli-global', mode: 'plain', ctx: null,
            serverId: 'board-home', serverHttpBaseUrl: 'https://board-home.test' }));
        const context = { surface: 'cli', bypassApprovals: true } as const;
        expect(await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: 'new-board', name: 'Board title' } } }, context))
            .toMatchObject({ ok: true, result: { board: { id: 'new-board', name: 'Board title' } } });
        expect(rows.get('new-board')?.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER).toBe(mode === 'plain');
        const updated = await executor.execute('boards.apply', { intent: { kind: 'update', boardId: 'new-board', patch: { pinnedInSessions: true, mode: 'by_status' } } }, context);
        expect(updated, JSON.stringify(updated))
            .toMatchObject({ ok: true, result: { board: { pinnedInSessions: true, mode: 'by_status' } } });
        expect(await executor.execute('boards.list', {}, context)).toMatchObject({ ok: true, result: { boards: [{ id: 'new-board', name: 'Board title', pinnedInSessions: true }] } });
        const surface = { serverId: 'board-home', accountId: 'owner', owner: { kind: 'workBoard', boardId: 'new-board' } } as const;
        const authoredInputs = { fields: [{ path: 'repo', title: 'Repository', widget: 'text' }] } as const;
        for (const [artifactId, body] of [
            ['checks-definition', { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'Checks' } } }],
            ['removed-definition', { kind: 'installed', surface: { pluginId: 'com.acme.removed', localId: 'checks' } }],
        ] as const) {
            expect(await executor.execute('widgets.definition.create', { account: { serverId: 'board-home', accountId: 'owner' }, artifactId,
                definition: { name: artifactId, sizeDeclaration: { sizes: ['medium', 'full'], defaultSize: 'medium' }, inputs: authoredInputs, inputSchema: { type: 'object', properties: { repo: { type: 'string' } } }, body } }, context))
                .toMatchObject({ ok: true });
        }
        const beforeCatalog = get.mock.calls.length;
        const catalog = await executor.execute('widgets.catalog.list', { surface }, context);
        expect(catalog, JSON.stringify(catalog)).toMatchObject({ ok: true, result: { entries: expect.any(Array) } });
        if (!catalog.ok) throw new Error('Expected catalog');
        expect(catalog.result).toMatchObject({ entries: expect.arrayContaining([
            expect.objectContaining({ definition: { kind: 'artifact', artifactId: 'checks-definition' }, fields: authoredInputs.fields, availability: 'available' }),
            expect.objectContaining({ definition: { kind: 'artifact', artifactId: 'removed-definition' }, fields: authoredInputs.fields, availability: 'unavailable' }),
        ]) });
        expect(get.mock.calls.slice(beforeCatalog).some(call => ['/v1/artifacts/checks-definition', '/v1/artifacts/removed-definition'].includes(new URL(call[0]).pathname))).toBe(false);
        const instance = { v: 1, id: 'widget-copy', definition: { kind: 'artifact', artifactId: 'checks-definition' }, bindings: {} } as const;
        const ref = { surface, instanceId: instance.id };
        expect(await executor.execute('boards.apply', { intent: { kind: 'widget_add', boardId: 'new-board', ref, instance } }, context))
            .toMatchObject({ ok: true, result: { board: { mode: 'by_status', widgets: [{ instance, size: 'medium' }] } } });
        expect(await executor.execute('widgets.instance.list', { surface }, context))
            .toMatchObject({ ok: true, result: { instances: [{ instance, size: 'medium' }] } });
        expect(await executor.execute('widgets.instance.size.set', { ref, size: 'full' }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.instance.list', { surface }, context))
            .toMatchObject({ ok: true, result: { instances: [{ instance, size: 'full' }] } });
        const home = { ...surface, owner: { kind: 'home' } } as const;
        const homeInstance = { v: 1, id: 'home-copy', displayName: 'Named Home copy',
            definition: { kind: 'artifact', artifactId: 'checks-definition' }, bindings: { repo: { kind: 'value', value: 'my/repo' } } } as const;
        const homeRef = { surface: home, instanceId: homeInstance.id };
        if (initiallyUnavailable) {
            const unreadableHome = await executor.execute('widgets.instance.add', { surface: home, instance: homeInstance }, context);
            expect(unreadableHome, JSON.stringify(unreadableHome)).toMatchObject({ ok: false, errorCode: 'widget_add_unknown',
                details: { reasonCode: 'widget_write_ack_unknown' } });
            expect(rows.has(homeArtifactId)).toBe(true);
            // Recovery reads the same already-written singleton instead of inventing acknowledged content.
            withholdCreatedHome = false;
        }
        const addedHome = await executor.execute('widgets.instance.add', { surface: home, instance: homeInstance }, context);
        expect(addedHome, JSON.stringify(addedHome)).toMatchObject(initiallyUnavailable
            ? { ok: false, errorCode: 'widget_instance_already_exists' } : { ok: true });
        expect(await executor.execute('widgets.instance.list', { surface: home }, context)).toMatchObject({ ok: true, result: {
            instances: expect.arrayContaining([expect.objectContaining({ instance: homeInstance })]),
        } });
        expect(homeCreates).toBe(1);
        expect(await executor.execute('widgets.instance.size.set', { ref: homeRef, size: 'full' }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.instance.frame.set', { ref: homeRef, frameStyle: 'plain' }, context)).toMatchObject({ ok: true });
        const movedHome = await executor.execute('widgets.instance.move', { ref: homeRef, to: { surface, index: 0 } }, context);
        expect(movedHome, JSON.stringify(movedHome))
            .toMatchObject({ ok: true, result: { status: 'moved' } });
        expect(await executor.execute('widgets.instance.list', { surface }, context)).toMatchObject({ ok: true, result: { instances: [
            { instance: homeInstance, size: 'full', frameStyle: 'plain' }, { instance, size: 'full' },
        ] } });
        expect(await executor.execute('widgets.catalog.list', { surface }, context)).toMatchObject({ ok: true, result: { entries: expect.arrayContaining([
            expect.objectContaining({ definition: homeInstance.definition, instanceCount: 2 }),
            expect.objectContaining({ definition: { kind: 'artifact', artifactId: 'removed-definition' }, instanceCount: 0 }),
        ]) } });
        const areaInstance = { ...homeInstance, id: 'area-copy' };
        if (initiallyUnavailable) {
            const unreadableArea = await executor.execute('widgets.instance.add', { surface: area, instance: areaInstance }, context);
            expect(unreadableArea, JSON.stringify(unreadableArea)).toMatchObject({ ok: false, errorCode: 'widget_add_unknown',
                details: { reasonCode: 'widget_write_ack_unknown' } });
            expect(rows.has(areaArtifactId)).toBe(true);
        }
        const addedArea = await executor.execute('widgets.instance.add', { surface: area, instance: areaInstance }, context);
        expect(addedArea, JSON.stringify(addedArea)).toMatchObject({ ok: true });
        expect(areaCreates).toBe(1);
        expect(await executor.execute('widgets.instance.list', { surface: area }, context)).toMatchObject({ ok: true, result: {
            instances: [{ instance: areaInstance, size: 'medium' }],
        } });
        const homeState = await executor.execute('widgets.instance.list', { surface: home }, context);
        expect(homeState).toMatchObject({ ok: true, result: { instances: expect.not.arrayContaining([expect.objectContaining({ instance: homeInstance })]) } });
        expect(await executor.execute('widgets.instance.remove', { ref: { surface, instanceId: homeInstance.id } }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.instance.remove', { ref }, context)).toMatchObject({ ok: true });
        expect(await executor.execute('widgets.instance.list', { surface }, context)).toMatchObject({ ok: true, result: { instances: [] } });
        expect(await executor.execute('boards.apply', { intent: { kind: 'delete', boardId: 'new-board' } }, context)).toMatchObject({ ok: true, result: { board: null } });
        expect(rows.has('new-board')).toBe(false);
    });
    it('writes one Board, replays a position conflict, and leaves another Board and settings untouched', async () => {
        const key = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: 'board-home', id: 's1' } });
        const otherKey = buildWorkBoardItemKeyV1({ kind: 'session', qualifiedId: { serverId: 'board-home', id: 's2' } });
        let board = createWorkBoardV1({ id: 'b1', name: 'CLI Board' });
        const other = createWorkBoardV1({ id: 'other', name: 'Other Board' });
        let version = 1;
        let conflict = true;
        const row = (id: string) => ({ id, header: encodePlainArtifactStoredContent({ kind: 'work-board.v1', v: 1, title: id === 'b1' ? board.name : other.name, pinnedInSessions: false, readsNeedsYou: false }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(id === 'b1' ? board : other) }), headerVersion: version, bodyVersion: version,
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, seq: version, createdAt: 1, updatedAt: version,
            ownerAccountId: 'owner', access: 'owner', encryptionMode: 'plain' });
        const get = vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: { unrelated: 'x'.repeat(600_000) } }, version: 1 } };
            if (url.includes('/v1/artifacts?')) return { status: 200, data: [row('b1'), row('other')] };
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
        await executor.execute('boards.apply', { intent: { kind: 'set_positions', boardId: 'b1', positionsByItemRef: { [key]: { x: 48, y: 96 } } } }, context);
        expect(board.positionsByItemRef).toEqual({ [key]: { x: 48, y: 96 }, [otherKey]: { x: 3, y: 4 } });
        expect(await executor.execute('boards.list', {}, context)).toMatchObject({ ok: true, result: { boards: [{ id: 'b1' }, { id: 'other' }] } });
        expect(post.mock.calls.every(call => call[0] === 'https://board-home.test/v1/artifacts/b1')).toBe(true);
        expect(get.mock.calls.some(call => call[0].includes('/v1/kv/'))).toBe(false);
    });
});
