import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserAutomationControlService, BrowserAutomationTimelineEntry } from '@/sync/domains/browser/automation';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';

import { BrowserAutomationControls } from './BrowserAutomationControls';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

function createExternalView(): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'https://example.test/',
        },
        platform: 'web',
        adapterKind: 'externalUrl',
        engineKind: 'webIframe',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'externalUrl',
            supportedTargetKinds: ['externalUrl'],
            supportedRenderEngines: ['webIframe'],
        }),
        currentUrl: 'https://example.test/',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Example',
        faviconUrl: null,
        loadingState: 'idle',
        loadingProgress: null,
        navigationGeneration: 2,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: 'https://example.test',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createTimelineEntry(overrides: Partial<BrowserAutomationTimelineEntry>): BrowserAutomationTimelineEntry {
    return {
        timelineEntryId: 'timeline_1',
        automationRequestId: '018f5bcb-2d71-79ef-9f0c-4f822a03e8f4',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        actionKind: 'semanticSnapshot',
        requesterKind: 'agent',
        status: 'policy_denied',
        adapterKind: 'uiLocal',
        fidelity: 'injectedPage',
        trustedInput: false,
        queuedAtMs: 1_000,
        startedAtMs: 1_100,
        finishedAtMs: 1_200,
        durationMs: 100,
        navigationGenerationBefore: 2,
        navigationGenerationAfter: 2,
        controlEpochBefore: 1,
        controlEpochAfter: 1,
        targetSummary: {},
        resultSummary: {},
        ...overrides,
    };
}

function createControlService(
    timeline: readonly BrowserAutomationTimelineEntry[],
): BrowserAutomationControlService {
    return {
        registerOwner: vi.fn(),
        unregisterOwner: vi.fn(),
        closeView: vi.fn(),
        updateNavigationGeneration: vi.fn(),
        acquireLease: vi.fn(),
        executeAction: vi.fn(),
        cancelActiveAction: vi.fn(),
        recordHumanInput: vi.fn(),
        recordSyntheticInput: vi.fn(),
        getActionTimeline: vi.fn(() => timeline),
        subscribe: vi.fn(() => () => undefined),
        getSnapshot: vi.fn(() => ({
            ownersByViewId: {
                view_1: {
                    authority: 'uiLocal',
                    navigationGeneration: 2,
                },
            },
            controllerByViewId: {
                view_1: {
                    controller: 'agent',
                    activeAutomationRequestId: '018f5bcb-2d71-79ef-9f0c-4f822a03e8f4',
                    controlEpoch: 1,
                },
            },
        })),
    };
}

describe('BrowserAutomationControls', () => {
    it('renders product-language status and timeline labels without UUIDs or protocol enum ids', async () => {
        const controlService = createControlService([
            createTimelineEntry({
                actionKind: 'semanticSnapshot',
                status: 'policy_denied',
            }),
        ]);

        const screen = await renderScreen(
            <BrowserAutomationControls
                view={createExternalView()}
                controlService={controlService}
                testID="browser-automation"
            />,
        );

        const text = screen.getTextContent();
        expect(text).not.toContain('018f5bcb-2d71-79ef-9f0c-4f822a03e8f4');
        expect(text).not.toContain('uiLocal');
        expect(text).not.toContain('semanticSnapshot');
        expect(text).not.toContain('policy_denied');
        expect(screen.findByTestId('browser-automation-status-active')).toBeTruthy();
        expect(screen.findByTestId('browser-automation-timeline-status-policy_denied')).toBeTruthy();
    });
});
