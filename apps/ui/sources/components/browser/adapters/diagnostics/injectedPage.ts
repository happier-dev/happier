import {
    INJECTED_CONSOLE_TEXT_MAX_LENGTH,
    INJECTED_OWNER_VALUE_MAX_LENGTH,
    SAFE_TELEMETRY_HEADER_NAMES,
    BrowserDiagnosticEventBatchV1Schema,
    BrowserDiagnosticsElementPickerCommandMessageV1Schema,
    BrowserDiagnosticsElementPickerResultMessageV1Schema,
    BrowserDiagnosticsEvalCommandMessageV1Schema,
    BrowserDiagnosticsEvalResultMessageV1Schema,
    BrowserDiagnosticsGetPropertiesCommandMessageV1Schema,
    BrowserDiagnosticsGetPropertiesResultMessageV1Schema,
    BrowserDiagnosticsReleaseObjectGroupCommandMessageV1Schema,
    BrowserDiagnosticsReleaseObjectGroupResultMessageV1Schema,
    type BrowserDiagnosticEventV1,
    type BrowserDiagnosticsElementPickerCommandMessageV1,
    type BrowserDiagnosticsElementPickerRequestV1,
    type BrowserDiagnosticsElementPickerResultV1,
    type BrowserDiagnosticsEvalCommandMessageV1,
    type BrowserDiagnosticsEvalRequestV1,
    type BrowserDiagnosticsEvalResultV1,
    type BrowserDiagnosticsGetPropertiesCommandMessageV1,
    type BrowserDiagnosticsGetPropertiesRequestV1,
    type BrowserDiagnosticsGetPropertiesResultV1,
    type BrowserDiagnosticsReleaseObjectGroupCommandMessageV1,
    type BrowserDiagnosticsReleaseObjectGroupRequestV1,
    type BrowserDiagnosticsReleaseObjectGroupResultV1,
    redactDiagnosticsHeaders,
    stripUrlValuesInString,
} from '@happier-dev/protocol';
import { buildInjectedBrowserDiagnosticsRuntimeScript } from './injected/build';

type InjectedBrowserDiagnosticsCollectorIdentity = Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    collectorId: string;
    nonce: string;
}>;

export type BuildInjectedBrowserDiagnosticsScriptInput = InjectedBrowserDiagnosticsCollectorIdentity & Readonly<{
    version: string;
    webPostMessageTargetOrigin?: string;
    /**
     * Desktop (Tauri/Wry) delivery: the collector posts batched envelopes back through the Wry
     * `window.ipc.postMessage` channel (the host attaches a native `ipc_handler` that buffers them
     * for `desktop_browser_drain_diagnostics`). Preferred over the web/RN transports when set, since
     * the desktop child webview has neither a parent window nor a ReactNativeWebView bridge.
     */
    desktopIpcDelivery?: boolean;
    /**
     * DEV-2: the LOCAL owner's `browser.diagnostics` value-capture policy. When set, the in-page
     * console collector surfaces a length-capped (`INJECTED_CONSOLE_TEXT_MAX_LENGTH`) `text` rendering
     * of the console arguments and stamps the event `redaction.level = 'none'` (full fidelity for the
     * local owner). When unset (the fail-closed default for non-owner), only `{level,argCount,
     * textAvailable}` metadata is emitted and the level stays `valuesRedacted`. The egress classifier
     * (`INJECTED_OWNER_ONLY_FIELDS`) strips `text` for any agent/remote destination regardless.
     */
    ownerConsoleValueCapture?: boolean;
    ownerDiagnosticsValueCapture?: boolean;
}>;

export type ParseInjectedBrowserDiagnosticsMessageResult =
    | Readonly<{
        ok: true;
        events: readonly BrowserDiagnosticEventV1[];
        evalResult?: never;
      }>
    | Readonly<{
        ok: true;
        evalResult: BrowserDiagnosticsEvalResultV1;
        events?: never;
      }>
    | Readonly<{
        ok: true;
        propertiesResult: BrowserDiagnosticsGetPropertiesResultV1;
        events?: never;
        evalResult?: never;
      }>
    | Readonly<{
        ok: true;
        releaseResult: BrowserDiagnosticsReleaseObjectGroupResultV1;
        events?: never;
        evalResult?: never;
        propertiesResult?: never;
      }>
    | Readonly<{
        ok: true;
        elementPickerResult: BrowserDiagnosticsElementPickerResultV1;
        events?: never;
        evalResult?: never;
        propertiesResult?: never;
        releaseResult?: never;
      }>
    | Readonly<{
        ok: false;
        reasonCode:
            | 'collector_mismatch'
            | 'invalid_json'
            | 'navigation_mismatch'
            | 'navigation_stale'
            | 'schema_invalid'
            | 'wrong_kind';
      }>;

