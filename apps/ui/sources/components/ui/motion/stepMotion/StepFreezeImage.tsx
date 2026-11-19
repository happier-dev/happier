import type { StepFreeze } from './stepMotionTypes';

export type StepFreezeImageProps = Readonly<{
    freeze: StepFreeze;
    opacity: readonly number[];
    durationMs: number;
    delayMs: number;
}>;

export function StepFreezeImage(_props: StepFreezeImageProps) {
    return null;
}
