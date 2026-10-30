import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installBugReportComponentCommonModuleMocks } from './bugReportComponentTestHelpers';

installBugReportComponentCommonModuleMocks();
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

describe('bug report composer sections', () => {
    it('keeps every exclusion control available while the collector owns source acceptance', async () => {
        const { BugReportDiagnosticsSection } = await import('./BugReportComposerSections');
        const screen = await renderScreen(<BugReportDiagnosticsSection
            includeDiagnostics onIncludeDiagnosticsChange={() => {}}
            onPreviewDiagnostics={() => {}} previewDisabled={false}
            logSelection={{ daemon: true, session: true, provider: false }} onLogSelectionChange={() => {}}
        />);
        expect(screen.findByTestId('bug-report-log-session')?.props.disabled).toBe(false);
        // The grouped operational switch also excludes local app logs, even
        // when this server does not accept the machine's daemon artifact.
        expect(screen.findByTestId('bug-report-log-daemon')?.props.disabled).toBe(false);
        expect(screen.findByTestId('bug-report-log-session')?.props.accessibilityLabel).toBeTruthy();
        expect(screen.findByTestId('bug-report-technical-only')?.props.accessibilityLabel).toBeTruthy();
    });

    it('can exclude every raw log while keeping structured diagnostics enabled', async () => {
        const { BugReportDiagnosticsSection } = await import('./BugReportComposerSections');
        const change = vi.fn();
        const screen = await renderScreen(<BugReportDiagnosticsSection
            includeDiagnostics onIncludeDiagnosticsChange={() => {}}
            onPreviewDiagnostics={() => {}} previewDisabled={false}
            logSelection={{ daemon: true, session: true, provider: false }}
            onLogSelectionChange={change}
        />);
        const toggle = screen.findByTestId('bug-report-technical-only');
        expect(toggle).not.toBeNull();
        await act(async () => toggle!.props.onValueChange(true));
        expect(change).toHaveBeenCalledWith({ daemon: false, session: false, provider: false });
    });

    it('starts with two description fields and reveals optional details without losing edits', async () => {
        const { BugReportIssueDetailsSection } = await import('./BugReportComposerSections');
        const noop = () => {};
        const screen = await renderScreen(<BugReportIssueDetailsSection
            title="Broken session" onTitleChange={noop} summary="The session stopped" onSummaryChange={noop}
            reporterGithubUsername="" onReporterGithubUsernameChange={noop}
            currentBehavior="Edited crash details" onCurrentBehaviorChange={noop}
            expectedBehavior="" onExpectedBehaviorChange={noop}
            reproductionStepsText="" onReproductionStepsTextChange={noop}
            whatChangedRecently="" onWhatChangedRecentlyChange={noop}
            placeholderTextColor="gray" disabled={false}
        />);
        const fields = () => screen.findAll((node) => typeof node.type === 'string' && typeof node.props.onChangeText === 'function');
        expect(fields()).toHaveLength(2);
        expect(fields().every((field) => Boolean(field.props.accessibilityLabel))).toBe(true);
        await act(async () => screen.pressByTestId('bug-report-more-details'));
        expect(fields().map((field) => field.props.value)).toContain('Edited crash details');
        expect(fields()).toHaveLength(7);
    });
});