export type BuildInjectedBrowserDiagnosticsEvalCommandScriptInput = Readonly<{
    browserSessionId: string;
    collectorId: string;
    nonce: string;
    version: string;
    request: BrowserDiagnosticsEvalRequestV1;
}>;

export type BuildInjectedBrowserDiagnosticsGetPropertiesCommandScriptInput = Readonly<{
    browserSessionId: string;
    collectorId: string;
    nonce: string;
    version: string;
    request: BrowserDiagnosticsGetPropertiesRequestV1;
}>;

export type BuildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScriptInput = Readonly<{
    browserSessionId: string;
    collectorId: string;
    nonce: string;
    version: string;
    request: BrowserDiagnosticsReleaseObjectGroupRequestV1;
}>;

export type BuildInjectedBrowserDiagnosticsElementPickerCommandScriptInput = Readonly<{
    browserSessionId: string;
    collectorId: string;
    nonce: string;
    version: string;
    request: BrowserDiagnosticsElementPickerRequestV1;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const nested = value[key];
    return isRecord(nested) ? nested : null;
}

function safeJsonForScript(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c');
}

function normalizeWebPostMessageTargetOrigin(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (trimmed === '*') {
        throw new Error('Injected browser diagnostics require an explicit web postMessage target origin.');
    }
    try {
        const parsed = new URL(trimmed);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
            throw new Error('invalid_origin');
        }
        return parsed.origin;
    } catch {
        throw new Error('Injected browser diagnostics require an explicit web postMessage target origin.');
    }
}

/**
 * Host re-sanitizer policy. `consoleValueCapture` mirrors the producer's owner-value-capture policy:
 * when set, the defense-in-depth re-sanitizer preserves the length-capped owner console `text`
 * instead of collapsing console entries to metadata. It defaults to the fail-closed (strip) behavior.
 */
type InjectedDiagnosticsSanitizeOptions = Readonly<{
    consoleValueCapture?: boolean;
    valueCapture?: boolean;
}>;

function sanitizeDiagnosticData(value: unknown): unknown {
    if (typeof value === 'string') {
        return stripUrlValuesInString(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeDiagnosticData(item));
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([nestedKey, nestedValue]) => [
                nestedKey,
                sanitizeDiagnosticData(nestedValue),
            ]),
        );
    }
    return value;
}

function cappedOwnerConsoleText(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value.length > INJECTED_CONSOLE_TEXT_MAX_LENGTH
        ? value.slice(0, INJECTED_CONSOLE_TEXT_MAX_LENGTH)
        : value;
}

function cappedOwnerValueText(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value.length > INJECTED_OWNER_VALUE_MAX_LENGTH
        ? value.slice(0, INJECTED_OWNER_VALUE_MAX_LENGTH)
        : value;
}

function sanitizeOwnerHeaderBag(value: unknown): Record<string, string> | undefined {
    if (!isRecord(value)) return undefined;
    const headers: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(value)) {
        if (typeof headerValue !== 'string' || headerValue.length === 0) continue;
        headers[name] = headerValue;
    }
    const out = redactDiagnosticsHeaders(headers, { valueLimit: INJECTED_OWNER_VALUE_MAX_LENGTH });
    return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeOwnerStorageEntries(value: unknown): readonly Record<string, unknown>[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const entries = value.slice(0, 200).flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const key = typeof entry.key === 'string' ? entry.key.slice(0, 256) : '';
        const valueText = cappedOwnerValueText(entry.value);
        if (!key || valueText === undefined) return [];
        return [{
            key,
            value: valueText,
            valueTruncated: entry.valueTruncated === true,
        }];
    });
    return entries.length > 0 ? entries : undefined;
}

