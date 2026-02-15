import * as React from 'react';

function isTruthyParam(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

type Input = Readonly<{
    automationsEnabled: boolean;
    openPickerParam: unknown;
    readyToOpen?: boolean;
    onOpenPicker: () => void;
    clearOpenPickerParam: () => void;
}>;

export function useAutomationPickerAutoOpen(input: Input): void {
    const {
        automationsEnabled,
        openPickerParam,
        readyToOpen = true,
        onOpenPicker,
        clearOpenPickerParam,
    } = input;

    const hasOpenedRef = React.useRef(false);

    React.useEffect(() => {
        if (!automationsEnabled) return;
        if (!readyToOpen) return;
        if (hasOpenedRef.current) return;
        if (!isTruthyParam(openPickerParam)) return;

        hasOpenedRef.current = true;
        onOpenPicker();
        clearOpenPickerParam();
    }, [automationsEnabled, clearOpenPickerParam, onOpenPicker, openPickerParam, readyToOpen]);
}

