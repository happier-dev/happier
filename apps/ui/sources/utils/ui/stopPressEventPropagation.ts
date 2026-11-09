import type { HappierPressableProps } from '@happier-dev/plugin-ui/presentation';

/** Keep an embedded control's press from also activating its enclosing row. */
export function stopPressEventPropagation(event: Parameters<HappierPressableProps['onPress']>[0]): void {
    if (event && typeof event.stopPropagation === 'function') {
        event.stopPropagation();
    }
    const nativeEvent = event?.nativeEvent;
    if (nativeEvent && typeof nativeEvent === 'object'
        && 'stopImmediatePropagation' in nativeEvent
        && typeof nativeEvent.stopImmediatePropagation === 'function') {
        nativeEvent.stopImmediatePropagation();
    }
}
