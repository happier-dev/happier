import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';

import type { BrowserContextSource } from '../capture';
import type { BrowserSidecarContextCaptureSurface } from '../../sidecar/controlAdapter';
import type { BrowserContextDiagnosticsSummarySource } from '../diagnostics/summary';
import {
    createCdpBrowserContextSource,
    type BrowserContextDiagnosticsSummarizer,
} from './source';
import {
    createSessionMediaScreenshotWriter,
    type BrowserContextScreenshotMediaWriter,
    type BrowserContextSessionMediaTarget,
} from './screenshotMedia';

export type SidecarCdpBrowserContextSourceInput = Readonly<{
    contextCapture: BrowserSidecarContextCaptureSurface;
    /** Durable media bucket for screenshots. Defaults to a per-view browser-context bucket. */
    workingDirectory: string;
    pathAllowanceRegistry: TransferPathAllowanceRegistry;
    accessPolicy?: FilesystemAccessPolicy;
    resolveScreenshotTarget?: (input: Readonly<{
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
    }>) => BrowserContextSessionMediaTarget;
    /**
     * Store-backed source of network/console summaries. Absent ⇒ those summaries stay unavailable.
     */
    diagnosticsSummarySource?: BrowserContextDiagnosticsSummarySource;
    screenshotMediaWriter?: BrowserContextScreenshotMediaWriter;
    now?: () => number;
}>;

function defaultScreenshotTarget(input: Readonly<{
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
}>): BrowserContextSessionMediaTarget {
    return {
        sessionId: input.browserSessionId,
        messageLocalId: `browser_context_${input.viewId}_${input.navigationGeneration}`,
    };
}

/**
 * Production wiring for the BRW-11 CDP context producer (FP-BRW-SOURCE-1). Built ONLY when a live
 * sidecar control adapter exposed a context-capture surface; the daemon falls back to the
 * unavailable source when this is absent (fail-closed/honest). Binary-safe: screenshot persistence
 * uses the managed session-media owner; no system node / package manager is spawned.
 */
export function createSidecarCdpBrowserContextSource(
    input: SidecarCdpBrowserContextSourceInput,
): BrowserContextSource {
    const screenshotMediaWriter = input.screenshotMediaWriter
        ?? createSessionMediaScreenshotWriter({
            workingDirectory: input.workingDirectory,
            pathAllowanceRegistry: input.pathAllowanceRegistry,
            ...(input.accessPolicy ? { accessPolicy: input.accessPolicy } : {}),
            resolveTarget: input.resolveScreenshotTarget ?? defaultScreenshotTarget,
            ...(input.now ? { now: input.now } : {}),
        });

    const diagnosticsSummarySource = input.diagnosticsSummarySource;
    const summarizeDiagnostics: BrowserContextDiagnosticsSummarizer | undefined = diagnosticsSummarySource
        ? (request) => diagnosticsSummarySource.summarize(request)
        : undefined;

    return createCdpBrowserContextSource({
        transport: input.contextCapture.transport,
        resolveView: (view) => input.contextCapture.resolvePageHandle(view),
        screenshotMediaWriter,
        ...(summarizeDiagnostics ? { summarizeDiagnostics } : {}),
    });
}
