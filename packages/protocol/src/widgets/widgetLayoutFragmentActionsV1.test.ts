import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../actions/actionExecutor.js';
import { createWorkBoardArtifactBoundary } from '../boards/workBoardArtifactV1.testkit.js';
import { createWidgetLayoutFragmentArtifactPortV1 } from './widgetLayoutFragmentArtifactV1.js';
import { WidgetLayoutFragmentDraftV1Schema } from './widgetLayoutFragmentV1.js';

const account = { serverId: 'home', accountId: 'owner' };
const draft = WidgetLayoutFragmentDraftV1Schema.parse({ name: 'Checks', inputs: { fields: [] },
    inputSchema: { type: 'object', additionalProperties: false }, group: { width: 'full', children: [
        { kind: 'widget', instance: { v: 1, definition: { kind: 'artifact', artifactId: 'independent-definition' },
            bindings: { session: { kind: 'context', slot: 'session' } } }, size: 'medium', frameStyle: 'plain' },
    ] } });

describe('widget layout fragment semantic Actions', () => {
    it('creates and discovers an agent-authored saved group, stamps provenance and keeps child definition references', async () => {
        const b = createWorkBoardArtifactBoundary();
        const port = createWidgetLayoutFragmentArtifactPortV1({ ...b.transport,
            read: async (...args) => { const row = await b.transport.read(...args); return row ? { ...row, ownerAccountId: 'owner' } : null; },
            list: async args => { const page = await b.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        }, { accountId: 'owner' });
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetLayoutFragmentArtifacts: port });
        const context = { surface: 'agent' as const, serverId: 'home', bypassApprovals: true };
        expect(await executor.execute('widgets.fragment.create', { account, artifactId: 'saved', fragment: draft }, context))
            .toMatchObject({ ok: true, result: { fragment: { id: 'saved', group: { frameStyle: 'card', dividers: 'hairline' },
                provenance: { authorAccountId: 'owner', author: { kind: 'agent' }, createdAt: expect.any(Number) } } } });
        expect(await executor.execute('widgets.fragment.list', { account }, context)).toMatchObject({ ok: true,
            result: { fragments: [{ artifactId: 'saved', childCount: 1, group: draft.group }] } });
        const copy = await executor.execute('widgets.fragment.duplicate', { account, artifactId: 'saved', newArtifactId: 'copy' }, context);
        expect(copy).toMatchObject({ ok: true, result: { fragment: { id: 'copy', group: draft.group } } });
        await executor.execute('widgets.fragment.update', { account, artifactId: 'saved', patch: { name: 'Changed' } }, context);
        expect((await port.get('copy'))?.name).toBe('Checks');
        expect(await executor.execute('widgets.fragment.delete', { account, artifactId: 'saved' }, context))
            .toEqual({ ok: true, result: { artifactId: 'saved', status: 'deleted' } });
        expect((await port.get('copy'))?.group.children[0]!.instance.definition).toEqual({ kind: 'artifact', artifactId: 'independent-definition' });
    });
    it('keeps where a group was saved from, so the gallery can say "saved from Home on Oct 8"', async () => {
        const b = createWorkBoardArtifactBoundary();
        const port = createWidgetLayoutFragmentArtifactPortV1({ ...b.transport,
            read: async (...args) => { const row = await b.transport.read(...args); return row ? { ...row, ownerAccountId: 'owner' } : null; },
            list: async args => { const page = await b.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        }, { accountId: 'owner' });
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetLayoutFragmentArtifacts: port });
        const context = { surface: 'ui' as const, serverId: 'home', bypassApprovals: true };
        await executor.execute('widgets.fragment.create', { account, artifactId: 'from-project', fragment: { ...draft, origin: { kind: 'project', name: 'happier' } } }, context);
        await executor.execute('widgets.fragment.create', { account, artifactId: 'unknown-origin', fragment: draft }, context);
        const listed = await executor.execute('widgets.fragment.list', { account }, context);
        expect(listed).toMatchObject({ ok: true });
        const fragments = (listed as { result: { fragments: { artifactId: string; origin?: unknown; createdAt?: number }[] } }).result.fragments;
        expect(fragments.find(entry => entry.artifactId === 'from-project')).toMatchObject({ origin: { kind: 'project', name: 'happier' }, createdAt: expect.any(Number) });
        expect(fragments.find(entry => entry.artifactId === 'unknown-origin')).not.toHaveProperty('origin');
    });
    it('rejects wrong Home or Account before reaching Artifact transport and does not accept authored authority', async () => {
        const b = createWorkBoardArtifactBoundary();
        const port = createWidgetLayoutFragmentArtifactPortV1({ ...b.transport,
            read: async () => { throw new Error('must_not_read'); },
            list: async () => { throw new Error('must_not_list'); },
        }, { accountId: 'owner' });
        const executor = createActionExecutor({ widgetAccountScope: () => account, widgetLayoutFragmentArtifacts: port });
        expect(await executor.execute('widgets.fragment.list', { account: { ...account, accountId: 'other' } }, { surface: 'cli', serverId: 'home' }))
            .toMatchObject({ ok: false, errorCode: 'account_target_mismatch' });
        expect(await executor.execute('widgets.fragment.get', { account: { ...account, serverId: 'other' }, artifactId: 'saved' }, { surface: 'cli', serverId: 'home' }))
            .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(WidgetLayoutFragmentDraftV1Schema.safeParse({ ...draft, provenance: { authorAccountId: 'other' } }).success).toBe(false);
        expect(b.rows.size).toBe(0);
    });
});
