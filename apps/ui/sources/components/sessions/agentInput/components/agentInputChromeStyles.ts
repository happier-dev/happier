import { Platform } from 'react-native';
import type { UnistylesThemes } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { buildGlassCastShadowStyle, resolveGlassRimStyle } from '@/shadowElevation';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';
import { COMPOSER_PHONE_CARD_CONTENT_INSET } from '../composerContentInset';
import { resolveComposerSurfacePaint } from '../composerSurfaceStyle';
import { INSTRUMENT_STRIP_LINE_HEIGHT_PX } from '../instrumentStrip/instrumentStripStyles';


type Theme = UnistylesThemes[keyof UnistylesThemes];

/**
 * The composer's own chrome: the panel around the input and the action chips under it. `AgentInput`
 * paints these, and settings previews render the same chips inside the same panel, so the two
 * cannot drift apart.
 */
/**
 * The one gap between neighbouring chips on every rail and platform (phone lab D20: chips 4 apart). Web rails
 * state it as `columnGap`; native chips state it as their own trailing margin.
 */
export const AGENT_INPUT_ACTION_CHIP_GAP_X = 4;
/**
 * The one gap before Send: Send's own leading margin, so the Voice glyph beside it is drawn this far from the
 * circle plus its slot's slack (owner 11-10: the pair read as apart). Voice's press frame grows into half of it.
 */
export const AGENT_INPUT_SEND_LEADING_GAP_PX = 4;
/** The gap between wrapped chip lines: native rows state it as margins, web rows as `rowGap`; the rails' hit areas split this one value. */
export const NATIVE_ACTION_CHIP_GAP_Y = 1;

/**
 * The field's book and microphone accessories: sideways they touch each other, above them a new session's
 * Look chip sits 9 px away. The accessories take 5 px of that gap upward (the chip takes the other 4).
 */
/**
 * The composer's quiet icon button: the field's book and microphone, and the icon actions in the status row
 * above the card (a Docked card's Start another, Delete draft, collapse and close), draw this one square, so the
 * row and the card read as one set. Its glyph is the `IconButton` step that fits it (`ICON_SIZE.sm`).
 */
export const AGENT_INPUT_QUIET_ICON_SIZE_PX = 24;
export const AGENT_INPUT_FIELD_ACCESSORY_EDGES_PX = { leading: 0, trailing: 0, top: 5 } as const;
/**
 * Under the expand toggle the accessories' drawn top is 9 px below the toggle's bottom, so the toggle's hit
 * area takes the other 4 of the gap the accessories' 5 leave (the same split as the Look chip above them).
 */
export const AGENT_INPUT_EXPANSION_TOGGLE_HIT_REACH = { bottom: 4 } as const;
export const AGENT_INPUT_PANEL_PADDING_BOTTOM = 8;
/**
 * The field's own breathing room above and below its text: the step between the typed line and the chip rail.
 * The card's top padding is derived from its side padding (`resolveAgentInputPanelPaddingTop`), so the typed
 * line sits as far down as it sits in: 12 on a phone (lab D13's content inset), 18 on wider layouts.
 */
export const AGENT_INPUT_FIELD_PADDING_Y = 5;
export const AGENT_INPUT_NATIVE_FIELD_PADDING_Y = 8;
/**
 * The step from the field's row to the first chip rail, past the field's own padding: live, document and reading
 * cards alike. The typed text breathes above the controls while the rails themselves stay one block (owner
 * 2026-11-10: text-to-chips up, rail-to-rail down).
 */
export const AGENT_INPUT_FIELD_TO_CHIP_RAIL_GAP_PX = 8;

/**
 * The composer's one edge (calm-shell C1), the same for live, read-only, document and preview composers and for
 * both composer styles: the glass edge (`resolveGlassRimStyle`). Light draws no line, so the fill, inner shade and
 * cast shadow carry the edge, as 0.2's composer did; dark keeps one even glass line (owner, 2026-11-16).
 */
export function resolveAgentInputPanelEdgeStyle(theme: Theme) {
    return resolveGlassRimStyle(theme);
}

/** The material plane owns paint; this layout is shared by live input and previews. */
export function resolveAgentInputPanelLayoutStyle(theme: Theme) {
    return {
        // The composer stack's radius (`theme.parts.composer`), shared with the banners above it.
        borderRadius: theme.parts.composer.radius,
        ...resolveAgentInputPanelEdgeStyle(theme),
        overflow: 'hidden' as const,
        paddingTop: resolveAgentInputPanelPaddingTop(theme.space.s8),
        paddingBottom: AGENT_INPUT_PANEL_PADDING_BOTTOM,
        paddingHorizontal: theme.space.s8,
    };
}

export function resolveAgentInputPhonePanelLayoutStyle(theme: Theme) {
    const paddingHorizontal = resolveAgentInputPhonePanelPaddingX(theme);
    return { paddingHorizontal, paddingTop: resolveAgentInputPanelPaddingTop(paddingHorizontal) };
}

export function resolveAgentInputBandStyle(theme: Theme) {
    return { alignItems: 'center' as const, width: '100%' as const, paddingTop: theme.space.s8, paddingBottom: theme.space.s8 };
}

/** The resting card starts below the band's top padding and its single instrument line. */
export function resolveAgentInputRestingCardTopInset(theme: Theme) {
    return resolveAgentInputBandStyle(theme).paddingTop + INSTRUMENT_STRIP_LINE_HEIGHT_PX;
}

