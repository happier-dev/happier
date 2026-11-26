import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { getVitestNodeBuiltin } from '@/dev/vitestNodeBuiltins';
import { BrowserDiagnosticsEvalConsole } from './BrowserDiagnosticsEvalConsole';
import { DiagnosticsRow } from './BrowserDiagnosticsFamilyPanel';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Absolute resolution bypasses the Node test shim's react-native-web package proxy.
// The real installed mapper drops accessibilityState.expanded, unlike the native renderer.
const require = getVitestNodeBuiltin<typeof import('node:module')>('node:module').createRequire(import.meta.url);
const createDOMProps: (tag: string, props: Record<string, unknown>) => Record<string, unknown> =
    require(require.resolve('react-native-web/dist/cjs/modules/createDOMProps'));
const { renderToStaticMarkup }: typeof import('react-dom/server') = require('react-dom/server');

describe('Browser diagnostics web disclosure semantics', () => {
    it('publishes row disclosure without its private values, shares press state, and rejects the retired address', async () => {
        const home = await serveActionHomes({ homes: [{ key: 'a', serverUrl: 'https://diagnostic-row-controls.test', accountId: 'account-a' }],
            route: request => request.path === '/v1/kv/bulk' ? Response.json({ values: [] }) : undefined });
        const server = home.homes.a!;
        publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
        function Host({ expandable = true }: Readonly<{ expandable?: boolean }>) {
            const commands = useCurrentUiContextComposedCommands();
            usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
            return <DiagnosticsRow testID="request-row" subject="private request URL" renderDetail={expandable
                ? () => <Text testID="request-detail">Private body stays in the viewer</Text> : undefined} />;
        }
        const screen = await renderMountedCurrentUiContext(<Host />);
        const executor = createDefaultActionExecutor();
        const caller = { serverId: server.id, surface: 'agent' as const, authority: 'account_automation' as const };
        async function inventory() {
            const read = await executor.execute('ui.current_context.read', {}, caller);
            if (!read.ok) throw new Error(read.errorCode);
            return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
        }
        try {
            const commands = await inventory();
            expect(commands.map(row => row.title)).toEqual([t('common.expand')]);
            expect(JSON.stringify(commands)).not.toContain('private request URL');
            const address = commands[0]!.id;
            await act(async () => expect(await executor.execute('ui.current_context.command.invoke', { commandId: address }, caller)).toMatchObject({ ok: true }));
            expect(screen.findByTestId('request-detail')).not.toBeNull();
            expect((await inventory()).map(row => row.title)).toEqual([t('common.collapse')]);
            await screen.pressByTestIdAsync('request-row');
            expect(screen.findByTestId('request-detail')).toBeNull();
            await screen.update(<Host expandable={false} />);
            expect(await inventory()).toEqual([]);
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: address }, caller)).toMatchObject({ ok: false });
        } finally {
            await screen.unmount();
            await home.dispose();
        }
    });

    it.each(['family', 'eval'] as const)('announces collapsed and expanded %s rows on the web', async kind => {
        const id = kind === 'family' ? 'row' : 'eval-result-one-expand';
        const screen = await renderScreen(kind === 'family'
            ? <DiagnosticsRow testID="row" subject="Request" renderDetail={() => <></>} />
            : <BrowserDiagnosticsEvalConsole testID="eval" controls={{
                entries: [{ evalRequestId: 'one', expression: 'object', objectGroupId: 'group', status: 'completed',
                    result: { type: 'object', objectId: 'object', preview: [] } }],
                objectProperties: {}, onSubmitExpression: () => true, onExpandObject: () => true, onCancelEval: () => {},
            }} />);
        const markup = () => {
            const props = createDOMProps('button', screen.findHostByTestId(id)!.props);
            return renderToStaticMarkup(React.createElement('button', props));
        };
        expect(markup()).toContain('aria-expanded="false"');
        await act(async () => { screen.pressByTestId(id); });
        expect(markup()).toContain('aria-expanded="true"');
        await act(async () => { screen.pressByTestId(id); });
        expect(markup()).toContain('aria-expanded="false"');
    });
});
