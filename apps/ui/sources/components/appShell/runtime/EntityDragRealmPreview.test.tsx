// @vitest-environment jsdom
import * as React from 'react';
import { Platform } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { OverlayPortalHost, OverlayPortalProvider } from '@/components/ui/popover/OverlayPortal';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import type { EntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropTypes';
import { EntityDragRealmPreview } from './EntityDragRealmPreview';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/utils/web/reactDomCjs', () => ({
    // ReactTestRenderer cannot render DOM portals; the native portal and drag owner stay real.
    requireReactDOM: () => ({ createPortal: (children: React.ReactNode) => children }),
}));

let runtime: EntityDragDropRuntime;
const retire: Array<() => void> = [];
function RuntimeProbe() { runtime = useEntityDragDropRuntime(); return null; }
function Realm(props: Readonly<{ page: string; feedback?: boolean }>) {
    return <OverlayPortalProvider>
        <RuntimeProbe />
        {props.feedback !== false ? <EntityDragRealmPreview /> : null}
        <React.Fragment key={props.page}>{props.page}</React.Fragment>
        <OverlayPortalHost />
    </OverlayPortalProvider>;
}

afterEach(() => {
    standardCleanup();
    for (const dispose of retire.splice(0)) dispose();
    runtime?.cancel('test-end');
});

describe('one app-realm carried preview', () => {
    it.each(['ios', 'android', 'web'])('shows Home and Zen carries without SessionsList on %s across page retirement', async platform => {
        Reflect.set(Platform, 'OS', platform);
        const screen = await renderScreen(<Realm page="Home" />);
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        retire.push(runtime.registerSource({ id: 'home-section', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'home-section', scope, sectionId: 'setup' }),
            describe: () => ({ title: 'Home setup' }) }));
        retire.push(runtime.registerSource({ id: 'todo', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'todo', scope, todoId: 'task' }),
            describe: () => ({ title: 'Zen task' }) }));
        await act(async () => { runtime.begin('home-section')!.move({ x: 150, y: 150 }); });
        expect(screen.findAllHostsByTestId('entity-drag-carried-preview')).toHaveLength(1);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Home setup');
        await screen.update(<Realm page="Zen" />);
        expect(runtime.getSnapshot().phase).toBe('carrying');
        expect(screen.findAllHostsByTestId('entity-drag-carried-preview')).toHaveLength(1);
        await act(async () => { runtime.cancel('switch-source'); runtime.begin('todo')!.move({ x: 150, y: 150 }); });
        expect(screen.findAllHostsByTestId('entity-drag-carried-preview')).toHaveLength(1);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('Zen task');
        await act(async () => { runtime.cancel('cancel'); });
        expect(screen.findAllHostsByTestId('entity-drag-carried-preview')).toHaveLength(0);
    });

    it('keeps one web cancellation boundary across navigation and retires it with the feedback host', async () => {
        Reflect.set(Platform, 'OS', 'web');
        const screen = await renderScreen(<Realm page="Pool" />);
        const scope = { serverId: 'home-a', accountId: 'account-a' };
        retire.push(runtime.registerSource({ id: 'todo', scope, isCurrent: () => true,
            getItem: () => ({ kind: 'todo', scope, todoId: 'task' }), describe: () => ({ title: 'Task' }) }));
        await act(async () => { runtime.begin('todo')!.move({ x: 150, y: 150 }); });
        await screen.update(<Realm page="Pending queue" />);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })); });
        expect(runtime.getSnapshot().phase).toBe('idle');
        await act(async () => { runtime.begin('todo'); });
        await screen.update(<Realm page="Signed out" feedback={false} />);
        expect(runtime.getSnapshot().phase).toBe('idle');
        await act(async () => { runtime.begin('todo'); window.dispatchEvent(new Event('blur')); });
        expect(runtime.getSnapshot().phase).toBe('carrying');
    });
});