function sanitizeInjectedDiagnosticDataForEvent(
    event: Readonly<Record<string, unknown>>,
    data: Readonly<Record<string, unknown>>,
    options?: InjectedDiagnosticsSanitizeOptions,
): Record<string, unknown> {
    const sanitizedData = sanitizeDiagnosticData(data);
    const record = isRecord(sanitizedData) ? sanitizedData : {};

    if (
        event.fidelity === 'injectedPage'
        && (event.family === 'console' || event.family === 'pageError')
    ) {
        const textAvailable = (
            data.textAvailable === true
            || (typeof data.textPreview === 'string' && data.textPreview.length > 0)
            || (typeof data.message === 'string' && data.message.length > 0)
            || (typeof data.text === 'string' && data.text.length > 0)
            || (Array.isArray(data.args) && data.args.length > 0)
        );
        // DEV-2: preserve the length-capped owner `text` ONLY for console entries when the LOCAL
        // owner's value-capture policy is enabled. `pageError` text stays metadata-only, and the
        // fail-closed default (no policy) keeps the prior `{level,argCount,textAvailable}` shape.
        const ownerText = options?.consoleValueCapture === true && event.family === 'console'
            ? cappedOwnerConsoleText(data.text)
            : undefined;
        return {
            ...(event.family === 'console' && typeof data.level === 'string' ? { level: data.level } : {}),
            ...(event.family === 'console' && Number.isInteger(data.argCount) ? { argCount: data.argCount } : {}),
            textAvailable,
            ...(ownerText !== undefined ? { text: ownerText } : {}),
        };
    }

    if (
        event.fidelity === 'injectedPage'
        && event.family === 'network'
        && event.kind === 'network.failed'
    ) {
        return {
            requestAvailable: data.requestAvailable === true || typeof data.requestId === 'string',
            errorAvailable: data.errorAvailable === true || typeof data.errorCode === 'string',
        };
    }

    if (
        event.fidelity === 'injectedPage'
        && event.family === 'pageInfo'
        && event.kind === 'pageInfo.snapshot'
    ) {
        return {
            ...(typeof record.url === 'string' ? { url: record.url } : {}),
            ...(typeof data.readyState === 'string' ? { readyState: data.readyState } : {}),
            titleAvailable: data.titleAvailable === true || (typeof data.title === 'string' && data.title.length > 0),
        };
    }

    if (
        event.fidelity === 'injectedPage'
        && event.kind === 'eval.requested'
    ) {
        const expressionPreview = typeof data.expressionPreview === 'string'
            ? data.expressionPreview.slice(0, 4096)
            : undefined;
        return {
            ...(typeof data.evalRequestId === 'string' ? { evalRequestId: data.evalRequestId } : {}),
            ...(data.tier === 'injectedPage' ? { tier: data.tier } : {}),
            ...(expressionPreview ? { expressionPreview } : {}),
            expressionTruncated: data.expressionTruncated === true,
            ...(Number.isInteger(data.timeoutMs) ? { timeoutMs: data.timeoutMs } : {}),
            ...(typeof data.objectGroupId === 'string' ? { objectGroupId: data.objectGroupId } : {}),
        };
    }

    if (
        event.fidelity === 'injectedPage'
        && event.kind === 'eval.completed'
    ) {
        return {
            ...(typeof data.evalRequestId === 'string' ? { evalRequestId: data.evalRequestId } : {}),
            ...(data.tier === 'injectedPage' ? { tier: data.tier } : {}),
            ...(typeof data.resultType === 'string' ? { resultType: data.resultType } : {}),
            resultDescriptionAvailable: data.resultDescriptionAvailable === true,
            resultPreviewTruncated: data.resultPreviewTruncated === true,
        };
    }

    if (
        event.fidelity === 'injectedPage'
        && event.kind === 'eval.failed'
    ) {
        return {
            ...(typeof data.evalRequestId === 'string' ? { evalRequestId: data.evalRequestId } : {}),
            ...(data.tier === 'injectedPage' ? { tier: data.tier } : {}),
            errorAvailable: data.errorAvailable === true,
        };
    }

    if (
        event.fidelity === 'injectedPage'
        && event.kind === 'eval.timedOut'
    ) {
        return {
            ...(typeof data.evalRequestId === 'string' ? { evalRequestId: data.evalRequestId } : {}),
            ...(data.tier === 'injectedPage' ? { tier: data.tier } : {}),
            ...(Number.isInteger(data.timeoutMs) ? { timeoutMs: data.timeoutMs } : {}),
        };
    }

    if (
        event.fidelity === 'injectedPage'
        && event.kind === 'network.response'
    ) {
        const requestHeaders = options?.valueCapture === true
            ? sanitizeOwnerHeaderBag(data.requestHeaders)
            : undefined;
        const responseHeaders = options?.valueCapture === true
            ? sanitizeOwnerHeaderBag(data.responseHeaders)
            : undefined;
        const requestBodyText = options?.valueCapture === true
            ? cappedOwnerValueText(data.requestBodyText)
            : undefined;
        const responseBodyText = options?.valueCapture === true
            ? cappedOwnerValueText(data.responseBodyText)
            : undefined;
        return {
            ...(typeof data.requestId === 'string' ? { requestId: data.requestId } : {}),
            ...(typeof record.method === 'string' ? { method: record.method } : {}),
            ...(typeof record.url === 'string' ? { url: record.url } : {}),
            ...(Number.isInteger(data.statusCode) ? { statusCode: data.statusCode } : {}),
            ...(typeof data.durationMs === 'number' ? { durationMs: data.durationMs } : {}),
            ...(typeof data.requestBytes === 'number' ? { requestBytes: data.requestBytes } : {}),
            ...(typeof data.responseBytes === 'number' ? { responseBytes: data.responseBytes } : {}),
            ...(requestHeaders ? { requestHeaders } : {}),
            ...(responseHeaders ? { responseHeaders } : {}),
            ...(requestBodyText !== undefined ? { requestBodyText, requestBodyTruncated: data.requestBodyTruncated === true } : {}),
            ...(responseBodyText !== undefined ? { responseBodyText, responseBodyTruncated: data.responseBodyTruncated === true } : {}),
        };
    }

    if (
        event.fidelity === 'injectedPage'
        && event.kind === 'storage.keyInventory'
    ) {
        const entries = options?.valueCapture === true ? sanitizeOwnerStorageEntries(data.entries) : undefined;
        return {
            ...(data.storageType === 'localStorage' || data.storageType === 'sessionStorage' ? { storageType: data.storageType } : {}),
            ...(Number.isInteger(data.keyCount) ? { keyCount: data.keyCount } : {}),
            keysTruncated: data.keysTruncated === true,
            ...(Array.isArray(data.keys) ? { keys: data.keys.filter((key): key is string => typeof key === 'string').slice(0, 200) } : {}),
            ...(entries ? { entries } : {}),
        };
    }

    return record;
}

