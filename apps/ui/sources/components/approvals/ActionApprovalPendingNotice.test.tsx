import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { hitAreaClippingAncestors } from '@/dev/testkit/harness/hitFrameReach';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { renderMountedCurrentUiContext } from '@/dev/testkit/harness/mountedCurrentUiContext';
import { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { usePublishCurrentUiContext } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

function Publication() {
    const commands = useCurrentUiContextComposedCommands();
    const enrichment = React.useMemo(() => ({ commands }), [commands]);
    usePublishCurrentUiContext(enrichment);
    return null;
}
function CommandPage({ children }: React.PropsWithChildren) {
    return <CurrentUiContextCommandsProvider authority={captureActiveServerAccountScopeLifetime()}>
        <Publication />{children}
    </CurrentUiContextCommandsProvider>;
}

describe('mounted approval navigation', () => {
    let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>>;
    beforeEach(async () => { home = await createPlainArtifactHomeFixture('https://approval-navigation.test'); });
    afterEach(async () => { await standardCleanup(); await home.dispose(); });

    it('invokes the existing review Back through the same mounted Account fixture', async () => {
        const { ApprovalDetailScreen } = await import('./ApprovalDetailScreen');
        function Surface() {
            const [closed, setClosed] = React.useState(false);
            return <CommandPage>{closed ? 'review closed' : <ApprovalDetailScreen artifactId="missing-approval"
                serverId={home.home.id} onBack={() => setClosed(true)} />}</CommandPage>;
        }
        const screen = await renderMountedCurrentUiContext(<Surface />);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('common.back'));
        const executor = createDefaultActionExecutor();
        const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
        if (!read.ok) throw new Error('Expected existing review Back context');
        const inventory = CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
        expect(inventory.map(command => command.title)).toEqual(['common.back']);
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke',
            { commandId: inventory[0]!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(screen.getTextContent()).toContain('review closed');
        await screen.unmount();
    });

    it.each(['row', 'inline', 'banner', 'line', 'compact'] as const)(
        'publishes exactly the visible %s opener and retires its address when hidden', async presentation => {
        const { ActionApprovalPendingNotice } = await import('./ActionApprovalPendingNotice');
        const { ApprovalOpenButton } = await import('@/components/tools/shell/approvals/ApprovalOpenButton');
        function Surface({ visible }: { visible: boolean }) {
            const [opened, setOpened] = React.useState(0);
            const open = () => setOpened(count => count + 1);
            return <CommandPage>{opened ? <React.Fragment>{`opened review ${opened}`}</React.Fragment> : null}{visible
                ? presentation === 'compact' ? <ApprovalOpenButton testID="open" onPress={open} />
                    : <ActionApprovalPendingNotice testID="pending" presentation={presentation} message="Waiting" onOpenApproval={open} />
                : null}</CommandPage>;
        }
        const screen = await renderMountedCurrentUiContext(<Surface visible />);
        const executor = createDefaultActionExecutor();
        const readCommands = async () => {
            const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
            expect(read.ok).toBe(true);
            if (!read.ok) throw new Error('Expected approval navigation context');
            return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
        };
        const inventory = await readCommands();
        expect(inventory.map(command => command.title)).toEqual([presentation === 'compact' ? 'toolView.open' : 'approvals.review']);
        await act(async () => {
            expect(await executor.execute('ui.current_context.command.invoke', { commandId: inventory[0]!.id }, { surface: 'agent' }))
                .toMatchObject({ ok: true });
        });
        expect(screen.getTextContent()).toContain('opened review 1');
        await screen.update(<Surface visible={false} />);
        expect(await readCommands()).toEqual([]);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: inventory[0]!.id }, { surface: 'agent' }))
            .toMatchObject({ ok: false });
        await screen.update(<Surface visible />);
        await screen.pressByTestIdAsync(presentation === 'compact' ? 'open' : presentation === 'inline' ? 'pending' : 'pending.open');
        expect(screen.getTextContent()).toContain('opened review 2');
        await screen.unmount();
    });

    it('publishes inline Review only while enabled and never publishes a decision', async () => {
        const { ApprovalInlineDecisionBar } = await import('./ApprovalInlineDecision');
        const decision: React.ComponentProps<typeof ApprovalInlineDecisionBar>['decision'] = {
            request: null, review: null, fields: null, deciding: null, failure: null, decidesHere: false,
            answer: async () => {},
        };
        function Surface({ disabled = false, decidesHere = false }) {
            const [opened, setOpened] = React.useState(false);
            return <CommandPage>{opened ? 'opened inline review' : null}<ApprovalInlineDecisionBar
                decision={{ ...decision, deciding: disabled ? 'reject' : null, decidesHere }} testIDPrefix="inline"
                layout="inline" openPageLabel="Review request" onOpenPage={() => setOpened(true)} /></CommandPage>;
        }
        const screen = await renderMountedCurrentUiContext(<Surface />);
        const executor = createDefaultActionExecutor();
        const commands = async () => {
            const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
            if (!read.ok) throw new Error('Expected inline review context');
            return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
        };
        const inventory = await commands();
        expect(inventory.map(command => command.title)).toEqual(['Review request']);
        await act(async () => { expect(await executor.execute('ui.current_context.command.invoke',
            { commandId: inventory[0]!.id }, { surface: 'agent' })).toMatchObject({ ok: true }); });
        expect(screen.getTextContent()).toContain('opened inline review');
        await screen.update(<Surface disabled />);
        expect(await commands()).toEqual([]);
        expect(await executor.execute('ui.current_context.command.invoke', { commandId: inventory[0]!.id }, { surface: 'agent' }))
            .toMatchObject({ ok: false });
        await screen.update(<Surface decidesHere />);
        expect(await commands()).toEqual([]);
        await screen.unmount();
    });
});

describe('ActionApprovalPendingNotice', () => {
    it('names what is waiting and offers Review, as a row and inline in a host bar', async () => {
        const { ActionApprovalPendingNotice } = await import('./ActionApprovalPendingNotice');
        const open = vi.fn();
        const row = await renderScreen(<ActionApprovalPendingNotice message="approvals.status.open" testID="notice"
            summary="Write docs/getting-started.md in d-dc-hello-world." onOpenApproval={open} />);
        const rowText = row.getTextContent();
        expect(rowText).toContain('Write docs/getting-started.md in d-dc-hello-world');
        expect(rowText).toContain('approvals.waitingForYou');
        expect(rowText).toContain('approvals.review');
        expect(rowText).not.toContain('approvals.status.open');

        const inline = await renderScreen(<ActionApprovalPendingNotice presentation="inline" message="approvals.status.open"
            testID="inline-notice" summary="Write docs/getting-started.md in d-dc-hello-world." onOpenApproval={open} />);
        expect(inline.getTextContent()).toContain('Write docs/getting-started.md in d-dc-hello-world');
        await inline.pressByTestIdAsync('inline-notice');
        expect(open).toHaveBeenCalledOnce();
    });

    it('lets a finger reach the inline pill past its drawn edge (its words truncate without clipping the press target)', async () => {
        const { ActionApprovalPendingNotice } = await import('./ActionApprovalPendingNotice');
        const inline = await renderScreen(<ActionApprovalPendingNotice presentation="inline" message="approvals.status.open"
            testID="inline-notice" summary="Write docs/getting-started.md in d-dc-hello-world." onOpenApproval={() => {}} />);
        expect(hitAreaClippingAncestors(inline.findHostByTestId('inline-notice')!).map((node) => String(node.props.testID ?? node.type))).toEqual([]);
    });
});
