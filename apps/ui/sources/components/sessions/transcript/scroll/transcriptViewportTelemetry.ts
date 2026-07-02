import type {
    TranscriptViewportListImplementation,
    TranscriptViewportMode,
    TranscriptViewportOwner,
    TranscriptViewportPlatform,
    TranscriptViewportScrollReason,
} from '@/components/sessions/transcript/viewport/transcriptViewportTypes';

export type { TranscriptViewportMode };
export type TranscriptViewportTelemetryPlatform = TranscriptViewportPlatform;
export type TranscriptViewportTelemetryListImplementation = TranscriptViewportListImplementation;
export type TranscriptViewportTelemetryOwner = TranscriptViewportOwner;

export type TranscriptViewportTelemetryScrollWriter =
    | 'web-dom-bottom'
    | 'web-dom-restore'
    | 'web-scroll-to-index'
    | 'native-scroll-to-offset'
    | 'native-scroll-to-index'
    | 'native-explicit-jump'
    | 'legacy-scroll-to-index'
    | 'mvcp-skip';

export type TranscriptViewportTelemetryScrollReason = TranscriptViewportScrollReason;

export type TranscriptViewportTelemetryObservationReason =
    | TranscriptViewportTelemetryScrollReason
    | 'observed'
    | 'pending'
    | 'restored'
    | 'skipped'
    | 'not-ready'
    | 'missing-anchor'
    | 'invalid-native-offset'
    | 'passive-drift'
    | 'mvcp-preserved'
    | 'fallback-restored'
    | 'abandoned-layout-timeout'
    | 'abandoned-identity'
    | 'abandoned-user-scroll'
    | 'entry-anchor-missing'
    | 'entry-distance-oneshot'
    | 'forward-newer-triggered'
    | 'forward-newer-skipped'
    | 'forward-newer-drained'
    | 'anchor-captured'
    | 'anchor-capture-empty'
    | 'anchor-capture-dropped';

export type TranscriptViewportTelemetryEvent =
    | Readonly<{
        type: 'scroll-write';
        writer: TranscriptViewportTelemetryScrollWriter;
        reason: TranscriptViewportTelemetryScrollReason;
        sessionId: string;
        platform: TranscriptViewportTelemetryPlatform;
        listImplementation: TranscriptViewportTelemetryListImplementation;
        mode: TranscriptViewportMode;
        targetOffsetY?: number;
        previousOffsetY?: number;
        layoutHeight?: number;
        contentHeight?: number;
        distanceFromBottom?: number;
        nativeMountSettleStable?: boolean;
        timestampMs: number;
    }>
    | Readonly<{
        type: 'scroll-write-rejected';
        writer: TranscriptViewportTelemetryScrollWriter;
        reason: TranscriptViewportTelemetryScrollReason;
        rejectedOwner: TranscriptViewportTelemetryOwner;
        activeOwner: TranscriptViewportTelemetryOwner;
        sessionId: string;
        platform: TranscriptViewportTelemetryPlatform;
        listImplementation: TranscriptViewportTelemetryListImplementation;
        mode: TranscriptViewportMode;
        targetOffsetY?: number;
        previousOffsetY?: number;
        layoutHeight?: number;
        contentHeight?: number;
        distanceFromBottom?: number;
        nativeMountSettleStable?: boolean;
        timestampMs: number;
    }>
    | Readonly<{
        type: 'restore-decision' | 'scroll-observed' | 'content-measured' | 'layout-measured' | 'anchor-capture';
        sessionId: string;
        platform: TranscriptViewportTelemetryPlatform;
        listImplementation: TranscriptViewportTelemetryListImplementation;
        mode: TranscriptViewportMode;
        offsetY?: number;
        layoutHeight?: number;
        contentHeight?: number;
        distanceFromBottom?: number;
        anchorIndex?: number;
        anchorItemOffsetPx?: number;
        anchorObservedItemOffsetPx?: number;
        anchorDeltaPx?: number;
        anchorCorrectionAttempt?: number;
        anchorCorrectionTargetOffsetY?: number;
        anchorRestoreViewOffset?: number;
        reason?: TranscriptViewportTelemetryObservationReason;
        timestampMs: number;
    }>;

