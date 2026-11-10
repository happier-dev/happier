/**
 * The one hand-off from a container's caption to the Companion's Voice section (§4.3): while the
 * section is mounted beside the work, the caption reveals it there instead of opening a second copy
 * as a popover. The section registers its reveal while mounted; nothing else is stored.
 */
type Reveal = () => boolean;

const mounted: Reveal[] = [];

export function registerVoiceCompanionSection(reveal: Reveal): () => void {
    mounted.push(reveal);
    return () => {
        const index = mounted.lastIndexOf(reveal);
        if (index >= 0) mounted.splice(index, 1);
    };
}

/** Reveals the most recently mounted section; false when none is on screen (open the popover). */
export function revealVoiceCompanionSection(): boolean {
    const reveal = mounted.at(-1);
    if (!reveal) return false;
    return reveal();
}

// Mounted presentation owners lend their existing controls; no request survives an unmount.
let glance: ((open: boolean) => void) | null = null;
type SetupControl = (open: boolean) => boolean | void;
let setup: SetupControl | null = null;
let position: ((point: Readonly<{ x: number; y: number }>) => boolean) | null = null;

export function registerVoiceGlancePresentation(control: NonNullable<typeof glance>): () => void {
    glance = control;
    return () => { if (glance === control) glance = null; };
}
export function setVoiceGlanceOpen(open: boolean): boolean {
    if (!glance) return false;
    glance(open);
    return true;
}
// Setup unfolded in place over the work (from the composer mark) answers before a host's tile (Home's
// Get set up, Settings → Voice), which re-registers as its items change; each falls back on unmount.
let setupInPlace: SetupControl | null = null;
export function registerVoiceSetupPresentation(
    control: NonNullable<typeof setup>,
    options?: Readonly<{ inPlace?: boolean }>,
): () => void {
    if (options?.inPlace) {
        setupInPlace = control;
        return () => { if (setupInPlace === control) setupInPlace = null; };
    }
    setup = control;
    return () => { if (setup === control) setup = null; };
}
export function setVoiceSetupOpen(open: boolean): boolean {
    const control = setupInPlace ?? setup;
    if (!control) return false;
    return control(open) !== false;
}
export function registerVoicePresencePosition(control: NonNullable<typeof position>): () => void {
    position = control;
    return () => { if (position === control) position = null; };
}
export function setVoicePresencePosition(point: Readonly<{ x: number; y: number }>): boolean {
    return position?.(point) ?? false;
}
