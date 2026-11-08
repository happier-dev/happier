import * as React from 'react';
import { Pressable, View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import { EntityFlatReorderList } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { PendingMessagesDragReorderList } from './PendingMessagesDragReorderList';
import { resolvePendingMessagesPresentation } from './pendingMessageVisualState';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

const scope = { serverId: 'home', accountId: 'account' };
const recipient = { kind: 'execution_run' as const, runId: 'run' };
function message(id: string): PendingMessage {
    return { id: `projection-${id}`, localId: id, text: id, createdAt: 1, updatedAt: 1, rawRecord: {}, recipient };
}
const messages = ['a', 'b', 'c'].map(message);
const renderItem: React.ComponentProps<typeof PendingMessagesDragReorderList>['renderItem'] = args => (
    <View testID={`row-${args.message.localId}`}>
        {args.renderDragHandle({ children: <View testID="obsolete-grip" />, testID: `handle-${args.message.localId}` })}
    </View>
);

function StatefulPendingRow(props: Readonly<{
    id: string;
    renderDragHandle: Parameters<React.ComponentProps<typeof PendingMessagesDragReorderList>['renderItem']>[0]['renderDragHandle'];
}>) {
    const [value, setValue] = React.useState(0);
    return <View testID={`stable-${props.id}`} accessibilityLabel={String(value)}>
        <Pressable testID={`change-${props.id}`} onPress={() => setValue(previous => previous + 1)} />
        {props.renderDragHandle({ children: null, testID: `handle-${props.id}` })}
    </View>;
}

describe('PendingMessagesDragReorderList · shared reorder and flow layout', () => {
    it('paints only its transcript slot while accepting an eligible source from another slot in the same queue', async () => {
        const queueContext = resolvePendingMessagesPresentation(messages);
        const presentation = resolvePendingMessagesPresentation(messages, {
            queueContext, visibleMessageIds: new Set([messages[2]!.id]),
        });
        const screen = await renderScreen(<PendingMessagesDragReorderList scope={scope} sessionId="session"
            recipient={recipient} messages={messages} presentation={presentation} renderItem={renderItem} />);
        expect(screen.findByTestId('row-a')).toBeNull();
        expect(screen.findByTestId('row-b')).toBeNull();
        expect(screen.findByTestId('row-c')).not.toBeNull();
        const binding = screen.tree.root.findByType(EntityFlatReorderList).props.binding;
        expect(binding.items.map((item: { id: string }) => item.id)).toEqual(['c']);
        expect(binding.resolve('a', { anchorId: 'c', placement: 'after' })).toMatchObject({ status: 'allowed' });
    });
    it('retains mounted input identity and local state across queued, provider-owned and queued transitions', async () => {
        const hook = await renderHook(() => useEntityDragDropRuntime());
        const runtime = hook.getCurrent();
        const element = (pendingDeliveryStatus: PendingMessage['pendingDeliveryStatus']) => <PendingMessagesDragReorderList
            scope={scope} sessionId="session" recipient={recipient}
            messages={[{ ...message('a'), source: 'server_pending', pendingDeliveryStatus }, message('b')]}
            renderItem={args => <StatefulPendingRow id={args.message.localId!} renderDragHandle={args.renderDragHandle} />}
        />;
        const screen = await renderScreen(element('server_queued'));
        await screen.pressByTestIdAsync('pendingMessages.reorder.organize');
        await screen.pressByTestIdAsync('change-a');
        const mountedChild = screen.findHostByTestId('stable-a');
        expect(mountedChild?.props.accessibilityLabel).toBe('1');
        expect(screen.findByTestId('handle-a')).not.toBeNull();
        const binding = () => screen.tree.root.findByType(EntityFlatReorderList).props.binding as React.ComponentProps<typeof EntityFlatReorderList>['binding'];
        expect(binding().getItem('a')).not.toBeNull();
        const gripGesture = screen.findAllByType('GestureDetector').find(node => node.findAll(child => child.props.testID === 'handle-a').length > 0)?.props.gesture as TestGestureChain;
        await act(async () => { gripGesture.__handlers.onStart?.({ absoluteX: 25, absoluteY: 25 }); });
        const sourceId = runtime.getSnapshot().sourceId!;
        expect(runtime.getSnapshot().phase).toBe('carrying');

        await screen.update(element('server_delivering'));
        expect.soft(screen.findHostByTestId('stable-a') === mountedChild).toBe(true);
        expect.soft(screen.findHostByTestId('stable-a')?.props.accessibilityLabel).toBe('1');
        expect(binding().getItem('a')).toBeNull();
        expect(binding().resolve('a', { anchorId: 'b', placement: 'after' }).status).toBe('refused');
        expect(screen.findByTestId('handle-a')).toBeNull();
        expect(runtime.getSnapshot().phase).toBe('idle');
        expect(runtime.begin(sourceId)).toBeNull();

        await screen.update(element('server_queued'));
        expect.soft(screen.findHostByTestId('stable-a') === mountedChild).toBe(true);
        expect.soft(screen.findHostByTestId('stable-a')?.props.accessibilityLabel).toBe('1');
        expect(binding().getItem('a')).not.toBeNull();
        expect(binding().resolve('a', { anchorId: 'b', placement: 'after' }).status).toBe('allowed');
        expect(screen.findByTestId('handle-a')).not.toBeNull();
        await act(async () => {
            expect(runtime.begin(sourceId)).not.toBeNull();
            runtime.cancel('test-complete');
        });
    });
    it('cancels an admitted move on unsuccessful native end and finalization', async () => {
        const hook = await renderHook(() => useEntityDragDropRuntime());
        const runtime = hook.getCurrent();
        const screen = await renderScreen(<PendingMessagesDragReorderList scope={scope} sessionId="session" recipient={recipient} messages={messages} renderItem={renderItem} />, {
            createNodeMock: () => ({ measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 180) }),
        });
        expect(screen.findByTestId('handle-a')).toBeNull();
        await screen.pressByTestIdAsync('pendingMessages.reorder.organize');
        const gesture = screen.findAllByType('GestureDetector')[0]!.props.gesture as TestGestureChain;
        await act(async () => { gesture.__handlers.onStart?.({ absoluteX: 25, absoluteY: 25 }); });
        const sourceId = runtime.getSnapshot().sourceId!;
        const destination = runtime.getDestinations(sourceId).find(entry => entry.admission.status === 'allowed'
            && entry.destination && typeof entry.destination === 'object' && !Array.isArray(entry.destination)
            && 'anchorId' in entry.destination && 'placement' in entry.destination
            && entry.destination.anchorId === 'c' && entry.destination.placement === 'after')!;
        expect(destination).toBeDefined();
        await act(async () => { runtime.choose(destination.targetId, destination.destination); });
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'carrying', admission: { status: 'allowed' } });
        await act(async () => { gesture.__handlers.onEnd?.({ absoluteX: 25, absoluteY: 150 }, false); gesture.__handlers.onFinalize?.(); });
        expect(runtime.getSnapshot()).toMatchObject({ phase: 'idle', outcome: null });
    });
    it('admits a durable source and semantic anchor for the exact Session recipient', async () => {
        const screen = await renderScreen(<PendingMessagesDragReorderList scope={scope} sessionId="session" recipient={recipient} messages={messages} renderItem={renderItem} />);
        const binding = screen.tree.root.findByType(EntityFlatReorderList).props.binding;
        expect(binding.getItem('a')).toEqual({ kind: 'pending-input', scope, address: { serverId: 'home', sessionId: 'session' }, localId: 'a' });
        expect(binding.resolve('a', { anchorId: 'c', placement: 'after' })).toMatchObject({ status: 'allowed', effect: { actionId: 'session.pending.reorder', input: {
            scope, sessionId: 'session', recipient, sourceId: 'a', position: { anchorId: 'c', placement: 'after' },
        } } });
        expect(binding.getSourceId({ kind: 'pending-input', scope, address: { serverId: 'home', sessionId: 'other' }, localId: 'a' })).toBeNull();
        expect(binding.getSourceId({ kind: 'pending-input', scope: { ...scope, accountId: 'other' }, address: { serverId: 'home', sessionId: 'session' }, localId: 'a' })).toBeNull();
        expect(binding.resolve('gone', { anchorId: 'c', placement: 'after' }).status).toBe('refused');
    });

    it('reads current membership and refuses a provider-owned or deleted row', async () => {
        const element = (rows: PendingMessage[]) => <PendingMessagesDragReorderList scope={scope} sessionId="session" recipient={recipient} messages={rows} renderItem={renderItem} />;
        const screen = await renderScreen(element(messages));
        await screen.update(element([messages[0]!, messages[2]!, message('added')]));
        const binding = screen.tree.root.findByType(EntityFlatReorderList).props.binding;
        expect(binding.items.map((item: { id: string }) => item.id)).toEqual(['a', 'c', 'added']);
        expect(binding.resolve('a', { anchorId: 'b', placement: 'after' }).status).toBe('refused');
        await screen.update(element([{ ...messages[0]!, source: 'local_outbound' }, messages[2]!]));
        expect(screen.tree.root.findByType(EntityFlatReorderList).props.binding.resolve('a', { anchorId: 'c', placement: 'after' }).status).toBe('refused');
    });

    it('leaves row height and position in normal flow before and after a reorder', async () => {
        const element = (rows: PendingMessage[]) => <PendingMessagesDragReorderList scope={scope} sessionId="session" recipient={recipient} messages={rows} renderItem={renderItem} />;
        const screen = await renderScreen(element(messages));
        const assertFlowRows = () => {
            for (const row of screen.tree.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('row-'))) {
                for (let node = row; node && node.type !== EntityFlatReorderList; node = node.parent!) {
                    const style = Array.isArray(node.props.style) ? Object.assign({}, ...node.props.style) : node.props.style ?? {};
                    expect(style).not.toHaveProperty('position', 'absolute');
                    expect(style).not.toHaveProperty('height');
                    expect(style).not.toHaveProperty('transform');
                }
            }
        };
        assertFlowRows();
        await screen.update(element([messages[1]!, messages[2]!, messages[0]!]));
        assertFlowRows();
        expect(screen.tree.root.findAll(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('row-') && typeof node.type === 'string').map(row => row.props.testID)).toEqual(['row-b', 'row-c', 'row-a']);
        expect(screen.findByTestId('obsolete-grip')).toBeNull();
    });
});
