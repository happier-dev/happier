import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installBugReportHooksCommonModuleMocks } from './bugReportHooksTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertMock = vi.fn(async () => {});
const routerBackMock = vi.fn();
installBugReportHooksCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: modalAlertMock,
                confirm: vi.fn(async () => false),
            },
        }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                back: routerBackMock,
                push: vi.fn(),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

vi.mock('@/utils/system/bugReportActionTrail', () => ({
  recordBugReportUserAction: vi.fn(),
  clearBugReportUserActionTrail: vi.fn(),
}));

vi.mock('@/utils/system/bugReportLogBuffer', () => ({
  clearBugReportLogBuffer: vi.fn(),
}));

const clearPreRestartBugReportSnapshotMock = vi.fn(async () => {});
vi.mock('@/utils/system/preRestartBugReportSnapshot', () => ({
  clearPreRestartBugReportSnapshot: clearPreRestartBugReportSnapshotMock,
}));

vi.mock('../openBugReportFallback', () => ({
  openBugReportFallbackIssueUrl: vi.fn(async () => {}),
  openBugReportIssueUrlSilently: vi.fn(),
}));

const validateBugReportDraftMock = vi.fn(() => ({ code: 'ok' as const }));
const submitBugReportFromDraftMock = vi.fn(async () => ({
  mode: 'submitted' as const,
  reportId: 'report_1',
  issueNumber: 123,
  issueUrl: 'https://example.com/issues/123',
  artifactCount: 0,
}));
vi.mock('../bugReportSubmissionFlow', () => ({
  validateBugReportDraft: validateBugReportDraftMock,
  submitBugReportFromDraft: submitBugReportFromDraftMock,
}));

vi.mock('../bugReportServiceClient', () => ({
  submitBugReportToService: vi.fn(async () => ({ reportId: 'report_1', issueNumber: 123, issueUrl: 'https://example.com/issues/123' })),
}));

describe('useBugReportComposerSubmit', () => {
  beforeEach(() => {
    modalAlertMock.mockClear();
    routerBackMock.mockClear();
    clearPreRestartBugReportSnapshotMock.mockClear();
    validateBugReportDraftMock.mockClear();
    submitBugReportFromDraftMock.mockClear();
  });

  it('clears the pre-restart bug report snapshot after a successful submission', async () => {
    const { useBugReportComposerSubmit } = await import('./useBugReportComposerSubmit');

    function TestComponent() {
      const { handleSubmit } = useBugReportComposerSubmit({
        feature: {
          enabled: true,
          providerUrl: 'https://example.com/provider',
          defaultIncludeDiagnostics: true,
          maxArtifactBytes: 128_000,
          acceptedArtifactKinds: ['ui-mobile'],
          uploadTimeoutMs: 10_000,
          contextWindowMs: 30_000,
        } as any,
        machines: [],
        route: '/settings/report-issue',
        includeDiagnostics: false,
        diagnosticsKinds: [],
        issueOwner: 'happier-dev',
        issueRepo: 'happier',
        existingIssueNumber: null,
        openFallbackIssue: async () => {},
        buildDraftInput: () => ({
          title: 'Crash report',
          summary: 'App crashed.',
          reproductionStepsText: '',
          whatChangedRecently: '',
          environment: { appVersion: '1.2.3', platform: 'ios', deploymentType: 'cloud' },
          includeDiagnostics: false,
          acceptedPrivacyNotice: true,
        }),
      });

      return React.createElement('Text', { onPress: handleSubmit });
    }

    let tree: renderer.ReactTestRenderer;
    tree = (await renderScreen(<TestComponent />)).tree;

    const button = tree!.findByType('Text' as any);
    await act(async () => {
      await pressTestInstanceAsync(button);
    });

    expect(clearPreRestartBugReportSnapshotMock).toHaveBeenCalledTimes(1);
    expect(routerBackMock).toHaveBeenCalledTimes(1);
  });
});
