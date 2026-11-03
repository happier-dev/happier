import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { SessionComposerModel } from '@/components/sessions/composer/sessionComposerModel';
import { PhoneAskSheetProvider, usePhoneAskSheetState } from '@/components/sessions/composer/phoneAsk/phoneAskSheetState';

import { resolveSessionCockpitComposerRenderer } from './sessionCockpitComposerRenderer';

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});

function ComposerContent() {
    return <View testID="composer-content" />;
}

const composer: SessionComposerModel = {
    content: <ComposerContent />,
    ref: { kind: 'session', sessionId: 's1' },
    address: { serverId: 'home', sessionId: 's1' },
    sending: false,
    focus: () => {},
};

function ComposerSlot() {
    const renderComposer = resolveSessionCockpitComposerRenderer('chat');
    return <>{renderComposer ? renderComposer(composer) : composer.content}</>;
}

function Cockpit({ phone }: Readonly<{ phone: boolean }>) {
    const state = usePhoneAskSheetState(phone);
    return <PhoneAskSheetProvider value={state}><ComposerSlot /></PhoneAskSheetProvider>;
}

describe('Session cockpit composer placement', () => {
    it('keeps the mounted composer across desktop → phone → desktop breakpoint changes', async () => {
        const screen = await renderScreen(<Cockpit phone={false} />);
        const original = screen.findHostByTestId('composer-content');
        expect(original).not.toBeNull();

        await screen.update(<Cockpit phone />);
        expect(screen.findHostByTestId('composer-content') === original).toBe(true);

        await screen.update(<Cockpit phone={false} />);
        expect(screen.findHostByTestId('composer-content') === original).toBe(true);
    });
});
