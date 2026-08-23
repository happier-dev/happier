/**
 * One microphone acquisition attempt, joined through an outcome that never rejects.
 *
 * Teardown can release every caller waiting on an attempt before the platform
 * settles it, so the attempt's own rejection is observed here rather than left
 * for whichever caller happened to still be awaiting it.
 */
export type MicAcquisitionAttempt = Readonly<{
    outcome: Promise<Readonly<{ error: unknown }> | null>;
}>;

export type MicLifecycleInvalidation = Readonly<{
    invalidated: Promise<void>;
    invalidate: () => void;
}>;

export function createMicLifecycleInvalidation(): MicLifecycleInvalidation {
    let invalidate!: () => void;
    const invalidated = new Promise<void>((resolve) => {
        invalidate = resolve;
    });
    return { invalidated, invalidate };
}

/**
 * Waits for an acquisition attempt, but never past the lifecycle that owns it:
 * a `getUserMedia` the platform never settles must not pin the caller (and, one
 * frame up, Stop) forever. Returns `false` when teardown claimed the lifecycle
 * first, in which case the late attempt releases its own stream.
 */
export async function joinMicAcquisition(
    attempt: MicAcquisitionAttempt,
    lifecycle: MicLifecycleInvalidation,
): Promise<boolean> {
    const outcome = await Promise.race([
        attempt.outcome.then((failure) => ({ invalidated: false as const, failure })),
        lifecycle.invalidated.then(() => ({ invalidated: true as const })),
    ]);
    if (outcome.invalidated) {
        return false;
    }
    if (outcome.failure) {
        throw outcome.failure.error;
    }
    return true;
}