function sanitizeRawInjectedDiagnosticEvent(
    value: unknown,
    options?: InjectedDiagnosticsSanitizeOptions,
): unknown {
    if (!isRecord(value)) return value;
    const data = isRecord(value.data) ? value.data : {};
    const sanitizedData = sanitizeInjectedDiagnosticDataForEvent(value, data, options);
    const sanitizedEvent = {
        ...value,
        data: sanitizedData,
    };

    if (
        value.fidelity === 'injectedPage'
        && (
            value.family === 'console'
            || value.family === 'pageError'
            || (value.family === 'network' && value.kind === 'network.failed')
        )
    ) {
        // DEV-2: a console entry that surfaced the owner-only `text` stays at full owner fidelity
        // ('none'); everything else (incl. the fail-closed console default) remains valuesRedacted.
        const ownerConsoleText = value.family === 'console' && typeof sanitizedData.text === 'string';
        return {
            ...sanitizedEvent,
            redaction: {
                ...(isRecord(value.redaction) ? value.redaction : {}),
                level: ownerConsoleText ? 'none' : 'valuesRedacted',
            },
        };
    }

    if (
        value.fidelity === 'injectedPage'
        && (
            value.kind === 'network.response'
            || value.kind === 'storage.keyInventory'
        )
    ) {
        const hasOwnerValues = (
            isRecord(sanitizedData)
            && (
                'requestHeaders' in sanitizedData
                || 'responseHeaders' in sanitizedData
                || 'requestBodyText' in sanitizedData
                || 'responseBodyText' in sanitizedData
                || 'entries' in sanitizedData
            )
        );
        return {
            ...sanitizedEvent,
            redaction: {
                ...(isRecord(value.redaction) ? value.redaction : {}),
                level: hasOwnerValues ? 'none' : 'metadataOnly',
            },
        };
    }

    return sanitizedEvent;
}

