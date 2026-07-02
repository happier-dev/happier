import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionShellCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: () => React.createElement('RecoveryKeyReminderBanner'),
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: () => React.createElement('UpdateBanner'),
}));

describe('SessionsListHeader update banner', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders the update banner in the session list header notice stack', async () => {
        const { SessionsListHeader } = await import('./sessionListChrome');

        const screen = await renderScreen(<SessionsListHeader />);

        expect(screen.findByType('RecoveryKeyReminderBanner' as never)).toBeTruthy();
        expect(screen.findByType('UpdateBanner' as never)).toBeTruthy();
    });
});
