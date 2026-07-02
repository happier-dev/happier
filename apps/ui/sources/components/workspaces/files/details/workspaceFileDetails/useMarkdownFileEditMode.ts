import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';
import { getFileLanguageFromPath } from '@/utils/code/fileLanguage';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { resolveRichEligibility } from '@/components/ui/markdown/editor/core/eligibility/richEligibility';
import type { MarkdownRichIneligibleReason } from '@/components/ui/markdown/editor/core/eligibility/markdownRichEligibility';
import type { MarkdownEditMode } from '@/components/ui/markdown/editor/markdownEditorTypes';

/**
 * Owns the Raw <-> Rich edit-mode state for the markdown file editor (Lane I /
 * R-A20). It is the SINGLE place that knows how to switch modes without losing
 * content, so the workspace-centric integration files
 * (`WorkspaceFileDetailsView` + `FileActionToolbar`) only wire it.
 *
 * Why this hook exists (the data-loss traps it avoids):
 *  - `useWorkspaceFileEditorState` is reused UNCHANGED (D5). Its save path
 *    early-returns BEFORE `flushPendingChange()` when the tracked text equals the
 *    original, so a debounced-but-not-yet-flushed edit could be silently dropped
 *    on a mode switch. Toggling therefore flushes the outgoing surface and seeds
 *    the incoming one from the freshest value (R-A6/R-A12).
 *  - The hook can't ask `useWorkspaceFileEditorState` to reseed/remount on
 *    demand, so it keeps its OWN local seed (`markdownEditorSeedText`) + a remount
 *    nonce (`markdownModeResetNonce`) and feeds the active surface a composite
 *    `resetKey` (`${editorResetKey}:${mode}:${nonce}`). Whenever the host's
 *    authoritative `editorResetKey` changes (external refresh / cancel / save)
 *    the local seed is reset back to the host's seed and the nonce is bumped, so
 *    host-driven reseeds always win.
 *  - On a native bundle/`error` fallback the surface hands the freshest markdown
 *    directly via `onUnavailable(latestDoc)`; we seed raw from it SYNCHRONOUSLY
 *    in one handler (a separate batched `onChange` would be unreliable — R-A17).
 *
 * A `modeSwitching` ref guards against a double-tap toggling mid-flush from
 * corrupting the seed (R-A20).
 */

export type MarkdownFileEditModeState = Readonly<{
    /** Active edit mode (`'raw'` | `'rich'`). */
    markdownEditMode: MarkdownEditMode;
    /** Whether the current file can be rich-edited (flag on, `.md`, in-budget, round-trippable). */
    richEligible: boolean;
    /** Why rich is unavailable (drives the toggle's disabled reason copy). */
    richDisabledReason?: MarkdownRichIneligibleReason;
    /** Markdown to seed the active surface with (host seed, mode-switched, or fallback-latest). */
    seedText: string;
    /** Composite reset key remounting the active surface on host reseed or mode switch. */
    resetKey: string;
    /** Flush the outgoing surface, preserve its latest value, then switch to `next` (R-A6). */
    onToggle: (next: MarkdownEditMode) => Promise<void>;
    /** Native fallback: seed raw from the freshest markdown and drop to raw mode (R-A17). */
    onUnavailable: (latestDoc: string) => void;
}>;

type RafHandle = number | ReturnType<typeof setTimeout>;

function scheduleFrame(callback: () => void): RafHandle {
    if (typeof globalThis.requestAnimationFrame === 'function') {
        return globalThis.requestAnimationFrame(() => callback());
    }
    return setTimeout(callback, 0);
}

function cancelScheduledFrame(handle: RafHandle): void {
    if (typeof globalThis.cancelAnimationFrame === 'function' && typeof handle === 'number') {
        globalThis.cancelAnimationFrame(handle);
        return;
    }
    clearTimeout(handle);
}

