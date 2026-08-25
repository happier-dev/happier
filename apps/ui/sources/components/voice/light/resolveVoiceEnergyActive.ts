/**
 * Everything the energy clock's activation depends on.
 *
 * All eight are already observable somewhere else — the host's motion presence, the
 * provider resolver, the reduced-motion preference, the mounted surfaces and the
 * level store. Nothing here is persisted, and no Voice lifecycle state is added:
 * this is a predicate over facts that exist, which is why it can be a pure
 * function instead of a store.
 */
export type VoiceEnergyActivationInputs = Readonly<{
    /** The host permits motion (focused desktop / active native runtime). */
    runtimeMotionActive: boolean;
    /** A Voice provider is resolved — not `off`. */
    providerReady: boolean;
    /** Reduced motion is off and no frozen preview is pinned. */
    motionAllowed: boolean;
    /** At least one Voice surface is mounted: Horizon, the Orb, or the composer planet. */
    hasVisibleConsumer: boolean;
    /** A Voice attempt exists. */
    attemptActive: boolean;
    /** The microphone channel is open. */
    inputSourceActive: boolean;
    /** The playback channel is open. */
    outputSourceActive: boolean;
    /** The settle-back-to-still transition has not finished yet. */
    settleTransitionPending: boolean;
}>;

/**
 * Whether the energy frame callback should run at all.
 *
 * The first four gates only say a surface *could* animate. The fifth clause is
 * what makes idle actually idle — see §2.4a: without it, a mounted, visible,
 * motion-allowed Voice surface would drive a 60 Hz loop forever while the planet
 * is supposed to be motionless, and nothing in a screenshot would reveal it.
 *
 * Reduced motion is folded into `motionAllowed` and is the one gate that is an
 * accessibility floor rather than an efficiency measure.
 */
export function resolveVoiceEnergyActive(inputs: VoiceEnergyActivationInputs): boolean {
    return inputs.runtimeMotionActive
        && inputs.providerReady
        && inputs.motionAllowed
        && inputs.hasVisibleConsumer
        && (
            inputs.attemptActive
            || inputs.inputSourceActive
            || inputs.outputSourceActive
            || inputs.settleTransitionPending
        );
}
