import { isLargeTextInputValueLength } from '@/components/ui/forms/largeTextInputPolicy';
import { addBreadcrumbIfEnabled, captureExceptionIfEnabled } from './sentry';

type PlatformName = 'web' | 'ios' | 'android' | 'native' | string;
type LargeTextInputSurface = 'agentInput' | string;

type TextSelection = Readonly<{
    start: number;
    end: number;
}>;

export type LargeTextInputDiagnosticPhase =
    | 'web-change'
    | 'web-props-reconcile'
    | 'web-stale-props-skip'
    | 'native-change'
    | 'native-clipboard-paste'
    | 'native-content-size'
    | 'native-window-change'
    | 'selection-restore'
    | 'send-flush';

export type LargeTextInputDiagnostic = Readonly<{
    phase: LargeTextInputDiagnosticPhase;
    platform: PlatformName;
    surface: LargeTextInputSurface;
    textLength: number;
    selection?: TextSelection;
    valueLength?: number;
    liveTextLength?: number;
    lastEmittedTextLength?: number;
    pendingTextLength?: number;
    contentHeight?: number;
    maxHeight?: number;
    durationMs?: number;
    nowMs?: number;
}>;

type RefreshDiagnosticContext = Readonly<{
    action: string;
    screen: string;
    durationMs?: number;
    nowMs?: () => number;
}>;

const LARGE_TEXT_INPUT_DIAGNOSTIC_MIN_INTERVAL_MS = 1_000;
const lastLargeTextInputBreadcrumbByKey = new Map<string, number>();

function finiteNumber(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
    const numberValue = finiteNumber(value);
    return typeof numberValue === 'number' ? Math.max(0, Math.trunc(numberValue)) : undefined;
}

function boundedDuration(value: number | undefined): number | undefined {
    const numberValue = finiteNumber(value);
    if (typeof numberValue !== 'number') return undefined;
    return Math.max(0, Math.round(numberValue * 100) / 100);
}

function shouldRecordLargeTextBreadcrumb(key: string, nowMs: number): boolean {
    const previous = lastLargeTextInputBreadcrumbByKey.get(key);
    if (typeof previous === 'number' && nowMs - previous < LARGE_TEXT_INPUT_DIAGNOSTIC_MIN_INTERVAL_MS) {
        return false;
    }
    lastLargeTextInputBreadcrumbByKey.set(key, nowMs);
    return true;
}

export function resetUserInteractionDiagnosticsForTests(): void {
    lastLargeTextInputBreadcrumbByKey.clear();
}

export function recordLargeTextInputDiagnostic(event: LargeTextInputDiagnostic): void {
    const textLength = nonNegativeInteger(event.textLength);
    if (typeof textLength !== 'number' || !isLargeTextInputValueLength(textLength)) return;

    const nowMs = finiteNumber(event.nowMs) ?? Date.now();
    const throttleKey = `${event.surface}:${event.platform}:${event.phase}`;
    if (!shouldRecordLargeTextBreadcrumb(throttleKey, nowMs)) return;

    addBreadcrumbIfEnabled({
        category: 'agent_input.large_text',
        level: 'info',
        message: 'agent input large text event',
        data: {
            durationMs: boundedDuration(event.durationMs),
            liveTextLength: nonNegativeInteger(event.liveTextLength),
            pendingTextLength: nonNegativeInteger(event.pendingTextLength),
            phase: event.phase,
            platform: event.platform,
            selectionEnd: nonNegativeInteger(event.selection?.end),
            selectionStart: nonNegativeInteger(event.selection?.start),
            surface: event.surface,
            textLength,
            valueLength: nonNegativeInteger(event.valueLength),
            lastEmittedTextLength: nonNegativeInteger(event.lastEmittedTextLength),
            contentHeight: nonNegativeInteger(event.contentHeight),
            maxHeight: nonNegativeInteger(event.maxHeight),
        },
    });
}

export function recordRefreshDiagnosticBreadcrumb(
    phase: 'start' | 'success' | 'failure',
    context: RefreshDiagnosticContext,
): void {
    addBreadcrumbIfEnabled({
        category: 'ui.refresh',
        level: phase === 'failure' ? 'error' : 'info',
        message: `ui refresh ${phase}`,
        data: {
            action: context.action,
            durationMs: boundedDuration(context.durationMs),
            phase,
            screen: context.screen,
        },
    });
}

export function captureRefreshFailureDiagnostic(error: unknown, context: RefreshDiagnosticContext): void {
    captureExceptionIfEnabled(error, {
        tags: {
            'happier.ui.action': context.action,
            'happier.ui.diagnostic': 'refresh_failure',
            'happier.ui.screen': context.screen,
        },
        extra: {
            action: context.action,
            durationMs: boundedDuration(context.durationMs),
            screen: context.screen,
        },
    });
}

export async function runRefreshDiagnosticAction<T>(
    context: RefreshDiagnosticContext,
    action: () => Promise<T>,
): Promise<T> {
    const readNowMs = context.nowMs ?? Date.now;
    const startedAtMs = readNowMs();
    recordRefreshDiagnosticBreadcrumb('start', context);
    try {
        const result = await action();
        recordRefreshDiagnosticBreadcrumb('success', {
            ...context,
            durationMs: readNowMs() - startedAtMs,
        });
        return result;
    } catch (error) {
        const failureContext = {
            ...context,
            durationMs: readNowMs() - startedAtMs,
        };
        recordRefreshDiagnosticBreadcrumb('failure', failureContext);
        captureRefreshFailureDiagnostic(error, failureContext);
        throw error;
    }
}
