import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeNativeMock({ platformOS: 'android' }));

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) =>
        key === 'inbox.openSession' ? `Open session: ${params?.session}` : key,
}));

describe('InboxSessionAttentionHeader', () => {
    afterEach(standardCleanup);
    it('names the destination and provides the Android minimum target after Voice ends', async () => {
        const { InboxSessionAttentionHeader } = await import('./InboxSessionAttentionHeader');
        const screen = await renderScreen(
            <InboxSessionAttentionHeader
                session={createSessionFixture({ id: 'session-1' })}
                serverId={null}
                identityDisplay="none"
                connected={false}
                sessionTitle="Fix login"
                machineLabel={null}
                pathLabel={null}
                onOpenSession={() => {}}
            />,
        );

        const button = screen.tree.findByType('Pressable');
        const style = button.props.style({ pressed: false });
        const flattened = Object.assign({}, ...style.filter(Boolean));
        expect(button.props.accessibilityLabel).toBe('Open session: Fix login');
        expect(flattened.width).toBeGreaterThanOrEqual(48);
        expect(flattened.height).toBeGreaterThanOrEqual(48);
    });
});
