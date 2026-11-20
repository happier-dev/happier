import * as React from 'react';
import type { FocusReturnMutableRef, FocusReturnTarget } from '@/keyboard/focusReturn';

export const StepFocalContext = React.createContext<Readonly<{
    heading: FocusReturnMutableRef;
    focal: FocusReturnMutableRef;
    awaitingFocalFrom: React.MutableRefObject<HTMLElement | null>;
    registerFocal: (target: FocusReturnTarget) => void;
}> | null>(null);

export function useStepFocal(kind: 'heading' | 'focal' = 'focal'): (target: FocusReturnTarget) => void {
    const owner = React.useContext(StepFocalContext);
    return React.useCallback((target: FocusReturnTarget) => {
        if (!owner) return;
        if (kind === 'heading') owner.heading.current = target;
        else owner.registerFocal(target);
    }, [kind, owner]);
}
