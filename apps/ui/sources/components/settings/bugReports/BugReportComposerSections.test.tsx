import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { act } from 'react-test-renderer';
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

// Preload the real section graph during collection, outside an individual test's deadline.
await import('./BugReportComposerSections');

/** Query the way an assistive technology does: find the controls by ROLE, then read their names. */
function switchNames(screen: RenderScreenResult): Array<string | undefined> {
    return screen
        // Rendered (host) nodes only: a component forwarding the same props is not a second control.
        .findAll((node: ReactTestInstance) => (
            typeof node.type === 'string'
            && (node.props?.role === 'switch' || node.props?.accessibilityRole === 'switch')
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

    it('names the independent log controls and keeps every exclusion usable', async () => {
        const { BugReportDiagnosticsSection } = await import('./BugReportComposerSections');
        const changed = vi.fn();
        const screen = await renderScreen(
            <BugReportDiagnosticsSection
                includeDiagnostics
                onIncludeDiagnosticsChange={() => {}}
                logSelection={{ daemon: true, session: true, provider: false }}
                onLogSelectionChange={changed}
                onPreviewDiagnostics={() => {}}
                previewDisabled={false}
            />,
        );
        expect(switchNames(screen)).toEqual([
            'Include diagnostics',
            'bugReports.composer.logOptions.technicalOnly',
            'bugReports.composer.logOptions.daemonTitle',
            'bugReports.composer.logOptions.sessionTitle',
            'bugReports.composer.logOptions.providerTitle',
        ]);
        const daemon = screen.findAll(node => node.props.testID === 'bug-report-log-daemon'
            && typeof node.props.onValueChange === 'function')[0]!;
        expect(daemon.props.disabled).not.toBe(true);
        await act(async () => daemon.props.onValueChange(false));
        expect(changed).toHaveBeenLastCalledWith({ daemon: false, session: true, provider: false });
        const technicalOnly = screen.findAll(node => node.props.testID === 'bug-report-technical-only'
            && typeof node.props.onValueChange === 'function')[0]!;
        await act(async () => technicalOnly.props.onValueChange(true));
        expect(changed).toHaveBeenLastCalledWith({ daemon: false, session: false, provider: false });
    });
});

describe('Bug report similar issues', () => {
    it('keeps saying it is searching while a new search runs over earlier results', async () => {
        const { BugReportSimilarIssuesSection } = await import('./BugReportSimilarIssuesSection');

        const screen = await renderScreen(
            <BugReportSimilarIssuesSection
                loading
                issues={[{ owner: 'happier-dev', repo: 'happier', number: 12, title: 'Crash on open', state: 'open', url: 'https://example.test/12' } as never]}
                selectedIssueNumber={null}
                onSelectedIssueNumberChange={() => {}}
                disabled={false}
            />,
        );

        expect(screen.findByTestId('bug-report-similar-issues-searching')).toBeTruthy();
        // The earlier results stay while the new search runs.
        expect(screen.findByTestId('bug-report-similar-issue-12')).toBeTruthy();
    });
});


describe('Saved crash details', () => {
    it('shows the editable exception before the optional details disclosure opens', async () => {
        const { BugReportMoreDetailSection } = await import('./BugReportComposerSections');
        const screen = await renderScreen(<BugReportMoreDetailSection
            showCurrentBehavior
            currentBehavior="Recognisable saved exception"
            onCurrentBehaviorChange={() => {}}
            reporterGithubUsername="" onReporterGithubUsernameChange={() => {}}
            expectedBehavior="" onExpectedBehaviorChange={() => {}}
            reproductionStepsText="" onReproductionStepsTextChange={() => {}}
            whatChangedRecently="" onWhatChangedRecentlyChange={() => {}}
            disabled={false}
        />);
        expect(screen.findAll((node) => typeof node.type === 'string'
            && node.props.value === 'Recognisable saved exception')).toHaveLength(1);
        expect(screen.findAll((node) => typeof node.type === 'string'
            && node.props.accessibilityLabel === 'bugReports.composer.issueDetails.expectedBehaviorLabel')).toHaveLength(0);
    });
});
