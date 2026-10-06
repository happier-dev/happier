import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '@/log';
import type { UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { saveWorkflowDocument } from '@/sync/domains/workflows/workflowDocumentFile';
import { exportBugReportDiagnosticsBundle } from '@/components/settings/bugReports/bugReportExport';
import { exportUsageTextDocument } from '@/components/settings/usage/usageExportFile';
import { buildUsageRecapCardSummaryText, shareUsageRecapCardImage } from '@/components/settings/usage/usageAnalyticsExport';

const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return { ...await createReactNativeWebMock(), Platform: platform };
});
const fs = await vi.hoisted(async () => {
    const { createExpoFileSystemFileMock } = await import('@/dev/testkit/mocks/expoFileSystem');
    return createExpoFileSystemFileMock();
});
const sdk = vi.hoisted(() => ({ available: true, share: vi.fn(), capture: vi.fn(), releaseCapture: vi.fn(), copy: vi.fn() }));
vi.mock('expo-file-system', () => fs.module);
vi.mock('expo-file-system/legacy', () => ({
    cacheDirectory: 'file:///cache/', EncodingType: { UTF8: 'utf8' },
    writeAsStringAsync: async (uri: string, text: string) => { fs.files.set(uri, [...new TextEncoder().encode(text)]); },
    copyAsync: async (options: { from: string; to: string }) => {
        sdk.copy(options);
        const bytes = fs.files.get(options.from);
        if (!bytes) throw new Error('Capture unavailable');
        expect(fs.close).toHaveBeenCalledWith(options.to);
        fs.files.set(options.to, [...bytes]);
    },
}));
vi.mock('expo-sharing', () => ({
    isAvailableAsync: async () => sdk.available,
    shareAsync: async (uri: string, options?: { mimeType?: string; UTI?: string; dialogTitle?: string }) => {
        await sdk.share({ uri, ...options, bytes: fs.files.get(uri) });
    },
}));
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierFileActions' ? {
        shareFile: async (uri: string, name: string, mimeType?: string, dialogTitle?: string) => {
            await sdk.share({ uri, name, mimeType, dialogTitle, bytes: fs.files.get(uri) });
        },
    } : null,
}));
vi.mock('react-native-view-shot', () => ({
    captureRef: async () => {
        sdk.capture();
        // The installed SDK returns a raw iOS temporary path and an Android file URI.
        return platform.OS === 'ios' ? '/tmp/ReactNative/capture.png' : 'file:///tmp/capture.png';
    },
    releaseCapture: (uri: string) => { sdk.releaseCapture(uri); fs.files.delete(uri); },
}));
afterEach(() => {
    fs.files.clear();
    sdk.available = true;
    vi.clearAllMocks();
    sdk.share.mockReset();
    platform.OS = 'ios';
});
const response: UsageAnalyticsQueryResponse = {
    v: 1,
    totals: {
        eventCount: 3,
        tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
        cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    },
    series: [{
        bucketStartMs: 1_700_000_000_000,
        bucketEndMs: 1_700_086_400_000,
        eventCount: 3,
        tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
        cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD', costSource: 'provider_reported', billingContext: 'api_usage' },
    }],
    breakdowns: {
        agent: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' } }],
        model: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 2, tokens: { input: 80, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 125 }, cost: { reportedUsd: 11, estimatedUsd: 7, invoiceUsd: 0, currency: 'USD' } }],
        session: [{ key: 'session-a', label: 'Session A', eventCount: 2, tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 }, cost: { reportedUsd: 6, estimatedUsd: 4, invoiceUsd: 0, currency: 'USD' } }],
        project: [{ key: 'project-a', label: 'Project A', eventCount: 2, tokens: { input: 40, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 65 }, cost: { reportedUsd: 6, estimatedUsd: 4, invoiceUsd: 0, currency: 'USD' } }],
        workspace: [{ key: 'workspace-a', label: 'Workspace A', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' } }],
        backendMode: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' } }],
        source: [{ key: 'claude_sdk', label: 'Claude SDK', eventCount: 3, tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 }, cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' } }],
    },
    insights: {
        activeDays: 2,
        longestStreakDays: 2,
        sessionsUsed: 2,
        messagesUsed: 12,
        modelsTried: 2,
        favoriteModel: { key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet' },
        favoriteModelChangeCount: 3,
        busiestMonth: { key: '2024-04', label: 'Apr 2024' },
        busiestDay: { key: '2024-04-25', label: 'Thu' },
        busiestHour: { key: '13', label: '1 PM' },
    },
    activity: {
        calendarDays: [
            { date: '2024-04-24', eventCount: 1 },
            { date: '2024-04-25', eventCount: 2 },
        ],
        weekdayHourBuckets: [
            { weekday: 4, hour: 13, eventCount: 2 },
            { weekday: 5, hour: 14, eventCount: 1 },
        ],
    },
    leaders: {
        agents: [{ key: 'anthropic', label: 'Anthropic', eventCount: 3 }],
        models: [{ key: 'claude-3.7-sonnet', label: 'Claude 3.7 Sonnet', eventCount: 2 }],
        sessions: [{ key: 'session-a', label: 'Session A', eventCount: 2 }],
        projects: [{ key: 'project-a', label: 'Project A', eventCount: 2 }],
        workspaces: [{ key: 'workspace-a', label: 'Workspace A', eventCount: 3 }],
        engines: [{ key: 'claude:remote', label: 'Claude Remote', eventCount: 3 }],
    },
    modelTimeline: [{
        bucketStartMs: 1_700_000_000_000,
        bucketEndMs: 1_700_086_400_000,
        leaders: [{
            key: 'claude-3.7-sonnet',
            label: 'Claude 3.7 Sonnet',
            eventCount: 2,
            tokens: { input: 80, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 125 },
            cost: { reportedUsd: 11, estimatedUsd: 7, invoiceUsd: 0, currency: 'USD' },
        }],
    }],
    engineTimeline: [{
        bucketStartMs: 1_700_000_000_000,
        bucketEndMs: 1_700_086_400_000,
        leaders: [{
            key: 'claude:remote',
            label: 'Claude Remote',
            eventCount: 3,
            tokens: { input: 90, output: 30, reasoning: 10, cacheRead: 5, cacheWrite: 0, total: 135 },
            cost: { reportedUsd: 12, estimatedUsd: 8, invoiceUsd: 0, currency: 'USD' },
        }],
    }],
    messageStats: {
        sessionCount: 2,
        messageCount: 12,
    },
    costPresentation: {
        mode: 'reported',
        effectiveUsd: 12,
        currency: 'USD',
        source: 'provider_reported',
    },
};


const documents = [
    {
        kind: 'workflow', name: 'review.workflow.json', mimeType: 'application/json',
        export: async () => { await saveWorkflowDocument({ fileName: 'review.workflow.json', json: '{"kind":"happier.workflow"}' }); },
        read: (text: string) => expect(JSON.parse(text)).toEqual({ kind: 'happier.workflow' }),
    },
    {
        kind: 'usage', name: 'usage.csv', mimeType: 'text/csv',
        export: async () => { expect(await exportUsageTextDocument({ content: 'name,tokens\nAlice,12\n', fileName: 'usage.csv', mimeType: 'text/csv' })).toBe(true); },
        read: (text: string) => expect(text).toBe('name,tokens\nAlice,12\n'),
    },
    {
        kind: 'diagnostics', name: undefined, mimeType: 'application/json',
        export: async () => { await exportBugReportDiagnosticsBundle({ environment: { appVersion: '0.3.0', platform: platform.OS, deploymentType: 'cloud' }, artifacts: [{ filename: 'logs.txt', sourceKind: 'ui-mobile', contentType: 'text/plain', content: 'synthetic log' }] }); },
        read: (text: string) => expect(JSON.parse(text).schemaVersion).toBe(1),
    },
];
describe('native export consumers through the cache sharing owner', () => {
    it.each(documents)('shares $kind document bytes with platform custody', async (document) => {
        for (const os of ['android', 'ios']) {
            platform.OS = os;
            sdk.share.mockImplementation((handoff: { uri: string; name?: string; mimeType?: string; UTI?: string; dialogTitle?: string; bytes: number[] }) => {
                document.read(new TextDecoder().decode(new Uint8Array(handoff.bytes)));
                if (document.kind === 'diagnostics') {
                    expect(handoff.dialogTitle).toBeTruthy();
                    if (os === 'ios') expect(handoff.UTI).toBe('public.json');
                }
            });
            await document.export();
            const handoff = sdk.share.mock.calls.at(-1)![0];
            expect(handoff.uri).toContain('/happier-downloads/');
            expect(handoff.mimeType).toBe(document.mimeType);
            if (os === 'android' && document.name) expect(handoff.name).toBe(document.name);
            expect(fs.files.has(handoff.uri)).toBe(os === 'android');
            fs.files.clear();
            sdk.share.mockReset();
        }
    });
    it('removes a rejected diagnostic handoff and preserves its error', async () => {
        platform.OS = 'android';
        sdk.share.mockRejectedValue(new Error('Recipient unavailable'));
        await expect(documents[2].export()).rejects.toThrow('Recipient unavailable');
        expect(fs.files.size).toBe(0);
    });
    it.each(['ios', 'android'])('copies a captured PNG into recipient custody on %s and releases the original', async (os) => {
        platform.OS = os;
        const bytes = [137, 80, 78, 71, 255];
        const captureUri = os === 'ios' ? '/tmp/ReactNative/capture.png' : 'file:///tmp/capture.png';
        fs.files.set(captureUri, bytes);
        sdk.share.mockImplementation((handoff: { bytes: number[] }) => { expect(handoff.bytes).toEqual(bytes); });
        expect(await shareUsageRecapCardImage({
            viewModel: buildUsageAnalyticsViewModel(response, { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' }),
            filters: { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' },
            cardId: 'usage', node: {},
        })).toBe(true);
        const handoff = sdk.share.mock.calls.at(-1)![0];
        expect(handoff.uri).toContain('/happier-downloads/');
        expect(handoff.mimeType).toBe('image/png');
        expect(fs.files.has(handoff.uri)).toBe(os === 'android');
        expect(fs.files.has(captureUri)).toBe(false);
        expect(sdk.releaseCapture).toHaveBeenCalledWith(captureUri);
    });
    it('releases a failed capture copy, preserves the text fallback, and records its fault', async () => {
        const priorLogs = log.getLogs().length;
        const captureUri = '/tmp/ReactNative/capture.png';
        fs.files.set(captureUri, [137, 80, 78, 71]);
        sdk.copy.mockImplementationOnce((options: { from: string; to: string }) => {
            // SDK55 iOS removes an existing destination before copyItemAtPath.
            fs.files.delete(options.to);
            throw new Error('synthetic_capture_copy_fault');
        });
        expect(await shareUsageRecapCardImage({
            viewModel: buildUsageAnalyticsViewModel(response, { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' }),
            filters: { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' },
            cardId: 'usage', node: {},
        })).toBe(true);
        const handoff = sdk.share.mock.calls.at(-1)![0];
        expect(new TextDecoder().decode(new Uint8Array(handoff.bytes))).toBe(buildUsageRecapCardSummaryText({
            viewModel: buildUsageAnalyticsViewModel(response, { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' }),
            filters: { period: '30days', metric: 'tokens', focus: null, costMode: 'auto' }, cardId: 'usage',
        }));
        expect(handoff.uri).toMatch(/\.txt$/);
        expect(fs.files.size).toBe(0);
        expect(sdk.releaseCapture).toHaveBeenCalledWith(captureUri);
        expect(log.getLogs().slice(priorLogs).join(' ')).toContain('synthetic_capture_copy_fault');
    });

});
