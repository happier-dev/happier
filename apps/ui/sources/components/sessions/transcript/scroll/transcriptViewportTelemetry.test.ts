import { afterEach, describe, expect, it, vi } from 'vitest';

const GLOBAL_KEY = '__HAPPIER_TRANSCRIPT_VIEWPORT_EVENTS__';
const OVERRIDE_GLOBAL_KEY = '__HAPPIER_TRANSCRIPT_VIEWPORT_TELEMETRY_OVERRIDE__';

type UnknownModule = Record<string, unknown>;

async function loadTelemetryModule(): Promise<UnknownModule> {
    try {
        return await import('./transcriptViewportTelemetry') as UnknownModule;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Cannot find module') || message.includes('Failed to resolve import')) {
            return {};
        }
        throw error;
    }
}

function requireFunction(
    module: UnknownModule,
    name: string,
): (...args: unknown[]) => unknown {
    const value = module[name];
    expect(typeof value).toBe('function');
    return value as (...args: unknown[]) => unknown;
}

function buildScrollWriteEvent(overrides: Record<string, unknown> = {}) {
    return {
        type: 'scroll-write',
        writer: 'web-dom-bottom',
        reason: 'initial-open',
        sessionId: 'session-1',
        platform: 'web',
        listImplementation: 'legend',
        mode: 'follow-bottom',
        targetOffsetY: 120,
        previousOffsetY: 20,
        layoutHeight: 500,
        contentHeight: 900,
        distanceFromBottom: 0,
        timestampMs: 123,
        ...overrides,
    };
}

function buildScrollWriteRejectedEvent(overrides: Record<string, unknown> = {}) {
    return {
        ...buildScrollWriteEvent({
            type: 'scroll-write-rejected',
            writer: 'native-scroll-to-offset',
            reason: 'prepend-restore',
        }),
        rejectedOwner: 'prepend',
        activeOwner: 'entry',
        ...overrides,
    };
}

