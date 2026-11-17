import * as React from 'react';
import { prepareThemeCssAsync, readPreparedThemeCss } from './prepareThemeCss';
import type { PreparedThemeCss } from './types';

/** Visible projection consumers share the preparation owner's first-use acquisition. */
export function usePreparedThemeCss(source: string, presented = true): Readonly<{
    prepared: PreparedThemeCss | null;
    error: unknown | null;
    retry: () => void;
}> {
    const [attempt, retry] = React.useReducer((current: number) => current + 1, 0);
    const [settled, setSettled] = React.useState<Readonly<{
        source: string; prepared?: PreparedThemeCss; error?: unknown;
    }> | null>(null);
    // Retain the current weakly-interned preparation across renders, while still
    // noticing acquisition completed by an Action or another visible consumer.
    const retained = React.useRef<PreparedThemeCss | null>(null);
    const prepared = retained.current?.source === source ? retained.current : readPreparedThemeCss(source);
    retained.current = prepared;
    React.useEffect(() => {
        if (!presented || prepared) return;
        let active = true;
        void prepareThemeCssAsync(source).then(value => {
            if (active) setSettled({ source, prepared: value });
        }, error => { if (active) setSettled({ source, error }); });
        return () => { active = false; };
    }, [source, prepared, presented, attempt]);
    const current = settled?.source === source ? settled : null;
    return { prepared: prepared ?? current?.prepared ?? null, error: prepared ? null : current?.error ?? null, retry };
}
