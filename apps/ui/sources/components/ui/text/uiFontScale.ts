import {
    cloneStyleEntryPreservingOwnProps,
    scaleTextStyleMetrics,
    type ScaledTextStyleMetrics,
    type TextStyleEntryTransform,
} from '@happier-dev/plugin-ui/presentation';
import type { StyleProp, TextStyle } from 'react-native';

/**
 * Happier core's style-system adapter for UI text scaling.
 *
 * The portable mechanism — style-array traversal, own-property preserving
 * cloning and numeric metric scaling — moved to the shared presentation owner
 * (`@happier-dev/plugin-ui/presentation`), which Happier core and plugin
 * surfaces both render (UI-T27).
 *
 * What stays here is the part that is genuinely ours: Unistyles runtime secrets.
 * A Unistyles style entry hides its real values behind a `unistyles_*` key whose
 * value exposes `uni__getStyles()`, resolved lazily at render. Those runtime
 * objects are private product infrastructure (§3.10.8) and an external plugin
 * author never produces one, so unwrapping them is an app concern that plugs
 * back into the shared traversal through its entry-transform seam.
 */
const UNISTYLES_SECRET_KEY_PREFIX = 'unistyles_';

function wrapUnistylesSecret(secret: any, uiFontScale: number): any {
    if (!secret || typeof secret !== 'object' || typeof secret.uni__getStyles !== 'function') {
        return secret;
    }

    const wrappedSecret: any = cloneStyleEntryPreservingOwnProps(secret);
    const originalGetStyles = secret.uni__getStyles.bind(secret);
    wrappedSecret.uni__getStyles = () => scaleTextStyle(originalGetStyles(), uiFontScale);
    return wrappedSecret;
}

/**
 * Scale the metrics a Unistyles entry resolves lazily.
 *
 * Identity is preserved when nothing changes so the shared traversal can keep
 * returning the caller's original style reference.
 */
export const scaleUnistylesTextStyleEntry: TextStyleEntryTransform = (entry, uiFontScale) => {
    const secretKeys = Object.keys(entry).filter((key) => key.startsWith(UNISTYLES_SECRET_KEY_PREFIX));
    if (secretKeys.length === 0) return entry;

    let nextEntry: any = entry;
    let changed = false;

    for (const secretKey of secretKeys) {
        const scaledSecret = wrapUnistylesSecret((entry as any)[secretKey], uiFontScale);
        if (scaledSecret === (entry as any)[secretKey]) continue;
        if (!changed) {
            nextEntry = cloneStyleEntryPreservingOwnProps(entry);
            changed = true;
        }
        try {
            nextEntry[secretKey] = scaledSecret;
        } catch {
            return entry;
        }
    }

    return changed ? nextEntry : entry;
};

export function scaleTextStyle<T extends StyleProp<TextStyle> | undefined | null>(
    style: T,
    uiFontScale: number
): ScaledTextStyleMetrics<T> {
    return scaleTextStyleMetrics(style, uiFontScale, { transformEntry: scaleUnistylesTextStyleEntry });
}
