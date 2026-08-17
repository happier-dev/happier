/**
 * The sampled-event boundary projector.
 *
 * PostHog's sampled exception events carry an open, customer-controlled properties bag.
 * This projector runs immediately after strict DTO parsing and before any controller
 * state, panel state, reference candidate, or publication is constructed, and it is the
 * only path by which a sampled event's content becomes usable.
 *
 * It is an allowlist, not a redaction pass: it copies the exact fields the Occurrences,
 * Stack Trace, and Affected Sessions views need and drops everything else, including
 * `distinct_id` and every property outside that list. Code variables are Tier-3
 * display-only data and are never projected here, so they cannot reach retained state,
 * a Composer reference, a log, or a model input through this seam.
 *
 * It is also the one place that bounds a sample for publication. A stack trace, an
 * exception chain, and a URL are all provider-shaped and unbounded, while the Action
 * aggregate this page travels through rejects a result over one mebibyte outright — and
 * a rejected page shows a reader nothing at all. A pathological but provider-valid event
 * therefore stays visible with its content shortened and `truncated: true` set, rather
 * than being dropped or silently shortened.
 */

import { projectTriageDisplayTextV1 } from '@happier-dev/triage-protocol/v1';


/** The published bounds one sampled page is projected against. */
export type PosthogSampledEventBounds = Readonly<{
    maxExceptionsPerEvent: number;
    maxFramesPerException: number;
    exceptionTypeUtf8Bytes: number;
    exceptionValueUtf8Bytes: number;
    frameFunctionUtf8Bytes: number;
    frameSourceUtf8Bytes: number;
    urlUtf8Bytes: number;
    identifierUtf8Bytes: number;
}>;

/**
 * The bounds a published PostHog sample uses.
 *
 * They are derived from the one hard constraint that exists — the Action aggregate's
 * byte gate against a full twenty-row provider page — not from a guess about how deep a
 * real stack is. `src/ui/detail/issueEventProjection.test.ts` saturates every one of them
 * at once and measures the encoded page against that gate.
 */
export const POSTHOG_SAMPLED_EVENT_BOUNDS_V1: PosthogSampledEventBounds = Object.freeze({
    maxExceptionsPerEvent: 2,
    maxFramesPerException: 24,
    exceptionTypeUtf8Bytes: 128,
    exceptionValueUtf8Bytes: 512,
    frameFunctionUtf8Bytes: 160,
    frameSourceUtf8Bytes: 240,
    urlUtf8Bytes: 512,
    identifierUtf8Bytes: 128,
});

export type PosthogProjectedFrame = Readonly<{
    function?: string;
    source?: string;
    line?: number;
    column?: number;
    inApp?: boolean;
}>;

export type PosthogProjectedException = Readonly<{
    type?: string;
    value?: string;
    frames: readonly PosthogProjectedFrame[];
}>;

/** The complete set of sampled-event content the source may hold or render. */
export type PosthogProjectedIssueEvent = Readonly<{
    uuid: string;
    timestampMs?: number;
    /** `$session_id`, used only to derive Affected Sessions candidates. */
    sessionId?: string;
    /** `$current_url`, used only for the URL column and permalink inputs. */
    url?: string;
    exceptions: readonly PosthogProjectedException[];
    /** Set only when this event's own content was shortened or count-bounded. */
    truncated?: true;
}>;

type RawEventInput = Readonly<{
    uuid: string;
    timestampMs?: number;
    rawProperties: Readonly<Record<string, unknown>>;
}>;

/** Collects whether anything in one event was shortened, without threading a return. */
type TruncationLedger = { truncated: boolean };

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readSafeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/**
 * One bounded, single-line display value.
 *
 * The normalize-then-bound rule belongs to `@happier-dev/triage-protocol`, and this
 * projection is not the exception it looks like. A stack-bearing exception message
 * routinely spans lines, so bounding without normalizing would leave this the one
 * projection in the source with its own rule — and it would measure a control
 * character as the one byte it occupies rather than the six it costs once JSON
 * escapes it, which is what the saturated-page byte measurement below depends on.
 *
 * Collapsing rather than stripping keeps the word boundary the newline stood for, and
 * it is never truncation: the words on both sides survive, so `truncated` stays false.
 */
