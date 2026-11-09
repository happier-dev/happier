/**
 * A phone's Discussion surfaces: the thread (`chat`) and the surfaces its rail tabs declare
 * (`mobileSurfaces.discussion`), the same projection a Session's and a Project's phone bar read.
 */
export type DiscussionMobileSurface = 'chat' | 'participants' | 'agents' | 'details';

export function normalizeDiscussionMobileSurface(value: string | null | undefined): DiscussionMobileSurface | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized === 'chat' || normalized === 'participants' || normalized === 'agents' || normalized === 'details' ? normalized : null;
}
