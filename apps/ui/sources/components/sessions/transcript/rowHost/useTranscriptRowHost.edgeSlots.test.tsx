import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { OlderLoadContinuationOverlay } from '@/components/sessions/transcript/OlderLoadContinuationOverlay';
import {
    resolveMainTranscriptListShellFrame,
} from '@/components/sessions/transcript/viewport/shell/transcriptListShellCapabilities';

import { useTranscriptItemsEdgeSlots } from './useTranscriptRowHost';

describe('useTranscriptItemsEdgeSlots', () => {
    it('keeps retained underfilled history reachable through the canonical older pager', async () => {
        // A sidechain-only initial-fill page can leave a short transcript with a live older
        // cursor. There is no scroll threshold to re-arm, so the mounted UI must expose the
        // pager-owned continuation instead of rendering an empty, inert root.
        const onContinueOlderPagination = vi.fn();
        const hook = await renderHook(() => useTranscriptItemsEdgeSlots({
            bottomNotice: null,
            composerInsetHeight: 0,
            controlSwitchTo: null,
            controlledByUserOverride: undefined,
            externalControlFooter: undefined,
            handleComposerInsetHeightChange: vi.fn(),
            isLoadingOlder: false,
            mainTranscriptListShellFrame: resolveMainTranscriptListShellFrame({
                platformOS: 'web',
            }),
            onRequestSwitchToRemote: undefined,
            olderPaginationIsLoadingOlder: false,
            olderPaginationLoadFailed: false,
            olderPaginationCanContinue: true,
            onRetryOlderPagination: vi.fn(),
            onContinueOlderPagination,
            renderTranscriptItemAtIndex: () => null,
            sessionId: 'session-underfilled',
            showCatchUpOverlay: false,
            showFirstPaintPlaceholder: false,
            transcriptOlderLoadSpinnerDelayMs: 0,
        }));

        const overlay = hook.getCurrent().olderLoadOverlay;
        expect(React.isValidElement(overlay)).toBe(true);
        expect((overlay as React.ReactElement).type).toBe(OlderLoadContinuationOverlay);

        await act(async () => {
            ((overlay as React.ReactElement<{ onContinue: () => void }>).props.onContinue)();
        });
        expect(onContinueOlderPagination).toHaveBeenCalledTimes(1);
        await hook.unmount();
    });
});