function sanitizeRawInjectedDiagnosticBatch(
    value: Record<string, unknown>,
    options?: InjectedDiagnosticsSanitizeOptions,
): Record<string, unknown> {
    return {
        ...value,
        events: Array.isArray(value.events)
            ? value.events.map((event) => sanitizeRawInjectedDiagnosticEvent(event, options))
            : value.events,
    };
}

function sanitizeDiagnosticEvent(
    event: BrowserDiagnosticEventV1,
    options?: InjectedDiagnosticsSanitizeOptions,
): BrowserDiagnosticEventV1 {
    const data = sanitizeDiagnosticData(event.data);
    if (
        isRecord(data)
        && event.fidelity === 'injectedPage'
        && (event.family === 'console' || event.family === 'pageError')
    ) {
        const sanitized = sanitizeInjectedDiagnosticDataForEvent(event, data, options);
        const ownerConsoleText = event.family === 'console' && typeof sanitized.text === 'string';
        return {
            ...event,
            data: sanitized,
            redaction: {
                ...event.redaction,
                level: ownerConsoleText ? 'none' : 'valuesRedacted',
            },
        };
    }
    if (
        isRecord(data)
        && event.fidelity === 'injectedPage'
        && event.family === 'network'
        && event.kind === 'network.failed'
    ) {
        return {
            ...event,
            data: {
                requestAvailable: data.requestAvailable === true || (typeof data.requestId === 'string' && data.requestId.length > 0),
                errorAvailable: data.errorAvailable === true || (typeof data.errorCode === 'string' && data.errorCode.length > 0),
            },
            redaction: {
                ...event.redaction,
                level: 'valuesRedacted',
            },
        };
    }
    return {
        ...event,
        data: isRecord(data) ? data : {},
    };
}

function sanitizedInjectedEventId(event: BrowserDiagnosticEventV1, index: number): string {
    return [
        'injected',
        event.navigationGeneration,
        event.family,
        event.kind,
        event.capturedAtMs,
        index + 1,
    ].join(':');
}

function validateInjectedMessageBinding(
    parsedRaw: Record<string, unknown>,
    expected: InjectedBrowserDiagnosticsCollectorIdentity,
): ParseInjectedBrowserDiagnosticsMessageResult | null {
    if (
        parsedRaw.browserSessionId !== expected.browserSessionId ||
        parsedRaw.viewId !== expected.viewId
    ) {
        return { ok: false, reasonCode: 'collector_mismatch' };
    }
    if (typeof parsedRaw.navigationGeneration !== 'number') {
        return { ok: false, reasonCode: 'schema_invalid' };
    }
    if (parsedRaw.navigationGeneration < expected.navigationGeneration) {
        return { ok: false, reasonCode: 'navigation_stale' };
    }
    if (parsedRaw.navigationGeneration !== expected.navigationGeneration) {
        return { ok: false, reasonCode: 'navigation_mismatch' };
    }

    const collector = readNestedRecord(parsedRaw, 'collector');
    if (
        collector?.collectorId !== expected.collectorId ||
        collector.nonce !== expected.nonce
    ) {
        return { ok: false, reasonCode: 'collector_mismatch' };
    }

    return null;
}

