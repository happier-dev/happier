import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { resolveRichEligibility } from '@/components/ui/markdown/editor/core/eligibility/richEligibility';
import type { MarkdownRichIneligibleReason } from '@/components/ui/markdown/editor/core/eligibility/markdownRichEligibility';
import type { MarkdownEditMode } from '@/components/ui/markdown/editor/markdownEditorTypes';

/**
 * Generic Raw <-> Rich edit-mode state machine for ANY markdown-capable editor
 * surface (Lane A). It is the reusable sibling of the file-pane's
 * `useMarkdownFileEditMode`, decoupled from `useWorkspaceFileEditorState`.
 *
 * Key difference from the file-pane hook: the CALLER's `value` is the single
 * source of truth (typically React component state the host also saves from).
 * Because `value` is authoritative there is NO local seed bookkeeping and no
 * remount-on-host-reseed dance — `value` IS the seed fed to the active surface,
 * so when the host changes `value` the surface naturally reseeds. We still own a
 * remount `nonce` so a mode TOGGLE forces a clean remount of the incoming
 * surface (the active rich/raw surface keys off the composite `resetKey`).
 *
 * The data-loss traps it avoids (same as the file-pane hook):
 *  - On toggle we `await editorHandleRef.current?.flushPendingChange()` so any
 *    debounced-but-uncommitted edit in the OUTGOING surface lands in `value`
 *    before we switch (R-A6 / R-A12). The surface's own debounced `onChange`
 *    pushes the flushed text into `value`, so we do not need to read+reseed it.
 *  - On a native bundle/`error` fallback the surface hands the freshest markdown
 *    directly via `onUnavailable(latest)`; we forward it to `onValueChange` and
 *    drop to raw SYNCHRONOUSLY in one handler (R-A17).
 *
 * `.mdx` (and any non-`markdown` language) is never rich-eligible (R-A1): the
 * eligibility gate returns `mdx` and the toggle is hidden when the language is
 * not `'markdown'`.
 *
 * A `modeSwitching` ref guards against a double-tap toggling mid-flush (R-A20).
 */

export type MarkdownEditModeState = Readonly<{
    /** Active edit mode (`'raw'` | `'rich'`). */
    markdownEditMode: MarkdownEditMode;
    /** Whether the current value can be rich-edited (flag on, `.md`, in-budget, round-trippable). */
    richEligible: boolean;
    /** Why rich is unavailable (drives the menu's disabled-reason copy). */
    richDisabledReason?: MarkdownRichIneligibleReason;
    /** Composite reset key remounting the active surface on mode switch / host reseed. */
    resetKey: string;
    /** Whether the Raw/Rich toggle should be offered (flag on AND markdown language). */
    showToggle: boolean;
    /** Flush the outgoing surface, then switch to `next` (R-A6). */
    onToggle: (next: MarkdownEditMode) => Promise<void>;
    /** Native fallback: seed raw from the freshest markdown and drop to raw mode (R-A17). */
    onUnavailable: (latest: string) => void;
}>;

export function useMarkdownEditMode(input: Readonly<{
    /** Authoritative markdown value (the host's state — also what it saves from). */
    value: string;
    /** Detected language for the value (`'markdown'` only is rich-eligible). */
    language: string | null;
    /** Host's authoritative base reset key (changes on external reseed). */
    baseResetKey: string;
    /** Imperative handle of the active surface (rich or raw); methods optional-chained. */
    editorHandleRef: Readonly<React.MutableRefObject<CodeEditorHandle | null>>;
    /** Keeps the host's `value` current (forwarded on the native fallback). */
    onValueChange: (next: string) => void;
}>): MarkdownEditModeState {
    const markdownRichEditorEnabled = useFeatureEnabled('files.markdownRichEditor');
    const markdownDefaultEditMode = useSetting('markdownDefaultEditMode');
    const maxBytes = useSetting('filesMarkdownRichEditorMaxBytes');
    const htmlRoundTripMaxBytes = useSetting('filesMarkdownRichEditorHtmlRoundTripMaxBytes');

    const [markdownEditMode, setMarkdownEditMode] = React.useState<MarkdownEditMode>(
        markdownDefaultEditMode === 'raw' ? 'raw' : 'rich',
    );
    // Remount nonce so a mode TOGGLE forces a clean surface remount (R-A12).
    const [markdownModeResetNonce, setMarkdownModeResetNonce] = React.useState(0);

    // Re-entrancy guard so a double-tap mid-flush can't corrupt the switch (R-A20).
    const modeSwitching = React.useRef(false);

    // The toggle is offered only for markdown (and only when the flag is on). The
    // `.mdx` (and any non-`markdown`) language fails this gate so it stays raw.
    const showToggle = markdownRichEditorEnabled && input.language === 'markdown';

    // Eligibility is decided on the freshest authoritative `value` the rich surface
    // would receive. Rich is offered only for clean, in-budget `.md` (flag on).
    const eligibility = React.useMemo(() => {
        if (!markdownRichEditorEnabled) {
            return { eligible: false, reason: undefined as MarkdownRichIneligibleReason | undefined };
        }
        const result = resolveRichEligibility(input.value, {
            language: input.language,
            maxBytes,
            htmlRoundTripMaxBytes,
        });
        return { eligible: result.eligible, reason: result.reason };
    }, [markdownRichEditorEnabled, input.value, input.language, maxBytes, htmlRoundTripMaxBytes]);

    const richEligible = eligibility.eligible;

    const onToggle = React.useCallback(async (next: MarkdownEditMode): Promise<void> => {
        if (next === markdownEditMode) return;
        // Guard against a double-tap arriving while a flush is still in flight.
        if (modeSwitching.current) return;
        modeSwitching.current = true;
        try {
            // Flush any debounced edit out of the outgoing surface before we switch
            // (avoids the debounce-loss trap — R-A6). The surface's flushed onChange
            // pushes the latest text into the host's `value`, which becomes the seed
            // for the incoming surface, so we do not read/reseed it here.
            await input.editorHandleRef.current?.flushPendingChange?.();
            setMarkdownModeResetNonce((nonce) => nonce + 1);
            setMarkdownEditMode(next);
        } finally {
            modeSwitching.current = false;
        }
    }, [markdownEditMode, input.editorHandleRef]);

    const onUnavailable = React.useCallback((latest: string): void => {
        // Synchronous handoff (R-A17): push the freshest markdown into the host's
        // `value` and drop to raw mode in the same handler.
        input.onValueChange(latest);
        setMarkdownModeResetNonce((nonce) => nonce + 1);
        setMarkdownEditMode('raw');
        modeSwitching.current = false;
    }, [input.onValueChange]);

    const resetKey = `${input.baseResetKey}:${markdownEditMode}:${markdownModeResetNonce}`;

    return {
        markdownEditMode,
        richEligible,
        richDisabledReason: richEligible ? undefined : eligibility.reason,
        resetKey,
        showToggle,
        onToggle,
        onUnavailable,
    };
}
