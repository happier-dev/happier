import * as React from 'react';
import type { FocusReturnMutableRef, FocusReturnTarget } from '@/keyboard/focusReturn';

export const StepFocalContext = React.createContext<Readonly<{
    heading: FocusReturnMutableRef;
    focal: FocusReturnMutableRef;
}> | null>(null);

export function useStepFocal(kind: 'heading' | 'focal' = 'focal'): (target: FocusReturnTarget) => void {
    const registration = React.useContext(StepFocalContext)?.[kind];
    return React.useCallback((target: FocusReturnTarget) => {
        if (registration) registration.current = target;
    }, [registration]);
}
