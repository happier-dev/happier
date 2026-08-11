import * as React from 'react';

/**
 * Keep the previous object identity while a caller-computed signature is unchanged.
 *
 * A selector that rebuilds `{...}` or `[...]` on every store tick hands its consumer a new
 * reference even when nothing it contains changed, so every `useMemo`, `useEffect` and
 * `React.memo` downstream re-runs. The signature — a cheap string the caller derives from the few
 * fields it actually cares about — decides when that identity is allowed to move.
 *
 * The caller owns the signature deliberately: only it knows which fields are load-bearing, and a
 * generic deep compare here would pay for the whole object on every tick to answer a question about
 * three of its fields.
 *
 * **One implementation, on purpose.** This hook had been hand-copied into seven modules — the
 * transcript root, the agent roster and five new-session hooks — each with the same body and its
 * own subtly different ref initialisation. Nothing was wrong with any copy, which is exactly why
 * seven of them existed; the cost is that a fix to the memo semantics has to find all seven.
 */
export function useStableValueBySignature<T>(value: T, signature: string): T {
    const ref = React.useRef<{ signature: string; value: T }>({ signature, value });
    if (ref.current.signature !== signature) {
        ref.current = { signature, value };
    }
    return ref.current.value;
}