export function parseInjectedBrowserDiagnosticsMessage(
    raw: string,
    expected: InjectedBrowserDiagnosticsCollectorIdentity,
    options?: InjectedDiagnosticsSanitizeOptions,
): ParseInjectedBrowserDiagnosticsMessageResult {
    let parsedRaw: unknown;
    try {
        parsedRaw = JSON.parse(raw);
    } catch {
        return { ok: false, reasonCode: 'invalid_json' };
    }

    if (!isRecord(parsedRaw)) {
        return { ok: false, reasonCode: 'schema_invalid' };
    }
    if (
        parsedRaw.kind !== 'browser.diagnostics.events'
        && parsedRaw.kind !== 'browser.diagnostics.evalResult'
        && parsedRaw.kind !== 'browser.diagnostics.getPropertiesResult'
        && parsedRaw.kind !== 'browser.diagnostics.releaseObjectGroupResult'
        && parsedRaw.kind !== 'browser.diagnostics.elementPickerResult'
    ) {
        return { ok: false, reasonCode: 'wrong_kind' };
    }

    const bindingError = validateInjectedMessageBinding(parsedRaw, expected);
    if (bindingError) return bindingError;

    if (parsedRaw.kind === 'browser.diagnostics.evalResult') {
        const parsedMessage = BrowserDiagnosticsEvalResultMessageV1Schema.safeParse(parsedRaw);
        if (!parsedMessage.success) {
            return { ok: false, reasonCode: 'schema_invalid' };
        }
        return {
            ok: true,
            evalResult: parsedMessage.data.result,
        };
    }

    if (parsedRaw.kind === 'browser.diagnostics.getPropertiesResult') {
        const parsedMessage = BrowserDiagnosticsGetPropertiesResultMessageV1Schema.safeParse(parsedRaw);
        if (!parsedMessage.success) {
            return { ok: false, reasonCode: 'schema_invalid' };
        }
        return {
            ok: true,
            propertiesResult: parsedMessage.data.result,
        };
    }

    if (parsedRaw.kind === 'browser.diagnostics.releaseObjectGroupResult') {
        const parsedMessage = BrowserDiagnosticsReleaseObjectGroupResultMessageV1Schema.safeParse(parsedRaw);
        if (!parsedMessage.success) {
            return { ok: false, reasonCode: 'schema_invalid' };
        }
        return {
            ok: true,
            releaseResult: parsedMessage.data.result,
        };
    }

    if (parsedRaw.kind === 'browser.diagnostics.elementPickerResult') {
        const parsedMessage = BrowserDiagnosticsElementPickerResultMessageV1Schema.safeParse(parsedRaw);
        if (!parsedMessage.success) {
            return { ok: false, reasonCode: 'schema_invalid' };
        }
        return {
            ok: true,
            elementPickerResult: parsedMessage.data.result,
        };
    }

    const parsedBatch = BrowserDiagnosticEventBatchV1Schema.safeParse(
        sanitizeRawInjectedDiagnosticBatch(parsedRaw, options),
    );
    if (!parsedBatch.success) {
        return { ok: false, reasonCode: 'schema_invalid' };
    }

    return {
        ok: true,
        events: parsedBatch.data.events.map((event, index) => sanitizeDiagnosticEvent({
            ...event,
            eventId: sanitizedInjectedEventId(event, index),
        }, options)),
    };
}

export function buildInjectedBrowserDiagnosticsEvalCommandMessage(
    input: BuildInjectedBrowserDiagnosticsEvalCommandScriptInput,
): BrowserDiagnosticsEvalCommandMessageV1 {
    return BrowserDiagnosticsEvalCommandMessageV1Schema.parse({
        v: 1,
        kind: 'browser.diagnostics.evalRequest',
        browserSessionId: input.browserSessionId,
        viewId: input.request.viewId,
        navigationGeneration: input.request.navigationGeneration,
        collector: {
            collectorId: input.collectorId,
            nonce: input.nonce,
            version: input.version,
        },
        request: input.request,
    });
}

export function buildInjectedBrowserDiagnosticsEvalCommandScript(
    input: BuildInjectedBrowserDiagnosticsEvalCommandScriptInput,
): string {
    const command = safeJsonForScript(buildInjectedBrowserDiagnosticsEvalCommandMessage(input));
    return `
(function () {
  if (window.__happierBrowserDiagnostics && typeof window.__happierBrowserDiagnostics.evaluate === 'function') {
    window.__happierBrowserDiagnostics.evaluate(${command});
  }
})(); true;
`;
}

export function buildInjectedBrowserDiagnosticsGetPropertiesCommandMessage(
    input: BuildInjectedBrowserDiagnosticsGetPropertiesCommandScriptInput,
): BrowserDiagnosticsGetPropertiesCommandMessageV1 {
    return BrowserDiagnosticsGetPropertiesCommandMessageV1Schema.parse({
        v: 1,
        kind: 'browser.diagnostics.getPropertiesRequest',
        browserSessionId: input.browserSessionId,
        viewId: input.request.viewId,
        navigationGeneration: input.request.navigationGeneration,
        collector: {
            collectorId: input.collectorId,
            nonce: input.nonce,
            version: input.version,
        },
        request: input.request,
    });
}

