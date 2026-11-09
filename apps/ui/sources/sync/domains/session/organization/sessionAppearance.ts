import type { SessionOrganizationContentEnvelope } from '@happier-dev/protocol';
import { parseSessionAppearanceColor, type SessionAppearanceColor } from './appearanceColor';

/** A parent id is scoped to the appearance record's server, never resolved across servers. */
export type SessionParentPlacement = Readonly<{ kind: 'topLevel' }> | Readonly<{ kind: 'session'; parentSessionId: string }>;
export type SessionAppearancePatch = Readonly<{
    color?: SessionAppearanceColor | null;
    placement?: SessionParentPlacement | null;
    identity?: 'independent' | null;
}>;

export function readSessionAppearanceDisplay(display: SessionOrganizationContentEnvelope | null | undefined): Record<string, unknown> {
    return display?.t === 'plain' && display.v && typeof display.v === 'object' && !Array.isArray(display.v)
        ? display.v as Record<string, unknown> : {};
}

export function readSessionParentPlacement(display: SessionOrganizationContentEnvelope | null | undefined): SessionParentPlacement | null {
    const value = readSessionAppearanceDisplay(display).placement;
    if (!value || typeof value !== 'object' || !('kind' in value)) return null;
    if (value.kind === 'topLevel') return { kind: 'topLevel' };
    if (value.kind === 'session' && 'parentSessionId' in value && typeof value.parentSessionId === 'string' && value.parentSessionId.trim()) {
        return { kind: 'session', parentSessionId: value.parentSessionId.trim() };
    }
    return null;
}

export function readEffectiveSessionAppearancePresentation(
    display: SessionOrganizationContentEnvelope | null | undefined,
    presentation: SessionOrganizationContentEnvelope | null | undefined,
): Record<string, unknown> {
    return presentation ? readSessionAppearanceDisplay(presentation) : readSessionAppearanceDisplay(display);
}

export function readEffectiveSessionParentPlacement(
    display: SessionOrganizationContentEnvelope | null | undefined,
    presentation: SessionOrganizationContentEnvelope | null | undefined,
): SessionParentPlacement | null {
    const source = presentation ?? display;
    return readSessionParentPlacement(source);
}

export function mergeSessionAppearancePresentation(
    presentation: SessionOrganizationContentEnvelope | null | undefined,
    legacyDisplay: SessionOrganizationContentEnvelope | null | undefined,
    patch: Pick<SessionAppearancePatch, 'placement' | 'identity'>,
): SessionOrganizationContentEnvelope {
    if (presentation && presentation.t !== 'plain') throw new Error('session-appearance-presentation-not-opened');
    const value: Record<string, unknown> = {
        ...(presentation
            ? readSessionAppearanceDisplay(presentation)
            : readSessionAppearanceDisplay(legacyDisplay)),
        v: 1,
    };
    delete value.color;
    if (patch.placement !== undefined) {
        if (patch.placement === null) delete value.placement;
        else value.placement = patch.placement;
    }
    if (patch.identity !== undefined) {
        if (patch.identity === null) delete value.identity;
        else value.identity = patch.identity;
    }
    return { t: 'plain', v: value };
}

export function mergeSessionAppearanceDisplay(display: SessionOrganizationContentEnvelope | null | undefined, patch: SessionAppearancePatch): SessionOrganizationContentEnvelope | null {
    if (display && display.t !== 'plain') throw new Error('session-appearance-not-opened');
    const value = { ...readSessionAppearanceDisplay(display) };
    if (patch.color !== undefined) {
        const color = parseSessionAppearanceColor(patch.color);
        if (patch.color !== null && !color) throw new Error('invalid-session-appearance');
        if (color) value.color = color;
        else delete value.color;
    }
    if (patch.placement !== undefined) {
        if (patch.placement === null) delete value.placement;
        else value.placement = patch.placement;
    }
    if (patch.identity !== undefined) {
        if (patch.identity === null) delete value.identity;
        else value.identity = patch.identity;
    }
    return Object.keys(value).length ? { t: 'plain', v: value } : null;
}
