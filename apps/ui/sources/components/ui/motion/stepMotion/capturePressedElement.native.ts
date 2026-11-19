import type { GestureResponderEvent } from 'react-native';
import type { FocusReturnTarget } from '@/keyboard/focusReturn';
import type { StepAnchor } from './stepMotionTypes';

type NativePressTarget = Readonly<{
    id?: string;
    focus?: () => void;
    getBoundingClientRect?: () => Readonly<{ x: number; y: number; width: number; height: number }>;
    parentElement?: NativePressTarget | null;
    children?: Iterable<NativePressTarget>;
}>;

export function readNativeStepAnchor(event: GestureResponderEvent, layer: object): StepAnchor {
    const target: unknown = event.target;
    let node: NativePressTarget | null | undefined = typeof target === 'object' && target !== null
        ? target as NativePressTarget
        : undefined;
    let measured: StepAnchor | undefined;
    while (node && node !== layer) {
        const rect = node.getBoundingClientRect?.();
        if (rect && rect.width > 0 && rect.height > 0) {
            if (node.id) return { testID: node.id, rect };
            measured ??= { rect };
        }
        node = node.parentElement;
    }
    const { pageX, pageY } = event.nativeEvent;
    return measured ?? { rect: { x: pageX, y: pageY, width: 0, height: 0 } };
}

export function findNativeStepAnchor(root: unknown, testID: string): FocusReturnTarget {
    if (!root || typeof root !== 'object') return null;
    const node = root as NativePressTarget;
    if (node.id === testID) return node;
    for (const child of node.children ?? []) {
        const match = findNativeStepAnchor(child, testID);
        if (match) return match;
    }
    return null;
}
