import * as React from 'react';
import { Platform, type Switch as ReactNativeSwitch, type SwitchProps } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { HappierSwitchNative, type HappierSwitchProps } from '@happier-dev/plugin-ui/presentation';

import { ITEM_ROW_SWITCH, useItemRowAccessibleName, useItemRowOwnsSwitch } from '@/components/ui/lists/ItemRowAccessibleName';

import { Deferred } from './Deferred';
import { resolveAppSwitchPaint } from './switchPaint';

export type AppSwitchProps = SwitchProps & {
    compact?: boolean;
    /** How far the switch's hit area may reach past it on each side (the shared hit-area owner's reach). */
    hitReach?: HappierSwitchProps['hitReach'];
};

/**
 * Happier core's native switch: the shared platform switch (`HappierSwitchNative`, which the plugin
 * `Toggle` renders on native too) in the theme's switch colours. Android mounts it deferred.
 */
/** Hand the shared control's focusable instance to a forwarded ref (focus return after a transient surface). */
function useForwardedControlRef<T>(ref: React.ForwardedRef<T>) {
    return React.useCallback((instance: unknown) => {
        if (typeof ref === 'function') ref(instance as T | null);
        else if (ref) ref.current = instance as T | null;
    }, [ref]);
}

export const Switch = React.forwardRef<React.ElementRef<typeof ReactNativeSwitch>, AppSwitchProps>(function Switch(
    { compact: _compact, style, value, onValueChange, disabled, hitReach, ...rest },
    ref,
) {
    const controlRef = useForwardedControlRef(ref);
    const { theme } = useUnistyles();
    const paint = resolveAppSwitchPaint(theme);
    const rowAccessibleName = useItemRowAccessibleName();
    const rowOwnsSwitch = useItemRowOwnsSwitch();
    const accessibleName = rest.accessibilityLabel ?? rest['aria-label'] ?? rowAccessibleName;
    return (
        <Deferred enabled={Platform.OS === 'android'}>
            <HappierSwitchNative
                value={value === true}
                onValueChange={onValueChange ?? undefined}
                disabled={disabled ?? undefined}
                colors={{
                    trackOn: paint.trackOn.color,
                    trackOff: paint.trackOff.color,
                    thumb: paint.thumb.color,
                    focusRing: paint.focusRing.color,
                }}
                accessibilityLabel={accessibleName}
                accessibilityHint={rest.accessibilityHint}
                nativeID={rest.nativeID}
                testID={rest.testID}
                hitReach={hitReach}
            presentational={rowOwnsSwitch}
                controlRef={controlRef}
                style={style as HappierSwitchProps['style']}
            />
        </Deferred>
    );
});

// The row owns this switch's press when it is a row's accessory (see `readItemRowSwitch`).
(Switch as unknown as Record<symbol, unknown>)[ITEM_ROW_SWITCH] = true;