describe('transcript viewport telemetry', () => {
    afterEach(() => {
        delete (globalThis as Record<string, unknown>)[GLOBAL_KEY];
        delete (globalThis as Record<string, unknown>)[OVERRIDE_GLOBAL_KEY];
        vi.unstubAllGlobals();
    });

    it('labels the active transcript renderer and native command orientation truthfully', async () => {
        const module = await loadTelemetryModule();
        const resolveRendererFacts = requireFunction(
            module,
            'resolveTranscriptViewportTelemetryRendererFacts',
        );

        expect(resolveRendererFacts()).toEqual({
            listImplementation: 'legend',
            orientation: 'standard',
        });
    });

    it('records nothing when disabled', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: false,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => unknown;
        };

        telemetry.record(buildScrollWriteEvent());

        expect(telemetry.snapshot()).toEqual({ events: [], droppedCount: 0 });
    });

    it('keeps the newest events in a bounded buffer', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            capacity: 2,
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => {
                events: Array<{
                    reason: string;
                    sessionId: string;
                    targetOffsetY: number;
                    timestampMs: number;
                }>;
                droppedCount: number;
            };
        };

        telemetry.record(buildScrollWriteEvent({
            reason: 'initial-open',
            sessionId: 'session-1',
            targetOffsetY: 10,
            timestampMs: 1,
        }));
        telemetry.record(buildScrollWriteEvent({
            reason: 'content-size-change',
            sessionId: 'session-2',
            targetOffsetY: 20,
            timestampMs: 2,
        }));
        telemetry.record(buildScrollWriteEvent({
            reason: 'layout-change',
            sessionId: 'session-3',
            targetOffsetY: 30,
            timestampMs: 3,
        }));

        const snapshot = telemetry.snapshot();
        expect(snapshot.droppedCount).toBe(1);
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events.map((event) => event.targetOffsetY)).toEqual([20, 30]);
        expect(snapshot.events.map((event) => event.timestampMs)).toEqual([2, 3]);
        expect(snapshot.events.map((event) => event.reason)).toEqual(['content-size-change', 'layout-change']);
        expect(snapshot.events[0]?.sessionId).toMatch(/^session:/);
        expect(snapshot.events[1]?.sessionId).toMatch(/^session:/);
        expect(snapshot.events[0]?.sessionId).not.toBe('session-2');
        expect(snapshot.events[1]?.sessionId).not.toBe('session-3');
    });

    it('retains raw session redactions only while matching events remain buffered', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            capacity: 3,
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => {
                events: Array<{
                    sessionId: string;
                    targetOffsetY: number;
                    timestampMs: number;
                }>;
                droppedCount: number;
            };
        };

        telemetry.record(buildScrollWriteEvent({
            sessionId: 'raw-session-a',
            targetOffsetY: 10,
            timestampMs: 1,
        }));
        telemetry.record(buildScrollWriteEvent({
            sessionId: 'raw-session-b',
            targetOffsetY: 20,
            timestampMs: 2,
        }));
        telemetry.record(buildScrollWriteEvent({
            sessionId: 'raw-session-a',
            targetOffsetY: 30,
            timestampMs: 3,
        }));

        const initialSnapshot = telemetry.snapshot();
        const rawSessionARedaction = initialSnapshot.events[0]?.sessionId;
        const rawSessionBRedaction = initialSnapshot.events[1]?.sessionId;
        expect(initialSnapshot.events.map((event) => event.targetOffsetY)).toEqual([10, 20, 30]);
        expect(initialSnapshot.events[2]?.sessionId).toBe(rawSessionARedaction);

        telemetry.record(buildScrollWriteEvent({
            sessionId: 'raw-session-c',
            targetOffsetY: 40,
            timestampMs: 4,
        }));
        telemetry.record(buildScrollWriteEvent({
            sessionId: 'raw-session-a',
            targetOffsetY: 50,
            timestampMs: 5,
        }));

        const stableSnapshot = telemetry.snapshot();
        expect(stableSnapshot.events.map((event) => event.targetOffsetY)).toEqual([30, 40, 50]);
        expect(stableSnapshot.events[0]?.sessionId).toBe(rawSessionARedaction);
        expect(stableSnapshot.events[2]?.sessionId).toBe(rawSessionARedaction);

        telemetry.record(buildScrollWriteEvent({
            sessionId: 'raw-session-b',
            targetOffsetY: 60,
            timestampMs: 6,
        }));

        const snapshot = telemetry.snapshot();
        expect(snapshot.droppedCount).toBe(3);
        expect(snapshot.events.map((event) => event.targetOffsetY)).toEqual([40, 50, 60]);
        expect(snapshot.events[2]?.sessionId).toMatch(/^session:/);
        expect(snapshot.events[2]?.sessionId).not.toBe(rawSessionBRedaction);
        expect(snapshot.events[2]?.sessionId).not.toBe('raw-session-b');
    });

    it('omits sensitive transcript payload fields from recorded events', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteEvent({
            text: 'transcript text must not be kept',
            content: { t: 'plain', v: { secret: 'payload' } },
            commandOutput: 'shell output',
            filePath: '/Users/example/private.txt',
            secret: 'token',
            decryptedPayload: { value: 'raw' },
        }));

        const snapshot = telemetry.snapshot();
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0]).toMatchObject({
            type: 'scroll-write',
            targetOffsetY: 120,
            contentHeight: 900,
        });
        expect(snapshot.events[0]?.sessionId).not.toBe('session-1');
        expect(snapshot.events[0]).not.toHaveProperty('text');
        expect(snapshot.events[0]).not.toHaveProperty('content');
        expect(snapshot.events[0]).not.toHaveProperty('commandOutput');
        expect(snapshot.events[0]).not.toHaveProperty('filePath');
        expect(snapshot.events[0]).not.toHaveProperty('secret');
        expect(snapshot.events[0]).not.toHaveProperty('decryptedPayload');
    });

    it('sends sanitized events to an injected sink without using globals', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');
        const sink = vi.fn();

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            sink,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
        };

        telemetry.record(buildScrollWriteEvent({ text: 'do not leak' }));

        expect(sink).toHaveBeenCalledWith(expect.objectContaining({
            type: 'scroll-write',
        }));
        expect(sink.mock.calls[0]?.[0]?.sessionId).not.toBe('session-1');
        expect(sink.mock.calls[0]?.[0]).not.toHaveProperty('text');
        expect((globalThis as Record<string, unknown>)[GLOBAL_KEY]).toBeUndefined();
    });

    it('can mirror sanitized events to the console for native logcat probes', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

        const telemetry = createTranscriptViewportTelemetry({
            consoleLog: true,
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
        };

        telemetry.record(buildScrollWriteEvent({
            sessionId: 'raw-session-id',
            text: 'transcript text must not leak',
        }));

        expect(consoleLog).toHaveBeenCalledWith(
            'HAPPIER_TRANSCRIPT_VIEWPORT_EVENT',
            expect.stringContaining('"type":"scroll-write"'),
        );
        const loggedPayload = consoleLog.mock.calls[0]?.[1];
        expect(typeof loggedPayload).toBe('string');
        expect(loggedPayload).not.toContain('raw-session-id');
        expect(loggedPayload).not.toContain('transcript text must not leak');
    });

    it('rejects renderer facts that are impossible in the Legend-only dev runtime', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteEvent({
            listImplementation: 'flash_v2',
            writer: 'web-scroll-to-index',
            targetOffsetY: 1,
        }));
        telemetry.record(buildScrollWriteEvent({
            listImplementation: 'flatlist_legacy',
            platform: 'ios',
            writer: 'native-scroll-to-index',
            targetOffsetY: 2,
        }));
        telemetry.record(buildScrollWriteEvent({
            listImplementation: 'web-fallback',
            writer: 'web-scroll-to-index',
            targetOffsetY: 3,
        }));
        telemetry.record(buildScrollWriteEvent({
            listImplementation: 'legend',
            orientation: 'inverted',
            targetOffsetY: 4,
        }));
        telemetry.record(buildScrollWriteEvent({
            listImplementation: 'legend',
            writer: 'legacy-scroll-to-index',
            targetOffsetY: 5,
        }));

        const snapshot = telemetry.snapshot();
        expect(snapshot.events).toEqual([
            expect.objectContaining({
                listImplementation: 'legend',
                targetOffsetY: 4,
            }),
        ]);
        expect(snapshot.events[0]).not.toHaveProperty('orientation');
        expect(snapshot.droppedCount).toBe(1);
    });

    it('accepts passive drift as a typed scroll-write reason', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteEvent({
            writer: 'native-scroll-to-offset',
            reason: 'passive-drift',
        }));

        expect(telemetry.snapshot().events[0]).toMatchObject({
            type: 'scroll-write',
            writer: 'native-scroll-to-offset',
            reason: 'passive-drift',
        });
    });

    it('accepts viewport-resized as a typed scroll-write reason (S3 composer/keyboard resize events)', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteEvent({
            writer: 'native-scroll-to-offset',
            reason: 'viewport-resized',
        }));

        expect(telemetry.snapshot().events[0]).toMatchObject({
            type: 'scroll-write',
            writer: 'native-scroll-to-offset',
            reason: 'viewport-resized',
        });
    });

    it('drops coarse experiment scroll-write reasons', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteEvent({
            writer: 'native-scroll-to-offset',
            reason: 'experiment',
        }));

        expect(telemetry.snapshot()).toEqual({ events: [], droppedCount: 0 });
    });

    it('drops free-form measurement reasons that could smuggle sensitive text', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record({
            type: 'restore-decision',
            sessionId: 'session-raw',
            platform: 'web',
            listImplementation: 'legend',
            mode: 'restore-distance',
            offsetY: 12,
            reason: '/Users/example/private.txt command output transcript snippet',
            timestampMs: 222,
        });

        expect(telemetry.snapshot().events[0]).toMatchObject({
            type: 'restore-decision',
            mode: 'restore-distance',
            offsetY: 12,
        });
        expect(telemetry.snapshot().events[0]).not.toHaveProperty('reason');
        expect(telemetry.snapshot().events[0]?.sessionId).not.toBe('session-raw');
    });

    it('preserves numeric native anchor restore diagnostics without accepting free-form payloads', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record({
            type: 'restore-decision',
            sessionId: 'session-raw',
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'restore-anchor',
            reason: 'pending',
            anchorIndex: 42,
            anchorItemOffsetPx: 64,
            anchorObservedItemOffsetPx: 128,
            anchorDeltaPx: 64,
            anchorCorrectionAttempt: 1,
            anchorCorrectionTargetOffsetY: 2048,
            anchorRestoreViewOffset: -64,
            correctorAppliedDiffTotalPx: 2944.5,
            correctorEventCount: 3,
            anchorMessageId: 'must-not-leak',
            timestampMs: 222,
        });

        expect(telemetry.snapshot().events[0]).toMatchObject({
            type: 'restore-decision',
            platform: 'ios',
            mode: 'restore-anchor',
            reason: 'pending',
            anchorIndex: 42,
            anchorItemOffsetPx: 64,
            anchorObservedItemOffsetPx: 128,
            anchorDeltaPx: 64,
            anchorCorrectionAttempt: 1,
            anchorCorrectionTargetOffsetY: 2048,
            anchorRestoreViewOffset: -64,
            correctorAppliedDiffTotalPx: 2944.5,
            correctorEventCount: 3,
        });
        expect(telemetry.snapshot().events[0]).not.toHaveProperty('anchorMessageId');
        expect(telemetry.snapshot().events[0]?.sessionId).not.toBe('session-raw');
    });

    it('preserves closed web pagination and restore diagnostics without accepting row content', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record({
            type: 'scroll-observed',
            sessionId: 'session-raw',
            platform: 'web',
            listImplementation: 'legend',
            mode: 'user-unpinned',
            reason: 'observed',
            offsetY: 0,
            layoutHeight: 100,
            contentHeight: 120,
            distanceFromBottom: 20,
            trigger: 'edge-reached',
            domScrollTop: 0,
            domScrollHeight: 1200,
            domClientHeight: 600,
            listContentHeight: 120,
            listLayoutHeight: 100,
            scrollable: true,
            paginationPhase: 'armed',
            paginationSuspendedReasons: ['transaction-open', 'free-form transcript text'],
            firstVisibleAnchorTestId: 'transcript-item-tool-group-footer:g1',
            programmaticWebWrite: false,
            text: 'transcript text must not leak',
            commandOutput: 'secret output must not leak',
            timestampMs: 222,
        });

        expect(telemetry.snapshot().events[0]).toMatchObject({
            type: 'scroll-observed',
            platform: 'web',
            mode: 'user-unpinned',
            reason: 'observed',
            offsetY: 0,
            trigger: 'edge-reached',
            domScrollTop: 0,
            domScrollHeight: 1200,
            domClientHeight: 600,
            listContentHeight: 120,
            listLayoutHeight: 100,
            scrollable: true,
            paginationPhase: 'armed',
            paginationSuspendedReasons: ['transaction-open'],
            firstVisibleAnchorTestId: 'transcript-item-tool-group-footer:g1',
            programmaticWebWrite: false,
        });
        expect(telemetry.snapshot().events[0]).not.toHaveProperty('text');
        expect(telemetry.snapshot().events[0]).not.toHaveProperty('commandOutput');
        expect(telemetry.snapshot().events[0]?.sessionId).not.toBe('session-raw');
    });

    it('preserves an empty web pagination suspended-reasons array as an explicit diagnostic', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record({
            type: 'scroll-observed',
            sessionId: 'session-raw',
            platform: 'web',
            listImplementation: 'legend',
            mode: 'user-unpinned',
            reason: 'observed',
            trigger: 'scroll',
            domScrollTop: 240,
            domScrollHeight: 1200,
            domClientHeight: 600,
            listContentHeight: 1180,
            listLayoutHeight: 580,
            scrollable: true,
            distanceFromBottom: 360,
            paginationPhase: 'idle',
            paginationSuspendedReasons: [],
            programmaticWebWrite: false,
            timestampMs: 222,
        });

        expect(telemetry.snapshot().events[0]).toMatchObject({
            paginationSuspendedReasons: [],
        });
    });

    it('accepts transaction-outcome observation reasons', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        const reasons = [
            'mvcp-preserved',
            'fallback-restored',
            'abandoned-layout-timeout',
            'abandoned-identity',
            'abandoned-user-scroll',
            'entry-anchor-missing',
            'entry-distance-oneshot',
        ];
        for (const reason of reasons) {
            telemetry.record({
                type: 'restore-decision',
                sessionId: 'session-raw',
                platform: 'ios',
                listImplementation: 'legend',
                mode: 'restore-anchor',
                reason,
                timestampMs: 222,
            });
        }

        const snapshot = telemetry.snapshot();
        expect(snapshot.events.map((event) => event.reason)).toEqual(reasons);
        expect(snapshot.droppedCount).toBe(0);
    });

    it('accepts forward-newer drain observation reasons (plan D6)', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        const reasons = [
            'forward-newer-triggered',
            'forward-newer-skipped',
            'forward-newer-drained',
        ];
        for (const reason of reasons) {
            telemetry.record({
                type: 'restore-decision',
                sessionId: 'session-raw',
                platform: 'android',
                listImplementation: 'legend',
                mode: 'user-unpinned',
                reason,
                timestampMs: 333,
            });
        }

        const snapshot = telemetry.snapshot();
        expect(snapshot.events.map((event) => event.reason)).toEqual(reasons);
        expect(snapshot.droppedCount).toBe(0);
    });

    it('accepts anchor-capture events with capture-outcome reasons (plan P2)', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        const reasons = [
            'anchor-captured',
            'anchor-capture-empty',
            'anchor-capture-dropped',
        ];
        for (const reason of reasons) {
            telemetry.record({
                type: 'anchor-capture',
                sessionId: 'session-raw',
                platform: 'ios',
                listImplementation: 'legend',
                mode: 'user-unpinned',
                reason,
                anchorItemOffsetPx: 42,
                distanceFromBottom: 1234,
                timestampMs: 444,
            });
        }
        // Free-form reasons must still be dropped from the new event type.
        telemetry.record({
            type: 'anchor-capture',
            sessionId: 'session-raw',
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'user-unpinned',
            reason: 'smuggled free-form text',
            timestampMs: 445,
        });

        const snapshot = telemetry.snapshot();
        expect(snapshot.events.map((event) => event.type)).toEqual([
            'anchor-capture', 'anchor-capture', 'anchor-capture', 'anchor-capture',
        ]);
        expect(snapshot.events.map((event) => event.reason)).toEqual([...reasons, undefined]);
        expect(snapshot.events[0]).toMatchObject({ anchorItemOffsetPx: 42, distanceFromBottom: 1234 });
        expect(snapshot.droppedCount).toBe(0);
    });

    it('records native visible-window diagnostics for standard Legend traces', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record({
            type: 'visible-window-observed',
            sessionId: 'session-secret',
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'follow-bottom',
            orientation: 'standard',
            rawOffsetY: 0,
            canonicalOffsetY: 1500,
            offsetY: 1500,
            distanceFromBottom: 0,
            contentHeight: 2000,
            layoutHeight: 500,
            bottomFollowMode: 'following',
            dragSessionTrusted: true,
            nativeMomentumActive: false,
            isAtRawBottom: true,
            hasVisibleRows: true,
            firstVisibleItemId: 'row:newest',
            lastVisibleItemId: 'row:oldest',
            firstVisibleSourceIndex: 8,
            lastVisibleSourceIndex: 11,
            blankAreaPx: 0,
            visibleWindowSource: 'ref-compute',
            blankAreaSource: 'none',
            reason: 'observed',
            timestampMs: 123,
        });

        const snapshot = telemetry.snapshot();
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0]).toMatchObject({
            type: 'visible-window-observed',
            sessionId: expect.stringMatching(/^session:/),
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'follow-bottom',
            orientation: 'standard',
            rawOffsetY: 0,
            canonicalOffsetY: 1500,
            offsetY: 1500,
            distanceFromBottom: 0,
            contentHeight: 2000,
            layoutHeight: 500,
            bottomFollowMode: 'following',
            dragSessionTrusted: true,
            nativeMomentumActive: false,
            isAtRawBottom: true,
            hasVisibleRows: true,
            firstVisibleItemId: 'row:newest',
            lastVisibleItemId: 'row:oldest',
            firstVisibleSourceIndex: 8,
            lastVisibleSourceIndex: 11,
            blankAreaPx: 0,
            visibleWindowSource: 'ref-compute',
            blankAreaSource: 'none',
            reason: 'observed',
        });
        expect(snapshot.events[0]?.sessionId).not.toBe('session-secret');
    });

    it('omits invalid native diagnostic enum values without dropping the legacy event', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteEvent({
            orientation: 'SECRET_ORIENTATION',
            bottomFollowMode: 'SECRET_MODE',
            mvcpPolicy: 'SECRET_POLICY',
            dragSessionTrusted: true,
            nativeMomentumActive: true,
            isAtRawBottom: false,
            hasVisibleRows: false,
        }));

        const snapshot = telemetry.snapshot();
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0]?.type).toBe('scroll-write');
        expect(snapshot.events[0]).not.toHaveProperty('orientation');
        expect(snapshot.events[0]).not.toHaveProperty('bottomFollowMode');
        expect(snapshot.events[0]).not.toHaveProperty('mvcpPolicy');
        expect(snapshot.events[0]).toMatchObject({
            dragSessionTrusted: true,
            nativeMomentumActive: true,
            isAtRawBottom: false,
            hasVisibleRows: false,
        });
    });

    it('drops unknown transaction-outcome lookalike reasons', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record({
            type: 'restore-decision',
            sessionId: 'session-raw',
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'restore-anchor',
            reason: 'abandoned-unknown',
            timestampMs: 222,
        });

        expect(telemetry.snapshot().events[0]).toMatchObject({ type: 'restore-decision' });
        expect(telemetry.snapshot().events[0]).not.toHaveProperty('reason');
    });

    it('records scroll-write-rejected events with owner attribution', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteRejectedEvent({
            text: 'transcript text must not leak',
        }));

        const snapshot = telemetry.snapshot();
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0]).toMatchObject({
            type: 'scroll-write-rejected',
            writer: 'native-scroll-to-offset',
            reason: 'prepend-restore',
            rejectedOwner: 'prepend',
            activeOwner: 'entry',
            targetOffsetY: 120,
            contentHeight: 900,
        });
        expect(snapshot.events[0]?.sessionId).not.toBe('session-1');
        expect(snapshot.events[0]).not.toHaveProperty('text');
    });

    it('sanitizes native blank-window classifier fields without free-form payloads', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record({
            type: 'visible-window-observed',
            sessionId: 'session-1',
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'user-unpinned',
            reason: 'observed',
            rawOffsetY: 640,
            canonicalOffsetY: 860,
            offsetY: 860,
            contentHeight: 2000,
            layoutHeight: 500,
            eventContentHeight: 2000,
            eventLayoutHeight: 500,
            refContentHeight: 2000,
            refLayoutHeight: 500,
            distanceFromBottom: 640,
            bottomFollowMode: 'released',
            dragSessionTrusted: true,
            nativeMomentumActive: false,
            hasVisibleRows: false,
            visibleWindowSource: 'ref-compute',
            visibleWindowStale: true,
            blankAreaPx: 500,
            blankAreaSource: 'index-estimate',
            nativeBlankWindowSignature: 'empty-visible-window',
            listDataLength: 12,
            fullItemCount: 15,
            visibleRangeReadStatus: 'reversed',
            visibleRenderedStartIndex: 4,
            visibleRenderedEndIndex: 2,
            firstVisibleRenderedIndex: 4,
            entryRestoreState: 'none',
            prependState: 'none',
            layoutCacheClearState: 'idle',
            layoutCacheClearReason: 'none',
            scrollToIndexFailureState: 'none',
            transcriptText: 'must not leak',
            unsafeObject: { payload: 'must not leak' },
        });
        telemetry.record({
            type: 'visible-window-observed',
            sessionId: 'session-1',
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'user-unpinned',
            hasVisibleRows: false,
            nativeBlankWindowSignature: 'free-form /Users/example/private.txt',
            visibleRangeReadStatus: 'unknown',
            entryRestoreState: 'open:private',
            prependState: 'pending:private',
            layoutCacheClearState: 'cleared:private',
            layoutCacheClearReason: 'because private',
            scrollToIndexFailureState: 'failed:private',
        });

        const snapshot = telemetry.snapshot();
        expect(snapshot.events).toHaveLength(2);
        expect(snapshot.events[0]).toMatchObject({
            type: 'visible-window-observed',
            platform: 'ios',
            listImplementation: 'legend',
            mode: 'user-unpinned',
            nativeBlankWindowSignature: 'empty-visible-window',
            listDataLength: 12,
            fullItemCount: 15,
            visibleRangeReadStatus: 'reversed',
            visibleRenderedStartIndex: 4,
            visibleRenderedEndIndex: 2,
            firstVisibleRenderedIndex: 4,
            eventContentHeight: 2000,
            eventLayoutHeight: 500,
            refContentHeight: 2000,
            refLayoutHeight: 500,
            entryRestoreState: 'none',
            prependState: 'none',
            layoutCacheClearState: 'idle',
            layoutCacheClearReason: 'none',
            scrollToIndexFailureState: 'none',
        });
        expect(snapshot.events[0]).not.toHaveProperty('transcriptText');
        expect(snapshot.events[0]).not.toHaveProperty('unsafeObject');
        expect(snapshot.events[1]).not.toHaveProperty('nativeBlankWindowSignature');
        expect(snapshot.events[1]).not.toHaveProperty('visibleRangeReadStatus');
        expect(snapshot.events[1]).not.toHaveProperty('entryRestoreState');
        expect(snapshot.events[1]).not.toHaveProperty('prependState');
        expect(snapshot.events[1]).not.toHaveProperty('layoutCacheClearState');
        expect(snapshot.events[1]).not.toHaveProperty('layoutCacheClearReason');
        expect(snapshot.events[1]).not.toHaveProperty('scrollToIndexFailureState');
    });

    it('drops scroll-write-rejected events with unknown owner values', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteRejectedEvent({
            rejectedOwner: '/Users/example/private.txt',
        }));
        telemetry.record(buildScrollWriteRejectedEvent({
            activeOwner: 'someone-else',
        }));
        telemetry.record(buildScrollWriteRejectedEvent({
            rejectedOwner: undefined,
        }));
        telemetry.record(buildScrollWriteRejectedEvent({
            activeOwner: undefined,
        }));

        expect(telemetry.snapshot()).toEqual({ events: [], droppedCount: 0 });
    });

    it('drops scroll-write-rejected events with unknown writer or reason', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };

        telemetry.record(buildScrollWriteRejectedEvent({ writer: 'free-form-writer' }));
        telemetry.record(buildScrollWriteRejectedEvent({ reason: 'experiment' }));

        expect(telemetry.snapshot()).toEqual({ events: [], droppedCount: 1 });
    });

    it('exposes the dev getter while disabled but never in production', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');
        const installTranscriptViewportTelemetryGlobal = requireFunction(module, 'installTranscriptViewportTelemetryGlobal');

        const disabled = createTranscriptViewportTelemetry({ enabled: false }) as {
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };
        installTranscriptViewportTelemetryGlobal(disabled as never, { isDev: true } as never);
        const getter = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
        expect(typeof getter).toBe('function');
        expect((getter as () => ReturnType<typeof disabled.snapshot>)()).toEqual({ events: [], droppedCount: 0 });

        const production = createTranscriptViewportTelemetry({ enabled: true }) as unknown;
        installTranscriptViewportTelemetryGlobal(production as never, { isDev: false } as never);
        expect((globalThis as Record<string, unknown>)[GLOBAL_KEY]).toBeUndefined();
    });

    it('keeps singleton telemetry disabled outside dev even when tuning enables it', async () => {
        const module = await loadTelemetryModule();
        const recordTranscriptViewportTelemetryEvent = requireFunction(module, 'recordTranscriptViewportTelemetryEvent');
        const transcriptViewportTelemetry = module.transcriptViewportTelemetry as {
            configure: (options: { enabled: boolean; sink?: null }) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };
        vi.stubGlobal('__DEV__', false);
        transcriptViewportTelemetry.configure({ enabled: false, sink: null });

        recordTranscriptViewportTelemetryEvent(buildScrollWriteEvent(), {
            transcriptViewportTelemetryEnabled: true,
            transcriptViewportTelemetryMaxEvents: 16,
        });

        expect(transcriptViewportTelemetry.snapshot()).toEqual({ events: [], droppedCount: 0 });
        expect((globalThis as Record<string, unknown>)[GLOBAL_KEY]).toBeUndefined();
    });

    it('keeps a dev runtime override enabled when tuning is disabled for device QA', async () => {
        const module = await loadTelemetryModule();
        const configureTranscriptViewportTelemetryDebugOverride = requireFunction(
            module,
            'configureTranscriptViewportTelemetryDebugOverride',
        );
        const recordTranscriptViewportTelemetryEvent = requireFunction(module, 'recordTranscriptViewportTelemetryEvent');
        const transcriptViewportTelemetry = module.transcriptViewportTelemetry as {
            configure: (options: { enabled: boolean; sink?: null }) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };
        vi.stubGlobal('__DEV__', true);
        transcriptViewportTelemetry.configure({ enabled: false, sink: null });

        configureTranscriptViewportTelemetryDebugOverride({
            enabled: true,
            capacity: 16,
        });
        recordTranscriptViewportTelemetryEvent(buildScrollWriteEvent(), {
            transcriptViewportTelemetryEnabled: false,
            transcriptViewportTelemetryMaxEvents: 16,
        });

        const snapshot = transcriptViewportTelemetry.snapshot();
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0]).toMatchObject({
            type: 'scroll-write',
            writer: 'web-dom-bottom',
            reason: 'initial-open',
        });
        expect(typeof (globalThis as Record<string, unknown>)[GLOBAL_KEY]).toBe('function');

        configureTranscriptViewportTelemetryDebugOverride(null);
    });

    it('honors a dev global override when the runtime module registry is not inspectable', async () => {
        const module = await loadTelemetryModule();
        const recordTranscriptViewportTelemetryEvent = requireFunction(module, 'recordTranscriptViewportTelemetryEvent');
        const transcriptViewportTelemetry = module.transcriptViewportTelemetry as {
            configure: (options: { enabled: boolean; sink?: null }) => void;
            snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
        };
        vi.stubGlobal('__DEV__', true);
        transcriptViewportTelemetry.configure({ enabled: false, sink: null });

        (globalThis as Record<string, unknown>)[OVERRIDE_GLOBAL_KEY] = {
            enabled: true,
            capacity: 16,
        };
        recordTranscriptViewportTelemetryEvent(buildScrollWriteEvent(), {
            transcriptViewportTelemetryEnabled: false,
            transcriptViewportTelemetryMaxEvents: 16,
        });

        expect(transcriptViewportTelemetry.snapshot().events).toHaveLength(1);
        expect(typeof (globalThis as Record<string, unknown>)[GLOBAL_KEY]).toBe('function');
    });

    it('exposes a dev getter with events and dropped count when enabled', async () => {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');
        const installTranscriptViewportTelemetryGlobal = requireFunction(module, 'installTranscriptViewportTelemetryGlobal');

        const telemetry = createTranscriptViewportTelemetry({
            enabled: true,
            capacity: 1,
            now: () => 100,
        }) as {
            record: (event: unknown) => void;
        };
        telemetry.record(buildScrollWriteEvent({ sessionId: 'session-one' }));
        telemetry.record(buildScrollWriteEvent({ sessionId: 'session-two' }));
        installTranscriptViewportTelemetryGlobal(telemetry as never, { isDev: true } as never);

        const getter = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
        expect(typeof getter).toBe('function');
        const snapshot = (getter as () => { events: Array<Record<string, unknown>>; droppedCount: number })();
        expect(snapshot.droppedCount).toBe(1);
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events[0]?.sessionId).toMatch(/^session:/);
        expect(snapshot.events[0]?.sessionId).not.toBe('session-two');
    });
});

