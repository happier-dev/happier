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
let setup: ((open: boolean) => void) | null = null;
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
export function registerVoiceSetupPresentation(control: NonNullable<typeof setup>): () => void {
    setup = control;
    return () => { if (setup === control) setup = null; };
}
export function setVoiceSetupOpen(open: boolean): boolean {
    if (!setup) return false;
    setup(open);
    return true;
}
export function registerVoicePresencePosition(control: NonNullable<typeof position>): () => void {
    position = control;
    return () => { if (position === control) position = null; };
}
export function setVoicePresencePosition(point: Readonly<{ x: number; y: number }>): boolean {
    return position?.(point) ?? false;
}
