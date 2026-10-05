import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createWidgetDefinitionArtifactPortV1 } from '@happier-dev/protocol/widgets';
import { createWorkBoardArtifactBoundary } from '../../../../../../packages/protocol/src/boards/workBoardArtifactV1.testkit';
import { readWidgetDefinitionForInstanceV1 } from './widgetDefinitionRead';

describe('mounted authored definition read', () => {
    it('reads mutable refs through the real Action owner and leaves deleted refs unavailable', async () => {
        const boundary = createWorkBoardArtifactBoundary();
        const transport = { ...boundary.transport,
            read: async (...args: Parameters<typeof boundary.transport.read>) => { const row = await boundary.transport.read(...args); return row && { ...row, ownerAccountId: 'owner' }; },
            list: async (args: Parameters<typeof boundary.transport.list>[0]) => { const page = await boundary.transport.list(args); return { ...page, items: page.items.map(row => ({ ...row, ownerAccountId: 'owner' })) }; },
        };
        const port = createWidgetDefinitionArtifactPortV1(transport, { accountId: 'owner' });
        const scope = { serverId: 'home', accountId: 'owner', owner: { kind: 'home' as const } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({ widgetAccountScope: () => scope, widgetDefinitionArtifacts: port }));
        const definition = await port.create({ v: 1, id: 'count', name: 'Count', body: { kind: 'declarative', document: { version: 1, root: { kind: 'text', text: 'First' } } },
            inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false }, provenance: { source: { kind: 'authored' } } });
        const ref = { kind: 'artifact' as const, artifactId: definition.id };
        expect(await readWidgetDefinitionForInstanceV1(executor, scope, ref)).toMatchObject({ name: 'Count' });
        await port.update(definition.id, { name: 'Edited everywhere' });
        expect(await readWidgetDefinitionForInstanceV1(executor, scope, ref)).toMatchObject({ name: 'Edited everywhere' });
        await port.delete(definition.id);
        expect(await readWidgetDefinitionForInstanceV1(executor, scope, ref)).toBeNull();
        expect(await readWidgetDefinitionForInstanceV1(executor, scope, { kind: 'inline', definition })).toEqual(definition);
        await expect(readWidgetDefinitionForInstanceV1(executor, { ...scope, accountId: 'other' }, ref)).rejects.toMatchObject({ code: 'account_target_mismatch' });
    });
});
