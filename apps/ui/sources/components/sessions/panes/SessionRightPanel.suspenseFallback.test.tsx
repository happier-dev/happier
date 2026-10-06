import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

const moduleAdmission = vi.hoisted(() => {
    let release: () => void = () => {};
    let admitted: () => void = () => {};
    return {
        pending: new Promise<void>((resolve) => { release = resolve; }),
        loaded: new Promise<void>((resolve) => { admitted = resolve; }),
        release: () => release(),
        admitted: () => admitted(),
    };
});

// Metro/module admission is the boundary: retain the real module and its view behavior.
vi.mock('@/components/sessions/collaboration/SessionCollaborationSurface', async (importOriginal) => {
    await moduleAdmission.pending;
    try {
        return await importOriginal<typeof import('@/components/sessions/collaboration/SessionCollaborationSurface')>();
    } finally {
        moduleAdmission.admitted();
    }
});

const runtime = installSessionPaneRuntimeTestHarness({
    features: () => createRootLayoutFeaturesResponse({
        features: { sharing: { session: { enabled: true }, public: { enabled: false } } },
    }),
});

describe('SessionRightPanel (module admission fallback)', () => {
    it('keeps loading chrome while the admitted Collaboration module loads, then renders its real surface', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const screen = await renderScreen(<runtime.Wrapper>
            <SessionRightPanel sessionId="s1" scopeId="session:s1" />
        </runtime.Wrapper>);
        try {
            expect(screen.findHostByTestId('session-rightpanel-tab:collaboration')).not.toBeNull();
            await act(async () => runtime.pane.openRight({ tabId: 'collaboration' }));
            const panel = screen.findHostByTestId('session-rightpanel-surface-collaboration');
            expect(panel).not.toBeNull();
            expect(screen.findHostByTestId('session-collaboration-loading')).not.toBeNull();
            expect(screen.getTextContent()).toContain('common.loading');
            expect(screen.findHostByTestId('session-collaboration-surface')).toBeNull();
            await act(async () => {
                moduleAdmission.release();
                await moduleAdmission.loaded;
            });
            expect(screen.findHostByTestId('session-collaboration-loading')).toBeNull();
            expect(screen.findHostByTestId('session-collaboration-surface')).not.toBeNull();
            expect(screen.findHostByTestId('session-rightpanel-surface-collaboration')).toBe(panel);
        } finally {
            moduleAdmission.release();
        }
    });
});
