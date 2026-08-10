import * as React from 'react';

import { preprocessStreamingMarkdown } from './preprocessStreamingMarkdown';
import { repairStreamingMarkdownAsync } from './repairStreamingMarkdownAsync';
import {
    STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS,
    STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS,
} from './streamingMarkdownRepairConfig';

type PreparedStreamingMarkdownState = Readonly<{
    sourceMarkdown: string;
    preparedMarkdown: string;
}>;

export type MarkdownStreamingMode = 'static' | 'streaming';

function shouldUseAsyncStreamingRepair(markdown: string): boolean {
    return markdown.length >= STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS;
}

/**
 * Resolves the markdown a streaming message renders.
 *
 * Repairing unterminated markdown costs O(n^2) in the message length, so past
 * {@link STREAMING_MARKDOWN_ASYNC_REPAIR_MIN_CHARS} the repair moves off the render path. The
 * rendered document must still only ever come from a repaired source: rendering the raw markdown
 * between repairs makes already-visible prose revert to literal syntax (`the docs` back to
 * `[the docs](https://exa`) on every chunk. While a newer chunk is still being repaired the hook
 * therefore keeps returning the newest repaired ancestor of the current markdown, and the repair is
 * scheduled so that it always lands rather than being cancelled by the next chunk.
 *
 * "Newest" is the load-bearing word: an ancestor is not automatically a safe answer, and every
 * render path that paints a document is a writer of it. The static path — which the caller swaps
 * to whenever upstream goes quiet — paints the FULL current text, tail included, so it must
 * record what it painted. Otherwise resuming the stream answers from a repaired ancestor and
 * un-paints the tail the settle just showed, which reads as the message reverting to an earlier
 * state and resizes the row under the transcript.
 */
export function usePreparedStreamingMarkdown(params: Readonly<{
    markdown: string;
    mode: MarkdownStreamingMode;
}>): string {
    const markdown = typeof params.markdown === 'string' ? params.markdown : '';
    const useAsyncRepair = params.mode === 'streaming' && shouldUseAsyncStreamingRepair(markdown);
    const [, repaintPreparedMarkdown] = React.useReducer((generation: number) => generation + 1, 0);
    const pendingMarkdownRef = React.useRef<string | null>(null);
    const repairedSourceRef = React.useRef<string | null>(null);
    const repairTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const repairInFlightRef = React.useRef(false);
    const newestPreparedRef = React.useRef<PreparedStreamingMarkdownState | null>(null);

    // Single record of the newest document this hook has already answered with. Every writer —
    // the sync repair, the static path, and a landing async repair — publishes through here, so
    // "which document is newest" is decided once instead of by each reader's precedence rules.
    // The held record survives only while it stays a strict descendant of the incoming one; a
    // rewritten (non-append) document is not comparable and yields to the newer write.
    const recordNewestPrepared = React.useCallback((next: PreparedStreamingMarkdownState) => {
        const current = newestPreparedRef.current;
        const currentIsNewer =
            current != null &&
            current.sourceMarkdown.length >= next.sourceMarkdown.length &&
            current.sourceMarkdown.startsWith(next.sourceMarkdown);
        if (currentIsNewer) return current;
        newestPreparedRef.current = next;
        return next;
    }, []);

    const syncPreparedMarkdown = React.useMemo(() => {
        if (params.mode !== 'streaming') {
            // The static path paints the whole current text. Recording it is what stops a later
            // resume from answering with a repaired ancestor and dropping the painted tail.
            recordNewestPrepared({ sourceMarkdown: markdown, preparedMarkdown: markdown });
            return markdown;
        }
        if (useAsyncRepair) return null;
        const preparedMarkdown = preprocessStreamingMarkdown(markdown);
        // Records the newest synchronously repaired document so growing past the async threshold
        // mid-stream does not paint one raw frame before the first async repair lands.
        recordNewestPrepared({ sourceMarkdown: markdown, preparedMarkdown });
        return preparedMarkdown;
    }, [markdown, params.mode, recordNewestPrepared, useAsyncRepair]);

    const scheduleAsyncRepair = React.useCallback(function scheduleAsyncRepair() {
        if (repairTimeoutRef.current != null || repairInFlightRef.current) return;

        repairTimeoutRef.current = setTimeout(() => {
            repairTimeoutRef.current = null;
            const requestedMarkdown = pendingMarkdownRef.current;
            if (requestedMarkdown == null || requestedMarkdown === repairedSourceRef.current) return;

            const finishRepair = (preparedMarkdown: string) => {
                if (pendingMarkdownRef.current == null) return;
                repairedSourceRef.current = requestedMarkdown;
                // A repair that was already in flight when the stream paused resolves after the
                // pause, so the applied source is ordered by the record rather than assumed from
                // the scheduling: an older repair must never replace a newer document.
                recordNewestPrepared({ sourceMarkdown: requestedMarkdown, preparedMarkdown });
                repaintPreparedMarkdown();
                if (pendingMarkdownRef.current !== requestedMarkdown) scheduleAsyncRepair();
            };

            repairInFlightRef.current = true;
            void repairStreamingMarkdownAsync(requestedMarkdown).then(
                (preparedMarkdown) => {
                    repairInFlightRef.current = false;
                    finishRepair(preparedMarkdown);
                },
                () => {
                    repairInFlightRef.current = false;
                    finishRepair(preprocessStreamingMarkdown(requestedMarkdown));
                },
            );
        }, STREAMING_MARKDOWN_ASYNC_REPAIR_DEBOUNCE_MS);
    }, [recordNewestPrepared, repaintPreparedMarkdown]);

    React.useEffect(() => {
        if (!useAsyncRepair) {
            // Only the scheduling is stood down. The repaired document itself is kept: it is
            // read exclusively while the async path owns rendering, and a stream that settles
            // (static interlude) and then resumes must resume from the newest repair rather
            // than from the pre-threshold sync cache below, which is thousands of characters
            // behind and would visibly restore an earlier state of the message.
            pendingMarkdownRef.current = null;
            if (repairTimeoutRef.current != null) {
                clearTimeout(repairTimeoutRef.current);
                repairTimeoutRef.current = null;
            }
            return;
        }

        // Deliberately does not cancel an already scheduled repair: cancelling on every chunk lets a
        // fast stream starve the repair indefinitely, which is what leaves raw markdown on screen.
        pendingMarkdownRef.current = markdown;
        scheduleAsyncRepair();
    }, [markdown, scheduleAsyncRepair, useAsyncRepair]);

    React.useEffect(() => () => {
        pendingMarkdownRef.current = null;
        if (repairTimeoutRef.current != null) {
            clearTimeout(repairTimeoutRef.current);
            repairTimeoutRef.current = null;
        }
    }, []);

    if (syncPreparedMarkdown != null) return syncPreparedMarkdown;
    const newestPrepared = newestPreparedRef.current;
    if (newestPrepared != null && markdown.startsWith(newestPrepared.sourceMarkdown)) {
        return newestPrepared.preparedMarkdown;
    }
    return markdown;
}
