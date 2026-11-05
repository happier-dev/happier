import type { SessionAddress } from '@/sync/domains/session/sessionAddress';

export type DesktopOverlayPresentationResult = Readonly<
    { ok: true } | { ok: false; errorCode: string; error: string }
>;
export type MountedDesktopOverlayPresentation = (target: SessionAddress) => Promise<DesktopOverlayPresentationResult>;
let mounted: MountedDesktopOverlayPresentation | null = null;

/** Main owns the target; an older mount's cleanup cannot retire a newer one. */
export function registerMountedDesktopOverlayPresentation(present: MountedDesktopOverlayPresentation): () => void {
    mounted = present;
    return () => { if (mounted === present) mounted = null; };
}

export function captureMountedDesktopOverlayPresentation(): MountedDesktopOverlayPresentation | null {
    return mounted;
}
