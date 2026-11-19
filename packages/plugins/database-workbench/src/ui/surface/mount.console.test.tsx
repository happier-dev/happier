// @vitest-environment jsdom
import { act, createElement } from 'react';
import { expect, it } from 'vitest';
import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import type { WorkbenchInstance } from '../workbench.js';
import { workbenchTargetKey } from '../workbench.js';
import { useWorkbenchMount } from './mount.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const engines = ['postgresql', 'mysql', 'sqlite'] as const;

it.each(engines.flatMap(engine => [
    { engine, caret: 'inside' }, { engine, caret: 'after terminator' },
]))('runs the mounted $engine statement with the caret $caret', async ({ engine, caret }) => {
    const descriptor = { ...createDatabaseDescriptorV1Fixture(), engine };
    const targetKey = workbenchTargetKey(descriptor.target);
    const scope = { kind: 'worktree' as const, accountId: 'account', installationId: 'installation', projectKey: 'project',
        workspace: { serverId: 'home', machineId: 'machine', workspaceId: 'workspace', rootPath: '/repo' } };
    let mounted: WorkbenchInstance | null = null;
    function Probe({ context }: { context: RenderContext }) {
        mounted = useWorkbenchMount(context, { scope, descriptor }, { targetKey, mode: 'console', sort: [], columns: [],
            page: { rows: 50, offset: 0 }, fkTrail: [] }, { pageLocation: false });
        return null;
    }
    const fixture = await createPluginUiTestkit({
        identity: { instanceId: `console-${engine}`, mountNonce: `console-${engine}` },
        authorPlugin: { id: 'happier.database', version: '0.0.0' },
        surface: (context: RenderContext) => createElement(Probe, { context }),
        surfaceContext: createSurfaceContextFixture(), adapter: createPluginUiRnwSemanticSurfaceAdapter(),
        handlers: { deviceState: () => ({ status: 'ready', value: null }), notify: () => {}, setUnsavedChanges: () => {} },
    });
    try {
        if (!mounted) throw new Error('The workbench mount must be live');
        const instance: WorkbenchInstance = mounted;
        const console = instance.console(targetKey);
        const sql = "select ';' as first;\nselect 'second;value' as second;";
        await act(async () => console.setText(sql));
        const offset = caret === 'inside' ? sql.indexOf('second;value') : sql.length;
        console.setSelection({ start: offset, end: offset });
        const prepared = await console.run().controller.prepare({ signal: new AbortController().signal });
        expect(prepared?.input).toMatchObject({ operation: 'statement.run', mode: 'read',
            statement: { sql: "select 'second;value' as second", parameters: [] } });
    } finally { await fixture.dispose(); }
});