export function useMarkdownFileEditMode(input: Readonly<{
    /** File path (drives language detection — `.md` only is rich-eligible). */
    filePath: string;
    /** Host's authoritative seed for the editor (from `useWorkspaceFileEditorState`). */
    editorSeedText: string;
    /** Host's authoritative reset key — changes on external refresh / cancel / save. */
    editorResetKey: number;
    /** Imperative handle of the active surface (rich or raw); both methods optional-chained. */
    editorHandleRef: Readonly<React.MutableRefObject<CodeEditorHandle | null>>;
    /** Keeps the host's tracked text + dirty state current (we forward the flushed value). */
    onEditorChange: (value: string) => void;
    /** Host fallback when the surface handle is unavailable (returns the tracked text). */
    getEditorText: () => string;
}>): MarkdownFileEditModeState {
    const markdownRichEditorEnabled = useFeatureEnabled('files.markdownRichEditor');
    const markdownDefaultEditMode = useSetting('markdownDefaultEditMode');
    const maxBytes = useSetting('filesMarkdownRichEditorMaxBytes');
    const htmlRoundTripMaxBytes = useSetting('filesMarkdownRichEditorHtmlRoundTripMaxBytes');

    const language = React.useMemo(() => getFileLanguageFromPath(input.filePath), [input.filePath]);

    const [markdownEditMode, setMarkdownEditMode] = React.useState<MarkdownEditMode>(
        markdownDefaultEditMode === 'raw' ? 'raw' : 'rich',
    );
    // Local seed + remount nonce (the host hook can't reseed on demand — R-A12).
    const [markdownEditorSeedText, setMarkdownEditorSeedText] = React.useState(input.editorSeedText);
    const [liveMarkdownText, setLiveMarkdownText] = React.useState(input.editorSeedText);
    const [markdownModeResetNonce, setMarkdownModeResetNonce] = React.useState(0);

    // Re-entrancy guard so a double-tap mid-flush can't corrupt the seed (R-A20).
    const modeSwitching = React.useRef(false);

    // Whenever the host's authoritative reset key changes (external refresh /
    // cancel / save), the host's seed wins: reset the local seed and remount.
    const lastEditorResetKeyRef = React.useRef(input.editorResetKey);
    React.useEffect(() => {
        if (lastEditorResetKeyRef.current === input.editorResetKey) return;
        lastEditorResetKeyRef.current = input.editorResetKey;
        modeSwitching.current = false;
        setMarkdownEditorSeedText(input.editorSeedText);
        setLiveMarkdownText(input.editorSeedText);
        setMarkdownModeResetNonce((nonce) => nonce + 1);
    }, [input.editorResetKey, input.editorSeedText]);

    React.useEffect(() => {
        if (markdownEditMode !== 'raw') {
            setLiveMarkdownText((current) => current === markdownEditorSeedText ? current : markdownEditorSeedText);
            return;
        }

        let active = true;
        let frameHandle: RafHandle | null = null;

        const syncLiveMarkdownText = () => {
            if (!active) return;
            const nextLiveMarkdownText = input.editorHandleRef.current?.getValue?.() ?? input.getEditorText();
            setLiveMarkdownText((current) => current === nextLiveMarkdownText ? current : nextLiveMarkdownText);
            frameHandle = scheduleFrame(syncLiveMarkdownText);
        };

        syncLiveMarkdownText();

        return () => {
            active = false;
            if (frameHandle !== null) {
                cancelScheduledFrame(frameHandle);
            }
        };
    }, [input.editorHandleRef, input.getEditorText, markdownEditMode, markdownEditorSeedText]);

    // Eligibility is decided on the live raw text while the raw surface is active,
    // otherwise on the latest rich/raw seed. This keeps the file-pane toggle in
    // sync with authoritative edits instead of only host reseeds.
    const eligibilityText = markdownEditMode === 'raw' ? liveMarkdownText : markdownEditorSeedText;
    const eligibility = React.useMemo(() => {
        if (!markdownRichEditorEnabled) {
            return { eligible: false, reason: undefined as MarkdownRichIneligibleReason | undefined };
        }
        const result = resolveRichEligibility(eligibilityText, {
            language,
            maxBytes,
            htmlRoundTripMaxBytes,
        });
        return { eligible: result.eligible, reason: result.reason };
    }, [eligibilityText, htmlRoundTripMaxBytes, language, markdownRichEditorEnabled, maxBytes]);

    const richEligible = eligibility.eligible;

    const onToggle = React.useCallback(async (next: MarkdownEditMode): Promise<void> => {
        // Guard against a double-tap arriving while a flush is still in flight.
        if (modeSwitching.current) return;
        modeSwitching.current = true;
        try {
            const handle = input.editorHandleRef.current;
            // Flush any debounced edit out of the outgoing surface before we read it
            // (avoids the save-path early-return + debounce-loss trap — R-A6).
            await handle?.flushPendingChange?.();
            const latest = handle?.getValue?.() ?? input.getEditorText();
            // Keep the host hook's tracked text + dirty state current, then reseed
            // the incoming surface from that exact value and remount it.
            input.onEditorChange(latest);
            setMarkdownEditorSeedText(latest);
            setLiveMarkdownText(latest);
            setMarkdownModeResetNonce((nonce) => nonce + 1);
            setMarkdownEditMode(next);
        } finally {
            modeSwitching.current = false;
        }
    }, [input.editorHandleRef, input.getEditorText, input.onEditorChange]);

    const onUnavailable = React.useCallback((latestDoc: string): void => {
        // Synchronous handoff (R-A17): seed raw from the freshest markdown the
        // surface handed us and drop to raw mode in the same handler.
        input.onEditorChange(latestDoc);
        setMarkdownEditorSeedText(latestDoc);
        setLiveMarkdownText(latestDoc);
        setMarkdownEditMode('raw');
        modeSwitching.current = false;
    }, [input.onEditorChange]);

    const resetKey = `${input.editorResetKey}:${markdownEditMode}:${markdownModeResetNonce}`;

    return {
        markdownEditMode,
        richEligible,
        richDisabledReason: richEligible ? undefined : eligibility.reason,
        seedText: markdownEditorSeedText,
        resetKey,
        onToggle,
        onUnavailable,
    };
}
