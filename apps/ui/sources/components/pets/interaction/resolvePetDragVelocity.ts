import {
    PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S,
    PET_VELOCITY_MIN_MAGNITUDE_PX_PER_S,
    PET_VELOCITY_MIN_SPAN_MS,
    PET_VELOCITY_SAMPLE_WINDOW_MS,
} from './petPointerDragConfig';

export type PetDragVelocitySample = Readonly<{
    x: number;
    y: number;
    timeMs: number;
}>;

export type PetDragVelocity = Readonly<{
    x: number;
    y: number;
}>;

function isFiniteSample(sample: PetDragVelocitySample): boolean {
    return Number.isFinite(sample.x) && Number.isFinite(sample.y) && Number.isFinite(sample.timeMs);
}

export function resolvePetDragVelocity(
    samples: readonly PetDragVelocitySample[],
): PetDragVelocity | null {
    const finiteSamples = samples.filter(isFiniteSample);
    const latest = finiteSamples[finiteSamples.length - 1];
    if (!latest) return null;

    const windowSamples = finiteSamples.filter(
        (sample) => latest.timeMs - sample.timeMs <= PET_VELOCITY_SAMPLE_WINDOW_MS,
    );
    const oldestUsable = windowSamples.find(
        (sample) => latest.timeMs - sample.timeMs >= PET_VELOCITY_MIN_SPAN_MS,
    );
    if (!oldestUsable) return null;

    const deltaTimeSeconds = (latest.timeMs - oldestUsable.timeMs) / 1000;
    if (deltaTimeSeconds <= 0) return null;

    const velocity = {
        x: (latest.x - oldestUsable.x) / deltaTimeSeconds,
        y: (latest.y - oldestUsable.y) / deltaTimeSeconds,
    };
    const magnitude = Math.hypot(velocity.x, velocity.y);
    if (magnitude < PET_VELOCITY_MIN_MAGNITUDE_PX_PER_S) return null;
    if (magnitude <= PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S) return velocity;

    const scale = PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S / magnitude;
    return {
        x: velocity.x * scale,
        y: velocity.y * scale,
    };
}
