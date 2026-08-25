import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen, type RenderScreenResult } from '@/dev/testkit';

import { installBugReportComponentCommonModuleMocks } from './bugReportComponentTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TRANSLATIONS: Record<string, string> = {
    'bugReports.composer.consent.understandTitle': 'I understand what will be shared',
    'bugReports.composer.diagnostics.includeTitle': 'Include diagnostics',
    'bugReports.composer.diagnostics.kinds.app.title': 'App diagnostics',
    'bugReports.composer.diagnostics.kinds.daemon.title': 'Daemon diagnostics',
    'bugReports.composer.diagnostics.kinds.stackService.title': 'Stack service diagnostics',
    'bugReports.composer.diagnostics.kinds.server.title': 'Server diagnostics',
};

installBugReportComponentCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => TRANSLATIONS[key] ?? key });
    },
});

/**
 * Stand in for the bundler's platform resolution: on web `@/components/ui/forms/Switch`
 * resolves to `Switch.web`, the implementation that carries `role="switch"` into the DOM.
 * Vitest has no `.web.tsx` extension resolution, so the swap is made explicitly.
 */
vi.mock('@/components/ui/forms/Switch', async () => await import('@/components/ui/forms/Switch.web'));

/** Query the way an assistive technology does: find the controls by ROLE, then read their names. */
function switchNames(screen: RenderScreenResult): Array<string | undefined> {
    return screen
        .findAll((node: ReactTestInstance) => (
            node.props?.role === 'switch' || node.props?.accessibilityRole === 'switch'
        ))
        .map((node) => node.props?.['aria-label'] ?? node.props?.accessibilityLabel);
}

describe('Bug report composer toggles (web)', () => {
    it('names the privacy consent toggle so the agreement it records is announced', async () => {
        const { BugReportConsentSection } = await import('./BugReportComposerSections');

        const screen = await renderScreen(
            <BugReportConsentSection
                acceptedPrivacyNotice={false}
                onAcceptedPrivacyNoticeChange={() => {}}
            />,
        );

        expect(switchNames(screen)).toEqual(['I understand what will be shared']);
    });

    it('names every diagnostics toggle by the data it opts the report into', async () => {
        const { BugReportDiagnosticsSection } = await import('./BugReportComposerSections');

        const screen = await renderScreen(
            <BugReportDiagnosticsSection
                includeDiagnostics
                onIncludeDiagnosticsChange={() => {}}
                acceptedKinds={['ui-mobile', 'daemon', 'stack-service', 'server']}
                selectedKinds={['ui-mobile']}
                onSelectedKindsChange={() => {}}
                onPreviewDiagnostics={() => {}}
                previewDisabled={false}
                pastedCliDoctorSnapshotJson=""
                onPastedCliDoctorSnapshotJsonChange={() => {}}
                placeholderTextColor="#888888"
            />,
        );

        expect(switchNames(screen)).toEqual([
            'Include diagnostics',
            'App diagnostics',
            'Daemon diagnostics',
            'Stack service diagnostics',
            'Server diagnostics',
        ]);
    });
});
