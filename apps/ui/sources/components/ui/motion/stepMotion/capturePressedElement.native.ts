import type { GestureResponderEvent } from 'react-native';
import type { StepAnchor } from './stepMotionTypes';

type NativePressTarget = Readonly<{
    id?: string;
    getBoundingClientRect?: () => Readonly<{ x: number; y: number; width: number; height: number }>;
    parentElement?: NativePressTarget | null;
}>;

export function readNativeStepAnchor(event: GestureResponderEvent, layer: object): StepAnchor {
    const target: unknown = event.target;
    let node: NativePressTarget | null | undefined = typeof target === 'object' && target !== null
        ? target as NativePressTarget
        : undefined;
    let measured: StepAnchor | undefined;
    while (node && node !== layer) {
        const rect = node.getBoundingClientRect?.();
        if (rect) {
            if (node.id) return { testID: node.id, rect };
            measured ??= { rect };
        }
        node = node.parentElement;
    }
    const { pageX, pageY } = event.nativeEvent;
    return measured ?? { rect: { x: pageX, y: pageY, width: 0, height: 0 } };
}
