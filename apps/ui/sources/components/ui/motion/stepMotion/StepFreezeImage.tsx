import type { StepFreeze } from './stepMotionTypes';

export type StepFreezeImageProps = Readonly<{
    freeze: StepFreeze;
    opacity: readonly number[];
    durationMs: number;
    delayMs: number;
    onCleared: () => void;
}>;

export function StepFreezeImage(_props: StepFreezeImageProps) {
    return null;
}
