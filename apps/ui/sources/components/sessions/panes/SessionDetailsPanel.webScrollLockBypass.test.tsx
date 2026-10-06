// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

let paneElement: HTMLDivElement;
let bubbled: ReturnType<typeof vi.fn>;
installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            // React Native's host ref is the genuine DOM boundary. Keep all pane logic real.
            View: React.forwardRef<HTMLElement, React.PropsWithChildren<Record<string, unknown>>>(
                function DomBackedView(props, ref) {
                    React.useImperativeHandle(ref, () => paneElement);
                    return React.createElement('View', props, props.children);
                },
            ),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
beforeEach(() => {
    bubbled = vi.fn();
    paneElement = document.createElement('div');
    document.body.appendChild(paneElement);
});
afterEach(() => {
    document.body.removeEventListener('wheel', bubbled);
    document.body.removeEventListener('touchmove', bubbled);
    paneElement.remove();
    document.body.style.overflow = '';
    document.body.style.overflowY = '';
});

describe('SessionDetailsPanel (web scroll-lock bypass)', () => {
    it.each([true, false])('preserves pane scrolling and removes its bypass listeners (body locked: %s)', async (locked) => {
        document.body.style.overflow = locked ? 'hidden' : 'visible';
        document.body.style.overflowY = locked ? 'hidden' : 'visible';
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        const add = vi.spyOn(paneElement, 'addEventListener');
        const remove = vi.spyOn(paneElement, 'removeEventListener');
        document.body.addEventListener('wheel', bubbled);
        document.body.addEventListener('touchmove', bubbled);
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" />
        </runtime.Wrapper>);
        await act(async () => runtime.pane.openDetailsTab({
            key: 'unsupported:scroll', kind: 'unsupported', title: 'Scroll probe',
            resource: { kind: 'unsupported' },
        }, { intent: 'pinned' }));
        expect(screen.findHostByTestId('session-details-panel-root')).not.toBeNull();
        for (const type of ['wheel', 'touchmove']) {
            expect(add).toHaveBeenCalledWith(type, expect.any(Function), { passive: true });
            const event = new Event(type, { bubbles: true, cancelable: true });
            paneElement.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(false);
        }
        // Neither event can reach a document bubble-phase scroll lock, while native default
        // scrolling remains available. This also proves the DOM ref reaches the real owner.
        expect(bubbled).not.toHaveBeenCalled();
        await act(async () => screen.tree.unmount());
        for (const type of ['wheel', 'touchmove']) {
            expect(remove).toHaveBeenCalledWith(type, expect.any(Function));
            paneElement.dispatchEvent(new Event(type, { bubbles: true }));
        }
        expect(bubbled).toHaveBeenCalledTimes(2);
    });
});
