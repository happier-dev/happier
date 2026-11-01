import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { installBugReportHooksCommonModuleMocks } from './bugReportHooksTestHelpers';
import type { BugReportsFeature } from '../bugReportFeatureDefaults';
import type { BugReportComposerSubmissionInput } from '../bugReportSubmissionFlow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlert = vi.fn(async () => {});
const routerBack = vi.fn();
const openUrl = vi.fn(async () => {});
installBugReportHooksCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { alert: modalAlert, confirm: vi.fn(async () => false) } }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { back: routerBack, push: vi.fn() } }).module;
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({ Linking: { openURL: openUrl } });
    },
});
vi.mock('expo-file-system', async () => {
    const { createExpoFileSystemMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemMock().module;
});
// Native SDK boundaries stay inert; the real consent, submission and persistence owners run.
vi.mock('@sentry/react-native', () => ({}));
vi.mock('expo-application', () => ({}));

const snapshotKey = 'happier_pre_restart_bug_report_snapshot_v1';
const saved = new Map<string, string>();
const feature: BugReportsFeature = {
    enabled: true, providerUrl: 'https://report-service.example.test', defaultIncludeDiagnostics: true,
    maxArtifactBytes: 128_000, acceptedArtifactKinds: ['ui-mobile'], uploadTimeoutMs: 10_000, contextWindowMs: 30_000,
};
const draft: BugReportComposerSubmissionInput = {
    title: 'Crash report', summary: 'App crashed.', currentBehavior: 'User-edited exception',
    reproductionStepsText: '', whatChangedRecently: '',
    environment: { appVersion: '1.2.3', platform: 'web', deploymentType: 'cloud' },
    includeDiagnostics: false, acceptedPrivacyNotice: false,
};

beforeEach(() => {
    vi.clearAllMocks();
    saved.clear();
    saved.set(snapshotKey, 'saved original exception');
    vi.stubGlobal('__HAPPIER_CRASH_REPORTS_OPTOUT__', true);
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => saved.set(key, value),
        removeItem: (key: string) => saved.delete(key),
    });
});
afterEach(() => vi.unstubAllGlobals());

async function renderSubmission(options: { feature?: BugReportsFeature; draft?: BugReportComposerSubmissionInput } = {}) {
    const { useBugReportComposerSubmit } = await import('./useBugReportComposerSubmit');
    return await renderHook(() => useBugReportComposerSubmit({
        feature: options.feature ?? feature, machines: [], route: '/settings/report-issue',
        includeDiagnostics: false, diagnosticsKinds: [], issueOwner: 'happier-dev', issueRepo: 'happier',
        existingIssueNumber: null, openFallbackIssue: async () => {}, buildDraftInput: () => options.draft ?? draft,
    }));
}

describe('useBugReportComposerSubmit', () => {
    it.each([false, true])('keeps the saved crash until the report service confirms success (failure=%s)', async (failSubmission) => {
        const requests: Array<{ url: string; body: unknown }> = [];
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
            requests.push({ url: String(url), body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
            const sessionRequest = String(url).endsWith('/v1/reports/session');
            return new Response(JSON.stringify(sessionRequest
                ? { reportId: 'report_1', uploadTargets: [] }
                : { reportId: 'report_1', issueNumber: 123, issueUrl: 'https://example.test/issues/123' }),
            { status: !sessionRequest && failSubmission ? 503 : 200, headers: { 'content-type': 'application/json' } });
        }));
        const hook = await renderSubmission();
        await act(async () => hook.getCurrent().handleSubmit());
        expect(requests[0]?.body).toMatchObject({ form: { currentBehavior: 'User-edited exception' }, artifacts: [] });
        expect(JSON.stringify(requests)).not.toContain('saved original exception');
        expect(saved.has(snapshotKey)).toBe(failSubmission);
        expect(routerBack).toHaveBeenCalledTimes(failSubmission ? 0 : 1);
        expect(hook.getCurrent().submitting).toBe(false);
    });

    it('retains the saved crash when opening the public-issue fallback', async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        vi.stubGlobal('fetch', fetch);
        const hook = await renderSubmission({ feature: { ...feature, enabled: false } });
        await act(async () => hook.getCurrent().handleSubmit());
        expect(fetch).not.toHaveBeenCalled();
        expect(saved.has(snapshotKey)).toBe(true);
        expect(routerBack).not.toHaveBeenCalled();
    });
});
