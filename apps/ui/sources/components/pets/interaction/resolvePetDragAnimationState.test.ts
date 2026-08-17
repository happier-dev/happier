import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { COMPANION_DRAG_THRESHOLD_PX } from '@/components/companion/interaction/companionPointerDragConfig';
import {
    resolvePetDragAnimationState,
    resolvePetNativeDragAnimationState,
} from './resolvePetDragAnimationState';

describe('resolvePetDragAnimationState', () => {
    it('turns horizontal motion past the threshold into a running direction', () => {
        expect(resolvePetDragAnimationState(COMPANION_DRAG_THRESHOLD_PX, null)).toBe('running-right');
        expect(resolvePetDragAnimationState(-COMPANION_DRAG_THRESHOLD_PX, null)).toBe('running-left');
        expect(resolvePetDragAnimationState(COMPANION_DRAG_THRESHOLD_PX - 1, 'idle')).toBe('idle');
        expect(resolvePetDragAnimationState(0, null)).toBeNull();
    });

    it('drops the fallback for the native pan slot so a sub-threshold frame publishes nothing', () => {
        expect(resolvePetNativeDragAnimationState(COMPANION_DRAG_THRESHOLD_PX)).toBe('running-right');
        expect(resolvePetNativeDragAnimationState(-COMPANION_DRAG_THRESHOLD_PX)).toBe('running-left');
        expect(resolvePetNativeDragAnimationState(COMPANION_DRAG_THRESHOLD_PX - 1)).toBeNull();
    });

    /**
     * `useCompanionNativePanGesture` calls `resolveDragState` from inside `Gesture.Pan().onUpdate`,
     * which the worklets Babel plugin runs on the UI runtime. A plain JS function there throws on
     * the UI thread. No test can observe that: every gesture test in this package invokes the
     * handlers on the JS thread, where a non-worklet call succeeds — so the directive itself is the
     * only checkable form of the contract, exactly as `useComposerKeyboardLayout.native.ts` records
     * it for its own worklet helper.
     *
     * The Voice orb is the positive control: `useVoiceOrbDrag` marks the arrow it hands to the
     * sibling `resolveReleaseTarget` slot.
     */
    it('marks both pet drag-state resolvers as worklets', () => {
        const source = readFileSync(new URL('./resolvePetDragAnimationState.ts', import.meta.url), 'utf8');

        expect(source).toMatch(/function resolvePetDragAnimationState[^{]*{\s*['"]worklet['"];/s);
        expect(source).toMatch(/function resolvePetNativeDragAnimationState[^{]*{\s*['"]worklet['"];/s);
    });
});
