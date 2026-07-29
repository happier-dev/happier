import * as React from 'react';

export function useAgentInputExternalPickerRequest(input: Readonly<{
    requestKey: string | null | undefined;
    open: () => void;
}>): void {
    const lastHandledKey = React.useRef<string | null>(null);
    React.useEffect(() => {
        const key = input.requestKey?.trim() ?? '';
        if (!key || key === lastHandledKey.current) return;
        lastHandledKey.current = key;
        input.open();
    }, [input.open, input.requestKey]);
}
