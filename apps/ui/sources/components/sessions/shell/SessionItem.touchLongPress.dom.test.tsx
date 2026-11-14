// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

const navigate = vi.hoisted(() => vi.fn());
const media = vi.hoisted(() => {
    let coarse = true;
    type Listener = (event: Readonly<{ matches: boolean; media: string }>) => void;
    const queries = new Map<string, { matches: boolean; media: string; listeners: Set<Listener>; addEventListener: (_type: string, listener: Listener) => void; removeEventListener: (_type: string, listener: Listener) => void }>();
    const matchMedia = (query: string) => {
        let entry = queries.get(query);
        if (!entry) {
            const listeners = new Set<Listener>();
            entry = {
                matches: query === '(pointer: coarse)' || query === '(hover: none)' ? coarse
                    : query === '(pointer: fine)' || query === '(hover: hover)' ? !coarse : false,
                media: query,
                listeners,
                addEventListener: (_type, listener) => { listeners.add(listener); },
                removeEventListener: (_type, listener) => { listeners.delete(listener); },
            };
            queries.set(query, entry);
        }
        return entry;
    };
    vi.stubGlobal('matchMedia', matchMedia);
    return {
        install() { vi.stubGlobal('matchMedia', matchMedia); },
        setCoarse(value: boolean) {
            coarse = value;
            const changed: Array<{ matches: boolean; media: string; listeners: Set<Listener> }> = [];
            for (const [query, entry] of queries) {
                const matches = query === '(pointer: coarse)' || query === '(hover: none)' ? coarse
                    : query === '(pointer: fine)' || query === '(hover: hover)' ? !coarse : false;
                if (entry.matches !== matches) {
                    entry.matches = matches;
                    changed.push(entry);
                }
            }
            for (const entry of changed) for (const listener of entry.listeners) listener({ matches: entry.matches, media: entry.media });
        },
    };
});
installSessionShellCommonModuleMocks({
    reactNative: () => vi.importActual('react-native-web'),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { navigate } }).module;
    },
});
// These runtime-bearing fixtures must load after the platform factory is configured;
// otherwise their imports cache the shell helper's default native host stubs.
const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.doUnmock('@/agents/registry/registryUiBehavior');
vi.doUnmock('@/hooks/session/useDraft');

const { createSessionFixture } = await import('@/dev/testkit');
const { createModelBackedSessionItemTestComponent } = await import('./sessionItemRowViewModelTestFixture');
const { isHappierTouchPrimaryPointer } = await import('@happier-dev/plugin-ui/environment');
const { SessionItem } = await import('./SessionItem');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);

// RNW's real responder consumes touchstart/end, rather than pointer events alone.
function touch(row: HTMLElement, type: 'touchstart' | 'touchend') {
    const pointer = new MouseEvent(type === 'touchstart' ? 'pointerdown' : 'pointerup', {
        bubbles: true, button: 0, buttons: type === 'touchstart' ? 1 : 0,
    });
    Object.defineProperty(pointer, 'pointerType', { value: 'touch' });
    row.dispatchEvent(pointer);
    const point = { identifier: 1, target: row, pageX: 20, pageY: 20, clientX: 20, clientY: 20 };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        touches: { value: type === 'touchstart' ? [point] : [] },
        changedTouches: { value: [point] },
        targetTouches: { value: type === 'touchstart' ? [point] : [] },
    });
    row.dispatchEvent(event);
}

describe('SessionItem real web touch responder', () => {
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    let previousState: ReturnType<typeof storage.getState>;
    let serverId: string;

    beforeEach(async () => {
        media.install();
        media.setCoarse(true);
        previousState = storage.getState();
        await home.reset();
        serverId = await home.addHome({ name: 'Touch row Home', serverUrl: 'https://touch-row.test', accountId: 'u1' });
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        navigate.mockClear();
    });
    afterEach(async () => {
        await act(async () => root.unmount());
        container.remove();
        vi.useRealTimers();
        await home.reset();
        storage.setState(previousState, true);
    });

    async function renderRow() {
        await act(async () => root.render(
            <InjectedAuthProvider credentials={{ token: 'touch-row-test' }}>
                <ModelBackedSessionItem session={createSessionFixture({ id: 'touch_row', metadata: null, presence: 1 })}
                    serverId={serverId} onTogglePinned={vi.fn()} />
            </InjectedAuthProvider>,
        ));
        const row = container.querySelector<HTMLElement>('[data-testid="session-list-item-touch_row"]');
        if (!row) throw new Error('Expected the Session row');
        return row;
    }

    async function longPressAndCheckRelease(row: HTMLElement) {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await act(async () => { touch(row, 'touchstart'); vi.advanceTimersByTime(702); });
        expect(document.querySelector('[data-testid="dropdown-option-ui_session_pin"]')).not.toBeNull();
        await act(async () => {
            touch(row, 'touchend');
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        });
        expect(navigate).not.toHaveBeenCalled();
    }

    it('cold coarse hold opens the menu and consumes release', async () => {
        const row = await renderRow();
        await longPressAndCheckRelease(row);
    });

    it('keeps short-tap Session navigation', async () => {
        const row = await renderRow();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await act(async () => {
            touch(row, 'touchstart');
            vi.advanceTimersByTime(50);
            touch(row, 'touchend');
            row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        });
        expect(navigate).toHaveBeenCalledTimes(1);
    });

    it('updates a mounted fine-pointer row when the primary pointer becomes coarse', async () => {
        media.setCoarse(false);
        expect(isHappierTouchPrimaryPointer('web')).toBe(false);
        const row = await renderRow();
        await act(async () => media.setCoarse(true));
        expect(isHappierTouchPrimaryPointer('web')).toBe(true);
        await longPressAndCheckRelease(row);
    });
});
