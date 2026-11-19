import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type DesktopOverlayPresentationResult = Readonly<
    { ok: true } | { ok: false; errorCode: string; error: string }
>;
export type DesktopOverlayPresentationTarget = SessionAddress & ServerAccountScope;
export type MountedDesktopOverlayPresentation = (target: DesktopOverlayPresentationTarget) => Promise<DesktopOverlayPresentationResult>;
let mounted: MountedDesktopOverlayPresentation | null = null;

/** Main owns the target; an older mount's cleanup cannot retire a newer one. */
export function registerMountedDesktopOverlayPresentation(present: MountedDesktopOverlayPresentation): () => void {
    mounted = present;
    return () => { if (mounted === present) mounted = null; };
}

export function captureMountedDesktopOverlayPresentation(): MountedDesktopOverlayPresentation | null {
    return mounted;
}
