import type { GlyphSurfaceReadiness } from '@/components/atmosphere/glyph/glyphSurfaceTypes';
import type { FirstOpenDecision } from './resolveFirstOpen';

export function resolveInAppFirstFrame(decision: FirstOpenDecision, renderer: GlyphSurfaceReadiness | null, buildReady: boolean): 'play' | 'still' {
    return decision === 'in-app' && renderer === 'ready' && buildReady ? 'play' : 'still';
}
