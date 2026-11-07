import { requestRegisteredComposerFocus, subscribeComposerPresentationTarget } from '@/components/sessions/presentation/sessionComposerPresentationTargets';

/** Focuses a draft's composer as soon as it registers (a draft switch remounts it). Returns the cancel. */
export function focusNewSessionComposerWhenPresented(draftId: string): () => void {
    const ref = { kind: 'newSession' as const, instanceId: draftId };
    let unsubscribe: (() => void) | undefined;
    const focus = () => {
        unsubscribe?.();
        unsubscribe = undefined;
        if (!requestRegisteredComposerFocus(ref)) unsubscribe = subscribeComposerPresentationTarget(ref, focus);
    };
    focus();
    return () => unsubscribe?.();
}