describe('transcript viewport telemetry — N1 evidence events', () => {
    type EvidenceTelemetry = {
        record: (event: unknown) => void;
        snapshot: () => { events: Array<Record<string, unknown>>; droppedCount: number };
    };

    async function createEvidenceTelemetry(): Promise<EvidenceTelemetry> {
        const module = await loadTelemetryModule();
        const createTranscriptViewportTelemetry = requireFunction(module, 'createTranscriptViewportTelemetry');
        return createTranscriptViewportTelemetry({ enabled: true, now: () => 100 }) as EvidenceTelemetry;
    }

    const commonFields = {
        sessionId: 'session-raw',
        platform: 'ios',
        listImplementation: 'legend',
        mode: 'user-unpinned',
        timestampMs: 1000,
    };

    it('accepts row-measured events with kind, delta, and viewport relation (N1.2)', async () => {
        const telemetry = await createEvidenceTelemetry();

        telemetry.record({
            type: 'row-measured',
            ...commonFields,
            rowId: 'turn-abc',
            rowKind: 'turn:tool',
            rowHeightPx: 1410,
            rowPreviousHeightPx: 980,
            rowDeltaPx: 430,
            rowMeasurePhase: 'remeasure',
            rowViewportRelation: 'above',
            offsetY: 5230,
            layoutHeight: 700,
        });
        telemetry.record({
            type: 'row-measured',
            ...commonFields,
            rowId: 'msg-1',
            rowKind: 'message:agent',
            rowHeightPx: 220,
            rowMeasurePhase: 'first',
            rowViewportRelation: 'inside',
        });

        const snapshot = telemetry.snapshot();
        expect(snapshot.events[0]).toMatchObject({
            type: 'row-measured',
            rowId: 'turn-abc',
            rowKind: 'turn:tool',
            rowHeightPx: 1410,
            rowPreviousHeightPx: 980,
            rowDeltaPx: 430,
            rowMeasurePhase: 'remeasure',
            rowViewportRelation: 'above',
        });
        expect(snapshot.events[1]).toMatchObject({
            rowMeasurePhase: 'first',
            rowViewportRelation: 'inside',
        });
        expect(snapshot.events[1]).not.toHaveProperty('rowDeltaPx');
        expect(snapshot.droppedCount).toBe(0);
    });

    it('accepts row-measured and row-mutated events for the per-unit tool-group row kinds (N2c)', async () => {
        const telemetry = await createEvidenceTelemetry();

        const unitKinds = ['tool-group-header', 'tool-group-expand', 'tool-group-tool', 'tool-group-footer'] as const;
        for (const rowKind of unitKinds) {
            telemetry.record({
                type: 'row-measured',
                ...commonFields,
                rowId: `toolCalls:turn:u1:t1#${rowKind}`,
                rowKind,
                rowHeightPx: 48,
                rowMeasurePhase: 'first',
                rowViewportRelation: 'inside',
            });
        }
        telemetry.record({
            type: 'row-mutated',
            ...commonFields,
            rowId: 'toolCalls:turn:u1:t1#header',
            rowKind: 'tool-group-header',
            rowContentCount: 1,
            rowPreviousContentCount: 1,
        });

        const snapshot = telemetry.snapshot();
        expect(snapshot.events.map((event) => event.rowKind)).toEqual([...unitKinds, 'tool-group-header']);
        expect(snapshot.droppedCount).toBe(0);
    });

    it('drops row-measured events missing required fields or carrying free-form kinds', async () => {
        const telemetry = await createEvidenceTelemetry();

        telemetry.record({
            type: 'row-measured',
            ...commonFields,
            rowKind: 'turn:tool',
            rowHeightPx: 100,
            rowMeasurePhase: 'first',
        });
        telemetry.record({
            type: 'row-measured',
            ...commonFields,
            rowId: 'row-1',
            rowKind: 'free form sensitive text',
            rowHeightPx: 100,
            rowMeasurePhase: 'first',
        });
        telemetry.record({
            type: 'row-measured',
            ...commonFields,
            rowId: 'row-1',
            rowKind: 'turn:tool',
            rowMeasurePhase: 'first',
        });
        telemetry.record({
            type: 'row-measured',
            ...commonFields,
            rowId: 'row-1',
            rowKind: 'turn:tool',
            rowHeightPx: 100,
            rowMeasurePhase: 'whenever',
        });

        expect(telemetry.snapshot().events).toHaveLength(0);
    });

    it('accepts row-mutated events with content-count transitions (N1.3)', async () => {
        const telemetry = await createEvidenceTelemetry();

        telemetry.record({
            type: 'row-mutated',
            ...commonFields,
            rowId: 'turn-abc',
            rowKind: 'turn:tool',
            rowContentCount: 14,
            rowPreviousContentCount: 9,
            rowViewportRelation: 'inside',
            freeFormNote: 'must-not-leak',
        });

        const snapshot = telemetry.snapshot();
        expect(snapshot.events[0]).toMatchObject({
            type: 'row-mutated',
            rowId: 'turn-abc',
            rowKind: 'turn:tool',
            rowContentCount: 14,
            rowPreviousContentCount: 9,
            rowViewportRelation: 'inside',
        });
        expect(snapshot.events[0]).not.toHaveProperty('freeFormNote');
        expect(snapshot.droppedCount).toBe(0);
    });

    it('drops row-mutated events missing identity fields', async () => {
        const telemetry = await createEvidenceTelemetry();

        telemetry.record({ type: 'row-mutated', ...commonFields, rowKind: 'turn:tool' });
        telemetry.record({ type: 'row-mutated', ...commonFields, rowId: 'row-1' });

        expect(telemetry.snapshot().events).toHaveLength(0);
    });
});