export type TranscriptViewportTelemetrySnapshot = Readonly<{
    events: TranscriptViewportTelemetryEvent[];
    droppedCount: number;
}>;

type SanitizedTranscriptViewportTelemetryRecord = Readonly<{
    event: TranscriptViewportTelemetryEvent;
    rawSessionId: string;
}>;

type TranscriptViewportTelemetryOptions = Readonly<{
    capacity?: number;
    consoleLog?: boolean;
    enabled?: boolean;
    now?: () => number;
    sink?: ((event: TranscriptViewportTelemetryEvent) => void) | null;
}>;

type TranscriptViewportTelemetryDebugOverrideOptions = Readonly<{
    capacity?: unknown;
    consoleLog?: unknown;
    enabled?: unknown;
}>;

type InstallTranscriptViewportTelemetryGlobalOptions = Readonly<{
    isDev?: boolean;
}>;

export type TranscriptViewportTelemetryTuning = Readonly<{
    transcriptViewportTelemetryConsoleLog?: unknown;
    transcriptViewportTelemetryEnabled?: unknown;
    transcriptViewportTelemetryMaxEvents?: unknown;
}>;

const DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY = 512;
const TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE_GLOBAL_KEY = '__HAPPIER_TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE__';

const SCROLL_WRITERS = new Set<TranscriptViewportTelemetryScrollWriter>([
    'web-dom-bottom',
    'web-dom-restore',
    'web-scroll-to-index',
    'native-scroll-to-offset',
    'native-scroll-to-index',
    'native-explicit-jump',
    'legacy-scroll-to-index',
    'mvcp-skip',
]);

const SCROLL_REASONS = new Set<TranscriptViewportTelemetryScrollReason>([
    'initial-open',
    'content-size-change',
    'layout-change',
    'entry-restore',
    'prepend-restore',
    'jump-to-bottom',
    'jump-to-seq',
    'stream-append',
    'mount-settle',
    'passive-drift',
]);

const OBSERVATION_REASONS = new Set<TranscriptViewportTelemetryObservationReason>([
    ...SCROLL_REASONS,
    'observed',
    'pending',
    'restored',
    'skipped',
    'not-ready',
    'missing-anchor',
    'passive-drift',
    'invalid-native-offset',
    'mvcp-preserved',
    'fallback-restored',
    'abandoned-layout-timeout',
    'abandoned-identity',
    'abandoned-user-scroll',
    'entry-anchor-missing',
    'entry-distance-oneshot',
    'forward-newer-triggered',
    'forward-newer-skipped',
    'forward-newer-drained',
    'anchor-captured',
    'anchor-capture-empty',
    'anchor-capture-dropped',
]);

const OWNERS = new Set<TranscriptViewportTelemetryOwner>([
    'entry',
    'prepend',
    'follow',
    'explicit',
    'idle',
]);

const PLATFORMS = new Set<TranscriptViewportTelemetryPlatform>([
    'web',
    'ios',
    'android',
    'native-other',
]);

const LIST_IMPLEMENTATIONS = new Set<TranscriptViewportTelemetryListImplementation>([
    'flash_v2',
    'flatlist',
    'web-fallback',
]);

const MODES = new Set<TranscriptViewportMode>([
    'hydrating',
    'follow-bottom',
    'restore-anchor',
    'restore-distance',
    'user-unpinned',
    'jump-to-bottom',
    'jump-to-seq',
]);

function defaultNow(): number {
    const perf = (globalThis as unknown as { performance?: { now?: () => number } }).performance;
    if (typeof perf?.now === 'function') {
        return perf.now();
    }
    return Date.now();
}

