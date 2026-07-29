import { describe, expect, it, vi } from 'vitest';

import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';

const addBreadcrumbIfEnabledMock = vi.hoisted(() => vi.fn());
const captureExceptionIfEnabledMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/system/sentry', () => ({
    addBreadcrumbIfEnabled: (...args: unknown[]) => addBreadcrumbIfEnabledMock(...args),
    captureExceptionIfEnabled: (...args: unknown[]) => captureExceptionIfEnabledMock(...args),
}));

describe('userInteractionDiagnostics', () => {
    it('records throttled large-text input breadcrumbs with metadata only', async () => {
        const {
            resetUserInteractionDiagnosticsForTests,
            recordLargeTextInputDiagnostic,
        } = await import('./userInteractionDiagnostics');
        resetUserInteractionDiagnosticsForTests();
        addBreadcrumbIfEnabledMock.mockReset();

        recordLargeTextInputDiagnostic({
            phase: 'web-change',
            platform: 'web',
            surface: 'agentInput',
            textLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1,
            selection: { start: 42, end: 42 },
            valueLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT,
            liveTextLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1,
            pendingTextLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1,
            durationMs: 12.75,
            nowMs: 1_000,
        });
        recordLargeTextInputDiagnostic({
            phase: 'web-change',
            platform: 'web',
            surface: 'agentInput',
            textLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 2,
            selection: { start: 43, end: 43 },
            valueLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT,
            liveTextLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 2,
            pendingTextLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 2,
            durationMs: 13,
            nowMs: 1_100,
        });

        expect(addBreadcrumbIfEnabledMock).toHaveBeenCalledTimes(1);
        expect(addBreadcrumbIfEnabledMock).toHaveBeenCalledWith({
            category: 'agent_input.large_text',
            level: 'info',
            message: 'agent input large text event',
            data: {
                durationMs: 12.75,
                liveTextLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1,
                pendingTextLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1,
                phase: 'web-change',
                platform: 'web',
                selectionEnd: 42,
                selectionStart: 42,
                surface: 'agentInput',
                textLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1,
                valueLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT,
            },
        });
        expect(JSON.stringify(addBreadcrumbIfEnabledMock.mock.calls)).not.toContain('SECRET');
    });

    it('does not record large-text input breadcrumbs for normal-size text', async () => {
        const {
            resetUserInteractionDiagnosticsForTests,
            recordLargeTextInputDiagnostic,
        } = await import('./userInteractionDiagnostics');
        resetUserInteractionDiagnosticsForTests();
        addBreadcrumbIfEnabledMock.mockReset();

        recordLargeTextInputDiagnostic({
            phase: 'web-change',
            platform: 'web',
            surface: 'agentInput',
            textLength: TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT,
            selection: { start: 1, end: 1 },
            nowMs: 2_000,
        });

        expect(addBreadcrumbIfEnabledMock).not.toHaveBeenCalled();
    });

    it('captures refresh failures with action metadata only', async () => {
        const { captureRefreshFailureDiagnostic } = await import('./userInteractionDiagnostics');
        captureExceptionIfEnabledMock.mockReset();
        const error = new Error('refresh failed');

        captureRefreshFailureDiagnostic(error, {
            action: 'pull_to_refresh',
            screen: 'machine_detail',
            durationMs: 25.2,
        });

        expect(captureExceptionIfEnabledMock).toHaveBeenCalledWith(error, {
            tags: {
                'happier.ui.action': 'pull_to_refresh',
                'happier.ui.diagnostic': 'refresh_failure',
                'happier.ui.screen': 'machine_detail',
            },
            extra: {
                action: 'pull_to_refresh',
                durationMs: 25.2,
                screen: 'machine_detail',
            },
        });
    });

    it('records refresh action start, success, and failure without swallowing errors', async () => {
        const {
            resetUserInteractionDiagnosticsForTests,
            runRefreshDiagnosticAction,
        } = await import('./userInteractionDiagnostics');
        resetUserInteractionDiagnosticsForTests();
        addBreadcrumbIfEnabledMock.mockReset();
        captureExceptionIfEnabledMock.mockReset();

        await expect(runRefreshDiagnosticAction({
            action: 'pull_to_refresh',
            screen: 'machine_detail',
            nowMs: () => 100,
        }, async () => 'ok')).resolves.toBe('ok');

        const error = new Error('refresh failed');
        await expect(runRefreshDiagnosticAction({
            action: 'pull_to_refresh',
            screen: 'machine_detail',
            nowMs: (() => {
                const values = [200, 275];
                return () => values.shift() ?? 275;
            })(),
        }, async () => {
            throw error;
        })).rejects.toBe(error);

        expect(addBreadcrumbIfEnabledMock).toHaveBeenNthCalledWith(1, {
            category: 'ui.refresh',
            level: 'info',
            message: 'ui refresh start',
            data: {
                action: 'pull_to_refresh',
                durationMs: undefined,
                phase: 'start',
                screen: 'machine_detail',
            },
        });
        expect(addBreadcrumbIfEnabledMock).toHaveBeenNthCalledWith(2, {
            category: 'ui.refresh',
            level: 'info',
            message: 'ui refresh success',
            data: {
                action: 'pull_to_refresh',
                durationMs: 0,
                phase: 'success',
                screen: 'machine_detail',
            },
        });
        expect(addBreadcrumbIfEnabledMock).toHaveBeenNthCalledWith(4, {
            category: 'ui.refresh',
            level: 'error',
            message: 'ui refresh failure',
            data: {
                action: 'pull_to_refresh',
                durationMs: 75,
                phase: 'failure',
                screen: 'machine_detail',
            },
        });
        expect(captureExceptionIfEnabledMock).toHaveBeenCalledWith(error, {
            tags: {
                'happier.ui.action': 'pull_to_refresh',
                'happier.ui.diagnostic': 'refresh_failure',
                'happier.ui.screen': 'machine_detail',
            },
            extra: {
                action: 'pull_to_refresh',
                durationMs: 75,
                screen: 'machine_detail',
            },
        });
    });
});
