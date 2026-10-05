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
