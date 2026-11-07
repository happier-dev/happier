// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';

import { createWebListDomHarness } from '@/dev/testkit/legend/webListDomHarness';
import type { TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
import { installClampedWebScrollGeometry } from '@/dev/testkit/legend/webScrollGeometry';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { entityReorderPreview, entityReorderRefused, type EntityFlatReorderBinding } from '@/components/ui/treeDragDrop/ui/EntityFlatReorder';
import { CollectionSpacesSettingsList } from './CollectionSpacesSettingsList';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
const nativeGestures = vi.hoisted(() => new WeakMap<Element, TestGestureChain>());
vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    const React = await import('react');
    return {
        ...createGestureHandlerMock(),
        // Native gesture delivery is the boundary; the real row adapter owns the carry lifetime.
        GestureDetector: (props: { children: React.ReactNode; gesture: TestGestureChain }) => React.createElement('span', {
            'data-native-gesture': '', style: { display: 'contents' },
            ref: (node: HTMLSpanElement | null) => { if (node) nativeGestures.set(node, props.gesture); },
        }, props.children),
    };
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const ROW_SELECTOR = '[data-testid^="collection-spaces-settings:"]';
const harness = createWebListDomHarness({ rowSelector: ROW_SELECTOR, rowHeight: 56 });
const scope = { serverId: 'home', accountId: 'owner' };
let runtime: EntityDragDropRuntime;
function Probe() { runtime = useEntityDragDropRuntime(); return null; }

describe('Manage spaces viewport work', () => {
    it('mounts viewport rows, reaches the last Space, and retains an active drag and edit anchor while scrolling', async () => {
        // Large enough to distinguish viewport work from eager mounting; every Space remains addressable.
        const spaces = Array.from({ length: 192 }, (_, index) => ({ id: `space-${index}`, name: `Space ${index}`, icon: { kind: 'icon', name: 'list' } as const }));
        const lastId = spaces.at(-1)!.id;
        const ids = spaces.map(space => space.id);
        const binding: EntityFlatReorderBinding = {
            scope, kind: 'collection-space', items: spaces.map(space => ({ id: space.id, title: space.name })),
            getItem: id => ({ kind: 'collection-space', scope, entityKind: 'sessionWork', spaceId: id }),
            getSourceId: item => item.kind === 'collection-space' ? item.spaceId : null,
            resolve: (source, position) => {
                const next = resolveAnchoredListMoveV1(ids, source, position);
                return !next || next.every((id, index) => id === ids[index]) ? entityReorderRefused('same-position')
                    : { status: 'allowed', effect: { actionId: 'settings.invoke', input: { source, position }, preview: entityReorderPreview(position, binding.items) } };
            },
            execute: async () => ({ status: 'applied' }),
        };
        const anchorRef = React.createRef<import('react-native').View>();
        const edited: string[] = [];
        await act(async () => {
            harness.root.render(<div id="virtualized-list-host" style={{ display: 'flex', flexDirection: 'column', height: 400 }}>
                <Probe />
                <CollectionSpacesSettingsList spaces={spaces} reorder={binding} header={null} editingId="space-1"
                    anchorRef={anchorRef} onEdit={id => edited.push(id)} wrapSpaces={children => children} />
            </div>);
        });
        const mounted = () => harness.container.querySelectorAll(ROW_SELECTOR).length;
        expect(mounted()).toBeLessThan(spaces.length / 4);
        await harness.flush();
        expect(mounted()).toBeGreaterThan(0);
        expect(mounted()).toBeLessThan(spaces.length / 4);
        expect(harness.container.querySelector(`[data-testid="collection-spaces-settings:${lastId}"]`)).toBeNull();

        const scroller = harness.container.querySelector<HTMLElement>('[data-testid="collection-spaces-settings"]')!;
        expect(scroller).not.toBeNull();
        installClampedWebScrollGeometry();
        const grip = harness.container.querySelector<HTMLElement>('[data-testid="collection-spaces-settings.move:space-0"]')!;
        const gesture = nativeGestures.get(grip.closest('[data-native-gesture]')!)!;
        expect(gesture).toBeDefined();
        await act(async () => { gesture.__handlers.onStart({ absoluteX: 20, absoluteY: 20 }); });
        expect(runtime.getSnapshot().phase).toBe('carrying');
        const sourceId = runtime.getSnapshot().sourceId!;
        const last = runtime.getDestinations(sourceId).find(destination => destination.destination
            && typeof destination.destination === 'object' && 'anchorId' in destination.destination
            && destination.destination.anchorId === lastId);
        expect(last).toBeDefined();
        await act(async () => { scroller.scrollTo({ top: scroller.scrollHeight }); });
        await harness.flush();
        expect(harness.container.querySelector(`[data-testid="collection-spaces-settings:${lastId}"]`)).not.toBeNull();
        expect(harness.container.querySelector('[data-testid="collection-spaces-settings:space-0"]')).not.toBeNull();
        expect(anchorRef.current).not.toBeNull();
        expect(runtime.getSnapshot().phase).toBe('carrying');
        await act(async () => { gesture.__handlers.onUpdate({ absoluteX: 20, absoluteY: 350 }); });
        expect(runtime.getSnapshot().phase).toBe('carrying');
        expect(mounted()).toBeLessThan(spaces.length / 4);
        await act(async () => { harness.container.querySelector<HTMLElement>(`[data-testid="collection-spaces-settings.edit:${lastId}"]`)!.click(); });
        expect(edited).toEqual([lastId]);
        await act(async () => { runtime.cancel('test-end'); });
    });
});