function readBoundedString(
    value: unknown,
    maxUtf8Bytes: number,
    ledger: TruncationLedger,
): string | null {
    const raw = readString(value);
    if (raw === null) {
        return null;
    }
    const bounded = projectTriageDisplayTextV1(raw, maxUtf8Bytes);
    if (bounded.truncated) {
        ledger.truncated = true;
    }
    return bounded.value.length > 0 ? bounded.value : null;
}

function projectFrame(
    value: unknown,
    bounds: PosthogSampledEventBounds,
    ledger: TruncationLedger,
): PosthogProjectedFrame | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const raw = value as Readonly<Record<string, unknown>>;
    const fn = readBoundedString(raw['function'], bounds.frameFunctionUtf8Bytes, ledger);
    const source = readBoundedString(raw['source'], bounds.frameSourceUtf8Bytes, ledger);
    const line = readSafeInteger(raw['line']);
    const column = readSafeInteger(raw['column']);
    const inApp = typeof raw['in_app'] === 'boolean' ? raw['in_app'] : null;
    if (fn === null && source === null && line === null && column === null && inApp === null) {
        return null;
    }
    return {
        ...(fn === null ? {} : { function: fn }),
        ...(source === null ? {} : { source }),
        ...(line === null ? {} : { line }),
        ...(column === null ? {} : { column }),
        ...(inApp === null ? {} : { inApp }),
    };
}

function projectException(
    value: unknown,
    bounds: PosthogSampledEventBounds,
    ledger: TruncationLedger,
): PosthogProjectedException | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return null;
    }
    const raw = value as Readonly<Record<string, unknown>>;
    const type = readBoundedString(raw['type'], bounds.exceptionTypeUtf8Bytes, ledger);
    const exceptionValue = readBoundedString(
        raw['value'],
        bounds.exceptionValueUtf8Bytes,
        ledger,
    );
    const frames: PosthogProjectedFrame[] = [];
    const stacktrace = raw['stacktrace'];
    if (typeof stacktrace === 'object' && stacktrace !== null && !Array.isArray(stacktrace)) {
        const rawFrames = (stacktrace as Readonly<Record<string, unknown>>)['frames'];
        if (Array.isArray(rawFrames)) {
            for (const rawFrame of rawFrames) {
                if (frames.length >= bounds.maxFramesPerException) {
                    ledger.truncated = true;
                    break;
                }
                const frame = projectFrame(rawFrame, bounds, ledger);
                if (frame !== null) {
                    frames.push(frame);
                }
            }
        }
    }
    if (type === null && exceptionValue === null && frames.length === 0) {
        return null;
    }
    return {
        ...(type === null ? {} : { type }),
        ...(exceptionValue === null ? {} : { value: exceptionValue }),
        frames,
    };
}

function projectEvent(
    event: RawEventInput,
    bounds: PosthogSampledEventBounds,
): PosthogProjectedIssueEvent {
    const ledger: TruncationLedger = { truncated: false };
    const properties = event.rawProperties;
    const sessionId = readBoundedString(
        properties['$session_id'],
        bounds.identifierUtf8Bytes,
        ledger,
    );
    const url = readBoundedString(properties['$current_url'], bounds.urlUtf8Bytes, ledger);
    const exceptions: PosthogProjectedException[] = [];
    const rawExceptions = properties['$exception_list'];
    if (Array.isArray(rawExceptions)) {
        for (const rawException of rawExceptions) {
            if (exceptions.length >= bounds.maxExceptionsPerEvent) {
                ledger.truncated = true;
                break;
            }
            const projected = projectException(rawException, bounds, ledger);
            if (projected !== null) {
                exceptions.push(projected);
            }
        }
    }
    // Identity is never shortened: a truncated UUID would address a different event.
    return {
        uuid: event.uuid,
        ...(event.timestampMs === undefined ? {} : { timestampMs: event.timestampMs }),
        ...(sessionId === null ? {} : { sessionId }),
        ...(url === null ? {} : { url }),
        exceptions,
        ...(ledger.truncated ? { truncated: true as const } : {}),
    };
}

export function projectPosthogIssueEvents(
    events: readonly RawEventInput[],
    bounds: PosthogSampledEventBounds,
): readonly PosthogProjectedIssueEvent[] {
    return events.map((event) => projectEvent(event, bounds));
}