export function resolveAgentInputPanelMaterial(input: Readonly<{
    theme: Theme;
    glass: boolean;
    surfaceGroup?: GlassSurfaceGroup;
    embedded?: boolean;
    customBackground?: unknown;
}>) {
    const { theme, glass, surfaceGroup = 'card', embedded = false, customBackground } = input;
    return {
        surfaceGroup,
        nested: surfaceGroup === 'card',
        solidColor: resolveComposerSurfacePaint({ theme, glass, embedded, customBackground }).color,
        finishRole: 'composer' as const,
        ...(embedded ? { noCoat: true } : {}),
    };
}

export function resolveAgentInputPanelShadowStyle(theme: Theme, glass: boolean) {
    return {
        borderRadius: theme.parts.composer.radius,
        ...(glass ? buildGlassCastShadowStyle(theme.colors.shadowLevels[4], theme.colors.glass.castShadow, true) : {}),
    };
}

export function resolveAgentInputPanelInnerShadowStyle(theme: Theme) {
    return { boxShadow: theme.colors.glass.composerInnerShadow };
}

/** The field's and the chip rail's own leading inset inside the card: the typed line and an icon chip's glyph. */
export const AGENT_INPUT_CARD_CONTENT_LEADING_INSET = 8;
/** The field row's own inset above and below the field (`AgentInput` `inputContainer`). */
export const AGENT_INPUT_FIELD_CONTAINER_PADDING_Y = 4;
export const AGENT_INPUT_FIELD_CONTAINER_STYLE = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderWidth: 0,
    paddingLeft: AGENT_INPUT_CARD_CONTENT_LEADING_INSET,
    paddingRight: AGENT_INPUT_CARD_CONTENT_LEADING_INSET,
    paddingVertical: AGENT_INPUT_FIELD_CONTAINER_PADDING_Y,
    minHeight: 40,
};

/**
 * The card's top padding for a given side padding: the typed line stands as far below the card's top edge as
 * it stands in from the leading edge (owner 2026-11-10: the top read tighter than the side).
 */
export function resolveAgentInputPanelPaddingTop(panelPaddingX: number): number {
    return Math.max(0, panelPaddingX + AGENT_INPUT_CARD_CONTENT_LEADING_INSET
        - AGENT_INPUT_FIELD_CONTAINER_PADDING_Y - AGENT_INPUT_FIELD_PADDING_Y);
}

/**
 * A phone composer's side padding, derived so its content lands `COMPOSER_PHONE_CARD_CONTENT_INSET` in from the
 * card's outer edge (card on 16, content on 28): that inset less the edge and the field's own leading inset.
 */
export function resolveAgentInputPhonePanelPaddingX(theme: Theme): number {
    return Math.max(0, COMPOSER_PHONE_CARD_CONTENT_INSET - resolveAgentInputPanelEdgeStyle(theme).borderWidth - AGENT_INPUT_CARD_CONTENT_LEADING_INSET);
}

export function resolveAgentInputPanelStyle(theme: Theme) {
    return {
        ...resolveAgentInputPanelLayoutStyle(theme),
        backgroundColor: glassSurfaceBackgroundColor(theme.colors.input.background, 'card'),
    };
}

/**
 * A rail chip's height. The chips draw no resting fill, so their height is the space between the rails: 28 holds
 * the 16 pt glyph and the label with an even margin and reads the two rails as one block (owner 2026-11-11, phone
 * 05–07: the 32 pt chips of 0.2 left the rows far apart). Hit areas still meet across the 1 px gap.
 */
export const AGENT_INPUT_ACTION_CHIP_HEIGHT_PX = 28;

/** The setup and placement rails of a full New Session composer, each one chip tall at rest. */
export const NEW_SESSION_RESTING_RAILS_HEIGHT_PX = 2 * AGENT_INPUT_ACTION_CHIP_HEIGHT_PX + NATIVE_ACTION_CHIP_GAP_Y;

export const AGENT_INPUT_ACTION_CHIP_STYLE = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderRadius: AGENT_INPUT_ACTION_CHIP_HEIGHT_PX / 2,
    paddingHorizontal: 10,
    justifyContent: 'center' as const,
    height: AGENT_INPUT_ACTION_CHIP_HEIGHT_PX,
    gap: 6,
    ...(Platform.OS === 'web' ? {} : { marginRight: AGENT_INPUT_ACTION_CHIP_GAP_X, marginBottom: NATIVE_ACTION_CHIP_GAP_Y }),
};

/** A chip while pressed: the standard pressed dip. */
export const AGENT_INPUT_ACTION_CHIP_PRESSED_STYLE = {
    opacity: motionTokens.press.opacity,
};

/** A chip whose label is hidden (icon-only density). */
export const AGENT_INPUT_ACTION_CHIP_ICON_ONLY_STYLE = {
    paddingHorizontal: AGENT_INPUT_CARD_CONTENT_LEADING_INSET,
    gap: 0,
};

/**
 * Chip labels are quiet settings, not headings: Inter medium in the chip tint. Semibold (0.2's weight, drawn
 * there in the lighter Apple system face) read heavy and dark in Inter beside the prompt (owner 2026-10-30).
 */
export function resolveAgentInputActionChipTextStyle(theme: Theme) {
    return {
        fontSize: 13,
        color: theme.colors.composer.chipTint,
        fontWeight: '500' as const,
        ...Typography.default('medium'),
    };
}
