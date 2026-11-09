import * as React from 'react';
import type { SwitchProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierSwitch, type HappierSwitchProps } from '@happier-dev/plugin-ui/presentation';

import { ITEM_ROW_SWITCH, useItemRowAccessibleName, useItemRowOwnsSwitch } from '@/components/ui/lists/ItemRowAccessibleName';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

export type AppSwitchProps = SwitchProps & {
    compact?: boolean;
    /** How far the switch's hit area may reach past it on each side (the shared hit-area owner's reach). */
    hitReach?: HappierSwitchProps['hitReach'];
};

/**
 * Happier core's web switch: the shared `HappierSwitch` (which the plugin `Toggle` also renders) in
 * the theme's switch colours. This adapter owns only app facts — the colour tokens, the enclosing
 * row's accessible name and the reduced-motion preference.
 */
/** Hand the shared control's focusable instance to a forwarded ref (focus return after a transient surface). */
function useForwardedControlRef<T>(ref: React.ForwardedRef<T>) {
    return React.useCallback((instance: unknown) => {
        if (typeof ref === 'function') ref(instance as T | null);
        else if (ref) ref.current = instance as T | null;
    }, [ref]);
}

export const Switch = React.forwardRef<unknown, AppSwitchProps>(function Switch(
    { value, disabled, onValueChange, style, compact, hitReach, ...rest },
    ref,
) {
    const controlRef = useForwardedControlRef(ref);
    const { theme } = useUnistyles();
    const rowAccessibleName = useItemRowAccessibleName();
    const rowOwnsSwitch = useItemRowOwnsSwitch();
    const reducedMotion = useReducedMotionPreference();
    const accessibleName = rest['aria-label'] ?? rest.accessibilityLabel ?? rowAccessibleName;

    return (
        <HappierSwitch
            value={value === true}
            onValueChange={onValueChange ?? undefined}
            disabled={disabled ?? undefined}
            size={compact ? 'compact' : 'default'}
            colors={{
                trackOn: theme.colors.switch.track.active,
                trackOff: theme.colors.switch.track.inactive,
                thumb: theme.colors.switch.thumb.active,
                focusRing: theme.colors.border.focus,
            }}
            accessibilityLabel={accessibleName}
            accessibilityHint={rest.accessibilityHint}
            reducedMotion={reducedMotion}
            nativeID={rest.nativeID}
            testID={rest.testID}
            hitReach={hitReach}
            presentational={rowOwnsSwitch}
            controlRef={controlRef}
            // App callers pass React Native styles (layout only); the shared control keeps its own box over them.
            style={style as HappierSwitchProps['style']}
        />
    );
});

// The row owns this switch's press when it is a row's accessory (see `readItemRowSwitch`).
(Switch as unknown as Record<symbol, unknown>)[ITEM_ROW_SWITCH] = true;