export function buildInjectedBrowserDiagnosticsGetPropertiesCommandScript(
    input: BuildInjectedBrowserDiagnosticsGetPropertiesCommandScriptInput,
): string {
    const command = safeJsonForScript(buildInjectedBrowserDiagnosticsGetPropertiesCommandMessage(input));
    return `
(function () {
  if (window.__happierBrowserDiagnostics && typeof window.__happierBrowserDiagnostics.getProperties === 'function') {
    window.__happierBrowserDiagnostics.getProperties(${command});
  }
})(); true;
`;
}

export function buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandMessage(
    input: BuildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScriptInput,
): BrowserDiagnosticsReleaseObjectGroupCommandMessageV1 {
    return BrowserDiagnosticsReleaseObjectGroupCommandMessageV1Schema.parse({
        v: 1,
        kind: 'browser.diagnostics.releaseObjectGroupRequest',
        browserSessionId: input.browserSessionId,
        viewId: input.request.viewId,
        navigationGeneration: input.request.navigationGeneration,
        collector: {
            collectorId: input.collectorId,
            nonce: input.nonce,
            version: input.version,
        },
        request: input.request,
    });
}

export function buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript(
    input: BuildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScriptInput,
): string {
    const command = safeJsonForScript(buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandMessage(input));
    return `
(function () {
  if (window.__happierBrowserDiagnostics && typeof window.__happierBrowserDiagnostics.releaseObjectGroup === 'function') {
    window.__happierBrowserDiagnostics.releaseObjectGroup(${command});
  }
})(); true;
`;
}

export function buildInjectedBrowserDiagnosticsElementPickerCommandMessage(
    input: BuildInjectedBrowserDiagnosticsElementPickerCommandScriptInput,
): BrowserDiagnosticsElementPickerCommandMessageV1 {
    return BrowserDiagnosticsElementPickerCommandMessageV1Schema.parse({
        v: 1,
        kind: 'browser.diagnostics.elementPickerRequest',
        browserSessionId: input.browserSessionId,
        viewId: input.request.viewId,
        navigationGeneration: input.request.navigationGeneration,
        collector: {
            collectorId: input.collectorId,
            nonce: input.nonce,
            version: input.version,
        },
        request: input.request,
    });
}

export function buildInjectedBrowserDiagnosticsElementPickerCommandScript(
    input: BuildInjectedBrowserDiagnosticsElementPickerCommandScriptInput,
): string {
    const command = safeJsonForScript(buildInjectedBrowserDiagnosticsElementPickerCommandMessage(input));
    return `
(function () {
  if (window.__happierBrowserDiagnostics && typeof window.__happierBrowserDiagnostics.elementPicker === 'function') {
    window.__happierBrowserDiagnostics.elementPicker(${command});
  }
})(); true;
`;
}

export function buildInjectedBrowserDiagnosticsScript(
    input: BuildInjectedBrowserDiagnosticsScriptInput,
): string {
    const webPostMessageTargetOrigin = normalizeWebPostMessageTargetOrigin(input.webPostMessageTargetOrigin);
    const config = safeJsonForScript({
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        navigationGeneration: input.navigationGeneration,
        collector: {
            collectorId: input.collectorId,
            nonce: input.nonce,
            version: input.version,
        },
        ...(webPostMessageTargetOrigin ? {
            webPostMessageTargetOrigin,
        } : {}),
        ...(input.desktopIpcDelivery ? {
            desktopIpcDelivery: true,
        } : {}),
        ...(input.ownerConsoleValueCapture ? {
            ownerConsoleValueCapture: true,
            consoleTextMaxLength: INJECTED_CONSOLE_TEXT_MAX_LENGTH,
        } : {}),
        ...(input.ownerDiagnosticsValueCapture ? {
            ownerDiagnosticsValueCapture: true,
            ownerValueMaxLength: INJECTED_OWNER_VALUE_MAX_LENGTH,
            safeTelemetryHeaderNames: [...SAFE_TELEMETRY_HEADER_NAMES],
        } : {}),
    });

    return buildInjectedBrowserDiagnosticsRuntimeScript(config);
}
