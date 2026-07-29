import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { setPreferredLanguageFromSettings } from '@/text';
import { lightTheme } from '@/theme';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/components/ui/status/StatusPill', () => ({
    StatusPill: 'StatusPill',
}));

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

describe('buildExternalSessionBrowseCandidatePresentation localization', () => {
    afterEach(() => {
        setPreferredLanguageFromSettings(null);
        vi.restoreAllMocks();
    });

    it('uses the active non-English locale for compact now and ago metadata', async () => {
        const nowMs = 1_700_000_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(nowMs);
        setPreferredLanguageFromSettings('es');
        const { buildExternalSessionBrowseCandidateSubtitle } = await import('./buildExternalSessionBrowseCandidatePresentation');

        const nowSubtitle = buildExternalSessionBrowseCandidateSubtitle({
            remoteSessionId: 'session-recent',
            updatedAtMs: nowMs - 30_000,
        }, lightTheme, 'compact');
        const agoSubtitle = buildExternalSessionBrowseCandidateSubtitle({
            remoteSessionId: 'session-older',
            updatedAtMs: nowMs - 5 * 60_000,
        }, lightTheme, 'compact');
        const screen = await renderScreen(
            React.createElement('View', null, nowSubtitle, agoSubtitle),
        );
        const content = screen.getTextContent();

        expect(content).toContain('ahora');
        expect(content).toContain('hace 5m');
        expect(content).not.toContain('now');
        expect(content).not.toContain('5m ago');
    });
});