function readDevFlag(): boolean {
    return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

function normalizeCapacity(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(1, Math.min(100_000, Math.trunc(value)));
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function readEnum<T extends string>(value: unknown, values: ReadonlySet<T>): T | null {
    const text = readString(value);
    return text && values.has(text as T) ? text as T : null;
}

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readTimestampMs(value: unknown, now: () => number): number {
    const timestamp = readNumber(value);
    return timestamp === undefined ? now() : timestamp;
}

function sanitizeTelemetryEvent(
    event: unknown,
    now: () => number,
    redactSessionId: (sessionId: string) => string,
): SanitizedTranscriptViewportTelemetryRecord | null {
    if (!event || typeof event !== 'object') return null;
    const source = event as Record<string, unknown>;
    const type = source.type;
    const rawSessionId = readString(source.sessionId);
    const platform = readEnum(source.platform, PLATFORMS);
    const listImplementation = readEnum(source.listImplementation, LIST_IMPLEMENTATIONS);
    const mode = readEnum(source.mode, MODES);
    if (!rawSessionId || !platform || !listImplementation || !mode) return null;

    const timestampMs = readTimestampMs(source.timestampMs, now);
    if (type === 'scroll-write' || type === 'scroll-write-rejected') {
        const writer = readEnum(source.writer, SCROLL_WRITERS);
        const reason = readEnum(source.reason, SCROLL_REASONS);
        if (!writer || !reason) return null;
        const sessionId = redactSessionId(rawSessionId);
        const sharedFields = {
            writer,
            reason,
            sessionId,
            platform,
            listImplementation,
            mode,
            targetOffsetY: readNumber(source.targetOffsetY),
            previousOffsetY: readNumber(source.previousOffsetY),
            layoutHeight: readNumber(source.layoutHeight),
            contentHeight: readNumber(source.contentHeight),
            distanceFromBottom: readNumber(source.distanceFromBottom),
            nativeMountSettleStable: typeof source.nativeMountSettleStable === 'boolean'
                ? source.nativeMountSettleStable
                : undefined,
            timestampMs,
        };
        if (type === 'scroll-write-rejected') {
            const rejectedOwner = readEnum(source.rejectedOwner, OWNERS);
            const activeOwner = readEnum(source.activeOwner, OWNERS);
            if (!rejectedOwner || !activeOwner) return null;
            return {
                event: { type, rejectedOwner, activeOwner, ...sharedFields },
                rawSessionId,
            };
        }
        return {
            event: {
                type,
                ...sharedFields,
            },
            rawSessionId,
        };
    }

    if (
        type === 'restore-decision' ||
        type === 'scroll-observed' ||
        type === 'content-measured' ||
        type === 'layout-measured' ||
        type === 'anchor-capture'
    ) {
        const reason = readEnum(source.reason, OBSERVATION_REASONS) ?? undefined;
        const sessionId = redactSessionId(rawSessionId);
        return {
            event: {
                type,
                sessionId,
                platform,
                listImplementation,
                mode,
                offsetY: readNumber(source.offsetY),
                layoutHeight: readNumber(source.layoutHeight),
                contentHeight: readNumber(source.contentHeight),
                distanceFromBottom: readNumber(source.distanceFromBottom),
                anchorIndex: readNumber(source.anchorIndex),
                anchorItemOffsetPx: readNumber(source.anchorItemOffsetPx),
                anchorObservedItemOffsetPx: readNumber(source.anchorObservedItemOffsetPx),
                anchorDeltaPx: readNumber(source.anchorDeltaPx),
                anchorCorrectionAttempt: readNumber(source.anchorCorrectionAttempt),
                anchorCorrectionTargetOffsetY: readNumber(source.anchorCorrectionTargetOffsetY),
                anchorRestoreViewOffset: readNumber(source.anchorRestoreViewOffset),
                ...(reason ? { reason } : {}),
                timestampMs,
            },
            rawSessionId,
        };
    }

    return null;
}

export class TranscriptViewportTelemetry {
    private enabled: boolean;
    private consoleLog: boolean;
    private capacity: number;
    private readonly now: () => number;
    private sink: ((event: TranscriptViewportTelemetryEvent) => void) | null;
    private events: TranscriptViewportTelemetryEvent[] = [];
    private rawSessionIds: string[] = [];
    private droppedCount = 0;
    private redactedSessionIds = new Map<string, string>();
    private nextSessionOrdinal = 1;

    constructor(options: TranscriptViewportTelemetryOptions = {}) {
        this.enabled = options.enabled === true;
        this.consoleLog = options.consoleLog === true;
        this.capacity = normalizeCapacity(options.capacity, DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY);
        this.now = options.now ?? defaultNow;
        this.sink = options.sink ?? null;
    }

    configure(options: TranscriptViewportTelemetryOptions): void {
        const wasEnabled = this.enabled;
        this.enabled = options.enabled === true;
        if ('consoleLog' in options) {
            this.consoleLog = options.consoleLog === true;
        }
        this.capacity = normalizeCapacity(options.capacity, this.capacity);
        if ('sink' in options) {
            this.sink = options.sink ?? null;
        }
        if (!this.enabled) {
            this.reset();
            return;
        }
        if (!wasEnabled) {
            this.reset();
        }
        this.trimToCapacity();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    record(event: unknown): void {
        if (!this.enabled) return;
        const sanitized = sanitizeTelemetryEvent(event, this.now, (sessionId) => this.redactSessionId(sessionId));
        if (!sanitized) return;
        this.events.push(sanitized.event);
        this.rawSessionIds.push(sanitized.rawSessionId);
        this.trimToCapacity();
        this.sink?.(sanitized.event);
        if (this.consoleLog) {
            console.log('HAPPIER_TRANSCRIPT_VIEWPORT_EVENT', JSON.stringify(sanitized.event));
        }
    }

    snapshot(): TranscriptViewportTelemetrySnapshot {
        return {
            events: this.events.map((event) => ({ ...event })),
            droppedCount: this.droppedCount,
        };
    }

    reset(): void {
        this.events = [];
        this.rawSessionIds = [];
        this.droppedCount = 0;
        this.redactedSessionIds.clear();
        this.nextSessionOrdinal = 1;
    }

    private redactSessionId(sessionId: string): string {
        const existing = this.redactedSessionIds.get(sessionId);
        if (existing) return existing;
        const redacted = `session:${this.nextSessionOrdinal}`;
        this.nextSessionOrdinal += 1;
        this.redactedSessionIds.set(sessionId, redacted);
        return redacted;
    }

    private trimToCapacity(): void {
        if (this.events.length <= this.capacity) return;
        const overflow = this.events.length - this.capacity;
        this.events = this.events.slice(overflow);
        this.rawSessionIds = this.rawSessionIds.slice(overflow);
        this.droppedCount += overflow;
        this.pruneRedactionsToBufferedRawSessionIds();
    }

    private pruneRedactionsToBufferedRawSessionIds(): void {
        const retainedRawSessionIds = new Set(this.rawSessionIds);
        for (const rawSessionId of this.redactedSessionIds.keys()) {
            if (!retainedRawSessionIds.has(rawSessionId)) {
                this.redactedSessionIds.delete(rawSessionId);
            }
        }
    }
}

export function createTranscriptViewportTelemetry(
    options?: TranscriptViewportTelemetryOptions,
): TranscriptViewportTelemetry {
    return new TranscriptViewportTelemetry(options);
}

export const transcriptViewportTelemetry = createTranscriptViewportTelemetry();

let transcriptViewportTelemetryDebugOverride: TranscriptViewportTelemetryOptions | null = null;

function readTranscriptViewportTelemetryGlobalDebugOverride(): TranscriptViewportTelemetryOptions | null {
    if (!readDevFlag()) return null;
    const target = globalThis as unknown as {
        __HAPPIER_TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE__?: TranscriptViewportTelemetryDebugOverrideOptions;
    };
    const options = target.__HAPPIER_TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE__;
    if (!options || typeof options !== 'object') return null;
    return {
        consoleLog: options.consoleLog === true,
        enabled: options.enabled === true,
        capacity: normalizeCapacity(
            options.capacity,
            DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY,
        ),
    };
}

function resolveTranscriptViewportTelemetryOptionsFromTuning(
    tuning: TranscriptViewportTelemetryTuning,
): TranscriptViewportTelemetryOptions {
    return {
        consoleLog: readDevFlag() && tuning.transcriptViewportTelemetryConsoleLog === true,
        enabled: readDevFlag() && tuning.transcriptViewportTelemetryEnabled === true,
        capacity: normalizeCapacity(
            tuning.transcriptViewportTelemetryMaxEvents,
            DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY,
        ),
    };
}

function mergeTranscriptViewportTelemetryDebugOverride(
    options: TranscriptViewportTelemetryOptions,
): TranscriptViewportTelemetryOptions {
    if (!readDevFlag()) {
        return options;
    }
    const globalDebugOverride = readTranscriptViewportTelemetryGlobalDebugOverride();
    if (globalDebugOverride === null && transcriptViewportTelemetryDebugOverride === null) {
        return options;
    }
    return {
        ...options,
        ...(globalDebugOverride ?? {}),
        ...(transcriptViewportTelemetryDebugOverride ?? {}),
    };
}

export function installTranscriptViewportTelemetryGlobal(
    telemetry: TranscriptViewportTelemetry = transcriptViewportTelemetry,
    options: InstallTranscriptViewportTelemetryGlobalOptions = {},
): void {
    const target = globalThis as unknown as {
        __HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__?: () => TranscriptViewportTelemetrySnapshot;
    };
    const isDev = options.isDev ?? readDevFlag();
    if (!isDev || !telemetry.isEnabled()) {
        delete target.__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__;
        return;
    }
    target.__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__ = () => telemetry.snapshot();
}

export function configureTranscriptViewportTelemetryFromTuning(
    tuning: TranscriptViewportTelemetryTuning,
): void {
    transcriptViewportTelemetry.configure(mergeTranscriptViewportTelemetryDebugOverride(
        resolveTranscriptViewportTelemetryOptionsFromTuning(tuning),
    ));
    installTranscriptViewportTelemetryGlobal(transcriptViewportTelemetry);
}

export function configureTranscriptViewportTelemetryDebugOverride(
    options: TranscriptViewportTelemetryDebugOverrideOptions | null,
): void {
    if (!readDevFlag() || options === null) {
        transcriptViewportTelemetryDebugOverride = null;
        delete (globalThis as Record<string, unknown>)[TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE_GLOBAL_KEY];
        if (options === null) {
            transcriptViewportTelemetry.configure({ enabled: false });
            installTranscriptViewportTelemetryGlobal(transcriptViewportTelemetry);
        }
        return;
    }
    transcriptViewportTelemetryDebugOverride = {
        consoleLog: options.consoleLog === true,
        enabled: options.enabled === true,
        capacity: normalizeCapacity(
            options.capacity,
            DEFAULT_TRANSCRIPT_VIEWPORT_TELEMETRY_CAPACITY,
        ),
    };
    (globalThis as Record<string, unknown>)[TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE_GLOBAL_KEY] =
        transcriptViewportTelemetryDebugOverride;
    transcriptViewportTelemetry.configure(transcriptViewportTelemetryDebugOverride);
    installTranscriptViewportTelemetryGlobal(transcriptViewportTelemetry);
}

export function recordTranscriptViewportTelemetryEvent(
    event: unknown,
    tuning: TranscriptViewportTelemetryTuning,
): void {
    configureTranscriptViewportTelemetryFromTuning(tuning);
    transcriptViewportTelemetry.record(event);
}

export function resolveTranscriptViewportTelemetryPlatform(platformOs: string): TranscriptViewportTelemetryPlatform {
    if (platformOs === 'web' || platformOs === 'ios' || platformOs === 'android') {
        return platformOs;
    }
    return 'native-other';
}

export function resolveTranscriptViewportTelemetryListImplementation(
    params: Readonly<{ listImplementation: string; platform: TranscriptViewportTelemetryPlatform }>,
): TranscriptViewportTelemetryListImplementation {
    if (params.listImplementation === 'flash_v2') return 'flash_v2';
    if (params.platform === 'web') return 'web-fallback';
    return 'flatlist';
}
