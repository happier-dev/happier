import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { t } from '@/text';

import { BoardUndeterminedLine } from './BoardUndeterminedLine';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

function Publication() {
    const commands = useCurrentUiContextComposedCommands();
    const enrichment = React.useMemo(() => ({ commands }), [commands]);
    usePublishCurrentUiContext(enrichment);
    return null;
}

describe('BoardUndeterminedLine', () => {
    it('publishes only the displayed task-source Retry and retires it when the recovery completes', async () => {
        const home = await createPlainArtifactHomeFixture('https://board-task-retry.test');
        function Surface() {
            const [complete, setComplete] = React.useState(false);
            return <CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
                <Publication /><BoardUndeterminedLine undetermined={{ count: 0, reasons: [] }}
                    taskItemsComplete={complete} onRetryTasks={() => setComplete(true)} />
            </CurrentUiContextCommandsProvider>;
        }
        try {
            const screen = await renderMountedCurrentUiContext(<Surface />);
            const executor = createDefaultActionExecutor();
            const commands = async () => {
                const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
                if (!read.ok) throw new Error('Expected Board task-source context');
                return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
            };
            const inventory = await commands();
            expect(inventory.map(command => command.title)).toEqual([t('common.retry')]);
            await act(async () => { expect(await executor.execute('ui.current_context.command.invoke',
                { commandId: inventory[0]!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
            expect(screen.findByTestId('board-undetermined')).toBeNull();
            expect(await commands()).toEqual([]);
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: inventory[0]!.id }, { surface: 'agent' }))
                .toMatchObject({ ok: false });
            await screen.unmount();
        } finally { await standardCleanup(); await home.dispose(); }
    });
    it('shows incomplete task discovery without an invented count and offers recovery until complete', async () => {
        const retry = vi.fn();
        const undetermined = { count: 0, reasons: [] };
        const screen = await renderScreen(<BoardUndeterminedLine undetermined={undetermined} taskItemsComplete={false} onRetryTasks={retry} />);
        expect(screen.getTextContent()).toContain('Some task sources could not be read');
        expect(screen.findByTestId('board-undetermined-action')).toBeTruthy();
        screen.findByTestId('board-undetermined-action')?.props.onPress();
        expect(retry).toHaveBeenCalledOnce();
        await screen.update(<BoardUndeterminedLine undetermined={undetermined} taskItemsComplete />);
        expect(screen.findByTestId('board-undetermined')).toBeNull();
    });
    it('says what could not be checked and why, once, and nothing when everything was checked', async () => {
        const screen = await renderScreen(<BoardUndeterminedLine undetermined={{
            count: 2, reasons: [{ kind: 'session', reason: 'project_association_unavailable', count: 2 }],
        }} />);
        expect(screen.findByTestId('board-undetermined')).toBeTruthy();
        expect(screen.getTextContent()).toContain("2 sessions couldn't be checked");
        expect(screen.getTextContent()).toContain('Project association');
        await screen.update(<BoardUndeterminedLine undetermined={{ count: 0, reasons: [] }} />);
        expect(screen.findByTestId('board-undetermined')).toBeNull();
    });
});
