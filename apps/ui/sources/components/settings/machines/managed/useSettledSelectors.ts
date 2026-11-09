import * as React from 'react';

/** The same typing pause the app's search reads wait for before asking the server. */
export const MANAGED_OPTIONS_EDIT_PAUSE_MS = 300;

/**
 * The value the provider's options are read with. Edits to a launch field are read once the person pauses,
 * so typing "16" asks once, not for "1" and then "16". The first value, and any value arriving while
 * nothing is settled yet or after one is withdrawn, is read at once. The fields themselves always show
 * the live draft; only the read follows this.
 */
export function useSettledSelectors<T>(value: T | null, key: string): T | null {
    const [settled, setSettled] = React.useState<Readonly<{ key: string; value: T | null }>>({ key, value });
    const latest = React.useRef(value);
    latest.current = value;
    const pending = settled.key !== key;
    const immediate = value === null || settled.value === null;
    React.useEffect(() => {
        if (!pending) return;
        if (immediate) { setSettled({ key, value: latest.current }); return; }
        const handle = setTimeout(() => setSettled({ key, value: latest.current }), MANAGED_OPTIONS_EDIT_PAUSE_MS);
        return () => clearTimeout(handle);
    }, [pending, immediate, key]);
    return pending && !immediate ? settled.value : value;
}
