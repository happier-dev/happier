import * as React from 'react';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/store/settingsReadHooks';
import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { useRichEligibility } from '@/components/ui/markdown/editor/core/eligibility/richEligibility';
import type { MarkdownRichIneligibleReason } from '@/components/ui/markdown/editor/core/eligibility/markdownRichEligibility';
import type { MarkdownEditMode } from '@/components/ui/markdown/editor/markdownEditorTypes';
import { useMarkdownLiveValue, type MarkdownLiveValueStore } from './useMarkdownLiveValue';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Shared Raw <-> Rich owner for controlled fields and ref-backed file buffers.
 * Flush then read preserves pending input on a switch. Native fallback supplies
 * its newest text directly. A later host value/reset key always replaces that
 * handoff, while the live store updates eligibility without changing the seed.
 */

export type MarkdownEditModeState = Readonly<{
    seedText: string;
    showRich: boolean;
    /** Active edit mode (`'raw'` | `'rich'`). */
    markdownEditMode: MarkdownEditMode;
    /** Whether the current value can be rich-edited (flag on, `.md`, in-budget, round-trippable). */
    richEligible: boolean;
    richEligibilityPending: boolean;
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
    editorHandleRef: Readonly<React.MutableRefObject<TextEditorHandle | null>>;
    /** Keeps the host's `value` current (forwarded on the native fallback). */
    onValueChange: (next: string) => void;
    liveValue?: MarkdownLiveValueStore;
    active?: boolean;
}>): MarkdownEditModeState {
    const markdownRichEditorEnabled = useFeatureEnabled('files.markdownRichEditor');
    const markdownDefaultEditMode = useSetting('markdownDefaultEditMode');
    const maxBytes = useSetting('filesMarkdownRichEditorMaxBytes');
    const htmlRoundTripMaxBytes = useSetting('filesMarkdownRichEditorHtmlRoundTripMaxBytes');

    // Remount nonce so a mode TOGGLE forces a clean surface remount (R-A12).
    const [markdownModeResetNonce, setMarkdownModeResetNonce] = React.useState(0);
    const [handoff, setHandoff] = React.useState<Readonly<{ baseResetKey: string; hostValue: string; text: string }> | null>(null);
    const seedText = handoff?.baseResetKey === input.baseResetKey && handoff.hostValue === input.value ? handoff.text : input.value;
    React.useEffect(() => {
        setHandoff((current) => current && (current.baseResetKey !== input.baseResetKey || current.hostValue !== input.value) ? null : current);
    }, [input.baseResetKey, input.value]);
    const inputRef = React.useRef(input);
    inputRef.current = input;

    // Re-entrancy guard so a double-tap mid-flush can't corrupt the switch (R-A20).
    const modeSwitching = React.useRef(false);

    // The toggle is offered only for markdown (and only when the flag is on). The
    // `.mdx` (and any non-`markdown`) language fails this gate so it stays raw.
    const showToggle = markdownRichEditorEnabled && input.language === 'markdown';

    // Eligibility is decided on the freshest authoritative `value` the rich surface
    // would receive. Rich is offered only for clean, in-budget `.md` (flag on).
    const eligibilityText = useMarkdownLiveValue(seedText, input.liveValue, input.active);
    const eligibility = useRichEligibility(eligibilityText, {
        language: markdownRichEditorEnabled ? input.language : null,
        maxBytes,
        htmlRoundTripMaxBytes,
    });

    const richEligible = eligibility.eligible;
    const [markdownEditMode, setMarkdownEditMode] = React.useState<MarkdownEditMode>(
        markdownDefaultEditMode === 'raw' || (!richEligible && !eligibility.pending) ? 'raw' : 'rich',
    );
    // Once admitted, the mounted rich surface owns its buffer until an explicit
    // switch. Eligibility changes must neither evict it nor auto-promote raw.
    const committedRich = React.useRef({ baseResetKey: input.baseResetKey, visible: false });
    const showRich = markdownEditMode === 'rich' && (richEligible || (committedRich.current.baseResetKey === input.baseResetKey && committedRich.current.visible));
    React.useEffect(() => {
        committedRich.current = { baseResetKey: input.baseResetKey, visible: showRich };
        if (markdownEditMode === 'rich' && !showRich && !eligibility.pending) setMarkdownEditMode('raw');
    }, [eligibility.pending, input.baseResetKey, markdownEditMode, showRich]);

    const onToggle = React.useCallback(async (next: MarkdownEditMode): Promise<void> => {
        if (next === markdownEditMode) return;
        // Guard against a double-tap arriving while a flush is still in flight.
        if (modeSwitching.current) return;
        modeSwitching.current = true;
        const outgoing = inputRef.current;
        const handle = outgoing.editorHandleRef.current;
        try {
            // The outgoing surface may still hold text ahead of the host debounce.
            await handle?.flushPendingChange?.();
            // A disk refresh/cancel during the flush owns the new seed. Native
            // fallback likewise retires the pending switch before mounting raw.
            if (!modeSwitching.current || inputRef.current.baseResetKey !== outgoing.baseResetKey) return;
            const latest = handle?.getValue() ?? outgoing.liveValue?.get() ?? outgoing.value;
            outgoing.onValueChange(latest);
            setHandoff({ baseResetKey: outgoing.baseResetKey, hostValue: outgoing.value, text: latest });
            setMarkdownModeResetNonce((nonce) => nonce + 1);
            setMarkdownEditMode(next);
        } catch {
            if (modeSwitching.current && inputRef.current.baseResetKey === outgoing.baseResetKey) {
                Modal.alert(t('common.error'), t('errors.operationFailed'));
            }
        } finally {
            modeSwitching.current = false;
        }
    }, [markdownEditMode]);

    const onUnavailable = React.useCallback((latest: string): void => {
        // Synchronous handoff (R-A17): push the freshest markdown into the host's
        // `value` and drop to raw mode in the same handler.
        const current = inputRef.current;
        current.onValueChange(latest);
        setHandoff({ baseResetKey: current.baseResetKey, hostValue: current.value, text: latest });
        setMarkdownModeResetNonce((nonce) => nonce + 1);
        setMarkdownEditMode('raw');
        modeSwitching.current = false;
    }, []);

    const resetKey = `${input.baseResetKey}:${markdownEditMode}:${markdownModeResetNonce}`;

    return {
        seedText,
        showRich,
        markdownEditMode,
        richEligible,
        richEligibilityPending: eligibility.pending === true,
        richDisabledReason: richEligible || !markdownRichEditorEnabled ? undefined : eligibility.reason,
        resetKey,
        showToggle,
        onToggle,
        onUnavailable,
    };
}
