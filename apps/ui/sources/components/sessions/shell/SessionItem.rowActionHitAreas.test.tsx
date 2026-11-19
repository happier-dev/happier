import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { hitAreaOverlap, layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import {
    createModelBackedSessionItemTestComponent,
} from './sessionItemRowViewModelTestFixture';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => importOriginal(),
});
vi.mock('react-native-gesture-handler', () => ({
    Swipeable: 'Swipeable',
}));

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');

const { renderScreen: renderCanonicalScreen } = await import('@/dev/testkit/render/renderScreen');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storage');
let previousStorageState: ReturnType<typeof storage.getState>;
beforeEach(() => { previousStorageState = storage.getState(); });
afterEach(async () => {
    await standardCleanup();
    storage.setState(previousStorageState, true);
});
function renderScreen(...args: Parameters<typeof renderCanonicalScreen>) {
    return renderCanonicalScreen(<InjectedAuthProvider credentials={null}>{args[0]}</InjectedAuthProvider>, args[1]);
}

const { SessionItem } = await import('./SessionItem');
const ModelBackedSessionItem = createModelBackedSessionItemTestComponent(SessionItem);


const ACTION_IDS = [
    'session-item-tag-action',
    'session-item-talk-action',
    'session-item-pin-action',
    'session-item-more-menu',
] as const;

/** A Bot the person can read: the roster then offers Talk beside the tag, pin and More actions. */
function createBotSession(id: string) {
    return createSessionFixture({ id, metadata: { path: '/workspace/bot', host: 'test', bot: { kind: 'bot' } } });
}

describe('SessionItem Bot roster row action hit areas', () => {
    it('gives every trailing action a disjoint, row-bounded hit area on native while each keeps its drawn size', async () => {
        // A native phone: a finger's 44 px target is what the hit areas would reach for.
        const screen = await renderScreen(<HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
            <ModelBackedSessionItem session={createBotSession('bot_1')} serverId="server_a"
                selected={false} compact embedded showTalkAction actionMenuSurface="botsRoster"
                tagsEnabled onSetTags={vi.fn()} onTogglePinned={vi.fn()} />
        </HappierUiPlatformProvider>);
        const reads = await Promise.all(ACTION_IDS.map((id) =>
            layoutHitArea(() => screen.findAll((node: any) => node.props?.testID === id && typeof node.props?.onLayout === 'function')[0], { width: 24, height: 24 })));
        const [tag, talk, pin, more] = reads;
        // The row's gap between neighbouring actions (theme.space.s2).
        const gap = 2;
        for (const [first, second] of [[tag, talk], [talk, pin], [pin, more]] as const) {
            expect(hitAreaOverlap(first!, second!, { axis: 'horizontal', gap })).toBe(0);
        }
        for (const area of reads) {
            // The drawn 24 px control stays; the hit area never reaches into the rows above and below.
            expect(area.drawn).toEqual({ width: 24, height: 24 });
            expect(area.insets.top).toBe(0);
            expect(area.insets.bottom).toBe(0);
            // Facing reach is half the real neighbour gap: targets meet and never overlap.
            expect(area.insets.left).toBe(gap / 2);
            expect(area.insets.right).toBe(gap / 2);
        }
        await screen.unmount();
    });
});
