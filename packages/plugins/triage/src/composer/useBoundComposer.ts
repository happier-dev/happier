import * as React from 'react';
import { useComposer, type ComposerHandle, type ComposerRefV1 } from '@happier-dev/plugin-ui';

/**
 * One exact Composer handle for the scope this renderer was mounted on
 * (`core/COMPOSER.md` §3).
 *
 * Both Triage Composer renderers bind through here, so there is exactly one
 * place that decides which draft they touch. That place always answers with the
 * ref the host stamped on the mount — never `current()`, never `active()`.
 *
 * `current()` would work on a real Composer mount, and that is precisely why it
 * is not used: it is a *different* fact that happens to coincide today. The
 * moment a Triage renderer is mounted somewhere the host has no mounted
 * Composer for — a destination page reached from the picker, for instance — the
 * two facts diverge, and the exact ref carried in the launch input is the one
 * that still addresses the draft the user was writing in.
 *
 * `get` is deliberately not a probe: it constructs a local handle and lets the
 * first real operation return the canonical unavailable result. A retired scope
 * therefore fails at `read`/`apply` with the host's own verdict rather than
 * being guessed at here.
 */
type TriageBoundComposerV1 = Readonly<{
    /** The scope key this handle was resolved under, never a later one. */
    key: string | null;
    handle: ComposerHandle | null;
}>;

const UNBOUND: TriageBoundComposerV1 = Object.freeze({ key: null, handle: null });

export function useTriageBoundComposer(composer: ComposerRefV1 | null): ComposerHandle | null {
    const composers = useComposer();
    const [bound, setBound] = React.useState<TriageBoundComposerV1>(UNBOUND);

    // The ref is a small closed value the host re-stamps on every mount, so its
    // identity changes without its meaning changing. Keying the effect on the
    // value rather than the object is what keeps one mount from re-binding —
    // and re-reading — on every render.
    const composerKey = composer === null ? null : JSON.stringify(composer);

    React.useEffect(() => {
        if (composer === null) {
            setBound(UNBOUND);
            return;
        }
        let active = true;
        void composers.get(composer).then((next) => {
            if (active) setBound({ key: composerKey, handle: next });
        }, () => {
            if (active) setBound(UNBOUND);
        });
        return () => {
            active = false;
            // A replacement mount must not render the previous draft's state for
            // even one committed frame.
            setBound(UNBOUND);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by value, see above.
    }, [composers, composerKey]);

    // The handle is answered only for the scope it was resolved under. State
    // alone cannot carry that: an effect runs AFTER the render that first
    // carries a replacement ref has committed, so a bare handle addresses the
    // previous draft for exactly one frame — and an Attach pressed in that
    // frame writes the message the reader already left.
    return bound.key === composerKey ? bound.handle : null;
}
