import remend from 'remend';
import {
    createWorkletRuntime,
    runOnRuntime,
    scheduleOnRN,
    type WorkletRuntime,
} from 'react-native-worklets';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { loadSyncTuning } from '@/sync/runtime/syncTuning';
import { preprocessStreamingMarkdown } from './preprocessStreamingMarkdown';
import { STREAMING_MARKDOWN_REMEND_OPTIONS } from './streamingMarkdownRepairConfig';

const STREAMING_MARKDOWN_REPAIR_WORKLET_EVENT = 'ui.markdown.streaming.repair.worklet';
const STREAMING_MARKDOWN_REPAIR_FALLBACK_EVENT = 'ui.markdown.streaming.repair.fallback';
const STREAMING_MARKDOWN_REPAIR_JS_EVENT = 'ui.markdown.streaming.repair.js';

let repairRuntime: WorkletRuntime | null | undefined;

type StreamingMarkdownRepairComplete = (succeeded: number, repairedMarkdown: string) => void;

function getRepairRuntime(): WorkletRuntime | null {
    if (repairRuntime !== undefined) return repairRuntime;

    try {
        repairRuntime = createWorkletRuntime('happier-markdown-repair');
    } catch {
        repairRuntime = null;
    }

    return repairRuntime;
}

function runRepairOnWorklet(runtime: WorkletRuntime, markdown: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;

        const clearRepairTimeout = () => {
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
        };

        const complete: StreamingMarkdownRepairComplete = (succeeded, repairedMarkdown) => {
            if (settled) return;
            settled = true;
            clearRepairTimeout();
            if (succeeded === 1) {
                resolve(repairedMarkdown);
            } else {
                reject(new Error('Streaming markdown Worklet repair failed'));
            }
        };

        timeout = setTimeout(() => {
            complete(0, '');
        }, timeoutMs);

        try {
            const scheduleRepair = runOnRuntime(
                runtime,
                (
                    sourceMarkdown: string,
                    remendOptions: typeof STREAMING_MARKDOWN_REMEND_OPTIONS,
                    onComplete: StreamingMarkdownRepairComplete,
                ) => {
                    'worklet';
                    try {
                        scheduleOnRN(onComplete, 1, remend(sourceMarkdown, remendOptions));
                    } catch {
                        scheduleOnRN(onComplete, 0, '');
                    }
                },
            );
            scheduleRepair(markdown, STREAMING_MARKDOWN_REMEND_OPTIONS, complete);
        } catch (error) {
            if (!settled) {
                settled = true;
                clearRepairTimeout();
                reject(error);
            }
        }
    });
}

export function repairStreamingMarkdownAsync(markdown: string): Promise<string> {
    const timeoutMs = loadSyncTuning().streamingMarkdownRepairWorkletTimeoutMs;
    const telemetryFields = { chars: markdown.length, timeoutMs };
    const runtime = getRepairRuntime();
    if (runtime == null) {
        syncPerformanceTelemetry.count(STREAMING_MARKDOWN_REPAIR_FALLBACK_EVENT, telemetryFields);
        return Promise.resolve(syncPerformanceTelemetry.measure(
            STREAMING_MARKDOWN_REPAIR_JS_EVENT,
            telemetryFields,
            () => preprocessStreamingMarkdown(markdown),
        ));
    }

    return syncPerformanceTelemetry.measureAsync(
        STREAMING_MARKDOWN_REPAIR_WORKLET_EVENT,
        telemetryFields,
        () => runRepairOnWorklet(runtime, markdown, timeoutMs),
    ).catch(() => {
        syncPerformanceTelemetry.count(STREAMING_MARKDOWN_REPAIR_FALLBACK_EVENT, telemetryFields);
        return syncPerformanceTelemetry.measure(
            STREAMING_MARKDOWN_REPAIR_JS_EVENT,
            telemetryFields,
            () => preprocessStreamingMarkdown(markdown),
        );
    });
}
