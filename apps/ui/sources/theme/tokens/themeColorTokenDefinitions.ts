import type { Theme } from '@/theme';
import type { TranslationKeyNoParams } from '@/text';
import { EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS as TOKEN_DEFINITIONS, type EditableThemeColorTokenDefinition as ProtocolTokenDefinition, type ThemeColorTokenId } from '@happier-dev/protocol/account/settings/themeProfileTokens';

export type { ThemeColorTokenGroup, ThemeColorTokenContrastPair, ThemeColorTokenId } from '@happier-dev/protocol/account/settings/themeProfileTokens';

export type EditableThemeColorTokenDefinition = Omit<ProtocolTokenDefinition, 'labelKey' | 'descriptionKey'> & Readonly<{
    labelKey?: TranslationKeyNoParams;
    descriptionKey?: TranslationKeyNoParams;
}>;

// Keep UI copy keys checked without giving the renderer a separate token identity catalog.
export const EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS = TOKEN_DEFINITIONS satisfies readonly EditableThemeColorTokenDefinition[];

export type ThemeColorTokenClassificationStatus = 'internal' | 'derived' | 'deprecated';

export type ThemeColorTokenClassification = Readonly<{
    path: readonly string[];
    status: ThemeColorTokenClassificationStatus;
    reason: string;
}>;

const accentPaletteTokenClassifications = [
    'blue',
    'green',
    'indigo',
    'orange',
    'purple',
    'red',
    'yellow',
].map((key) => ({
    path: ['accent', key],
    status: 'internal',
    reason: 'Decorative accent palette; public customization routes semantic uses through text, state, and control tokens.',
} as const));

const desktopPetOverlayTokenClassifications = [
    'background',
    'backgroundPressed',
    'controlBackground',
    'controlBackgroundPressed',
    'text',
    'textSecondary',
].map((key) => ({
    path: ['desktopPetOverlay', 'bubble', key],
    status: 'internal',
    reason: 'Feature-specific desktop pet bubble palette; not part of the V1 public theme profile surface.',
} as const));

// Every step of SHADOW_LEVELS, including 6 (the wide, faint cast used by full-height
// floating panels). The classification test is the drift guard: a new level that is not
// listed here fails as an unclassified token leaf.
const shadowLevelTokenClassifications = [1, 2, 3, 4, 5, 6].flatMap((level) => [
    {
        path: ['shadowLevels', String(level), 'boxShadow'],
        status: 'internal',
        reason: 'Shadow recipe string, not a standalone editable color token.',
    },
    {
        path: ['shadowLevels', String(level), 'shadowColor'],
        status: 'internal',
        reason: 'Native shadow recipe color, not a standalone editable color token.',
    },
] as const);

export const THEME_COLOR_TOKEN_CLASSIFICATIONS = [
    ...accentPaletteTokenClassifications,
    ...desktopPetOverlayTokenClassifications,
    ...shadowLevelTokenClassifications,

    { path: ['button', 'primary', 'gradient', 'colors', '0'], status: 'derived', reason: 'Primary button gradient stop derived from the primary button background recipe.' },
    { path: ['button', 'primary', 'gradient', 'colors', '1'], status: 'derived', reason: 'Primary button gradient stop derived from the primary button background recipe.' },
    { path: ['fab', 'gradient', 'colors', '0'], status: 'derived', reason: 'FAB gradient stop derived from the FAB background recipe.' },
    { path: ['fab', 'gradient', 'colors', '1'], status: 'derived', reason: 'FAB gradient stop derived from the FAB background recipe.' },
    { path: ['segmentedControl', 'activeGradient', 'colors', '0'], status: 'derived', reason: 'Segmented-control active gradient stop derived from active segment background.' },
    { path: ['segmentedControl', 'activeGradient', 'colors', '1'], status: 'derived', reason: 'Segmented-control active gradient stop derived from active segment background.' },

    { path: ['diff', 'added', 'border'], status: 'internal', reason: 'Diff added line border detail; V1 exposes added background and foreground only.' },
    { path: ['diff', 'removed', 'border'], status: 'internal', reason: 'Diff removed line border detail; V1 exposes removed background and foreground only.' },
    { path: ['diff', 'context', 'background'], status: 'internal', reason: 'Context-line background is currently an internal renderer detail; visible context foreground is public editable.' },
    { path: ['diff', 'error'], status: 'derived', reason: 'Diff error summary color follows state danger semantics.' },
    { path: ['diff', 'leadingSpaceDot'], status: 'internal', reason: 'Whitespace marker tint is an internal diff-rendering detail.' },
    { path: ['diff', 'lineNumber', 'background'], status: 'internal', reason: 'Diff gutter background is an internal renderer detail.' },
    { path: ['diff', 'lineNumber', 'foreground'], status: 'internal', reason: 'Diff gutter foreground is an internal renderer detail.' },
    { path: ['diff', 'outline'], status: 'internal', reason: 'Diff outline is an internal renderer detail rather than a V1 public token.' },
    { path: ['diff', 'success'], status: 'derived', reason: 'Diff success summary color follows state success semantics.' },

    { path: ['border', 'faint'], status: 'internal', reason: 'About half the weight of border.subtle: the content-width separator between groups of one section\'s rows. An internal chrome detail, like border.subtle, and absent from the theme-profile border palette.' },
    { path: ['border', 'divider'], status: 'internal', reason: 'The one list-row rule between rows of two or more lines, at one perceived weight in light and dark; an internal chrome detail like border.subtle, absent from the theme-profile border palette.' },
    { path: ['border', 'subtle'], status: 'internal', reason: 'Half-weight seam hairline for pane edges and quiet toolbar controls; an internal chrome detail rather than a V1 public border token, and deliberately absent from the theme-profile border palette.' },

    ...(['default', 'surface', 'strong', 'subtle', 'modal', 'danger'] as const).map((role) => ({
        path: ['edge', role],
        status: 'derived',
        reason: 'Raised twin of a border role: the role\'s border with the theme\'s edge ink (effect.surfaceHighlight) composited over it (theme/raisedEdge.ts).',
    } as const)),
    { path: ['edge', 'gloss'], status: 'derived', reason: 'Gloss line of a filled accent control, derived from the theme\'s lightest ink (theme/raisedEdge.ts).' },
    ...(['finishGradient', 'cardFinishGradient', 'primaryFinishGradient', 'secondaryFinishGradient'] as const).flatMap((gradient) => [0, 1].map((stop) => ({
        path: ['edge', gradient, 'colors', String(stop)],
        status: 'derived',
        reason: 'Translucent soft finish overlay derived from effect.surfaceFinish by theme/raisedEdge.ts; never an opaque fill.',
    } as const))),
    { path: ['edge', 'finishGradient', 'band', 'edge'], status: 'derived', reason: 'The edge the surface finish band sits on (bottom on light, top on dark), set by theme/raisedEdge.ts.' },
    { path: ['edge', 'cardFinishGradient', 'band', 'edge'], status: 'derived', reason: 'The edge an in-flow card\'s finish band sits on (bottom on light, top on dark), set by theme/raisedEdge.ts.' },
    ...(['rimHi', 'rimMid', 'sheen'] as const).map((leaf) => ({
        path: ['edge', leaf],
        status: 'derived',
        reason: 'Directional rim of a floating surface (one corner light anchored top-left), in the theme\'s own text ink (theme/raisedEdge.ts).',
    } as const)),
    { path: ['edge', 'fill'], status: 'derived', reason: 'Fill of a bordered control: the page, lifted by a breath of ink on dark themes (theme/raisedEdge.ts).' },
    ...(['cardFill', 'floatingFill'] as const).map((leaf) => ({
        path: ['edge', leaf],
        status: 'derived',
        reason: 'A step of the dark surface ladder (page < card < floating): the page lifted by the theme\'s own ink on dark themes, the page itself on light ones (theme/raisedEdge.ts).',
    } as const)),

    ...(['selectedFocused', 'selectedUnfocused'] as const).map((leaf) => ({
        path: ['surface', leaf],
        status: 'derived',
        reason: 'The open tab\'s fill in a focused or unfocused pane: the profile\'s own text ink at a fixed strength (theme/selectionInk.ts).',
    } as const)),
    { path: ['surface', 'hover'], status: 'derived', reason: 'The hover fill of rows and quiet controls: the profile\'s own text ink, a lighter touch than the page selection and the plane\'s chip (theme/selectionInk.ts).' },
    { path: ['feed', 'card', 'background'], status: 'derived', reason: 'Tool feed card surface derived from surface.elevated so private transcript chrome follows active theme profiles.' },
    { path: ['shadow', 'color'], status: 'internal', reason: 'Legacy tint helper for computed shadows, not a standalone editable color token.' },
    { path: ['shadowCard', 'boxShadow'], status: 'internal', reason: 'In-flow card grounding recipe string, not a standalone editable color token.' },
    { path: ['shadowCard', 'shadowColor'], status: 'internal', reason: 'Native in-flow card grounding color, not a standalone editable color token.' },
    { path: ['shadowPopoverArrowBoxShadow'], status: 'internal', reason: 'Popover arrow shadow recipe string, not a standalone editable color token.' },
    { path: ['shadowSeamCastBoxShadow'], status: 'internal', reason: 'Sideways cast from the page sheet onto the navigation plane beside it; internal chrome recipe rather than a standalone editable color token.' },
    { path: ['shadowPaneHeaderShade'], status: 'internal', reason: 'Start colour of the scroll-linked shade under a pane header; internal chrome recipe rather than a standalone editable color token.' },
    { path: ['shadowJoinedPanelShade'], status: 'internal', reason: 'Start colour of the sideways fade the joined right panel casts onto the page (Shadow divider); internal chrome recipe rather than a standalone editable color token.' },
    { path: ['shadowSeamCastBothBoxShadow'], status: 'internal', reason: 'The page sheet\'s seam cast on both edges, when the right panel stands on the canvas beside it; internal chrome recipe rather than a standalone editable color token.' },
    { path: ['glass', 'border'], status: 'internal', reason: 'Floating glass surface rim recipe (GlassPanel); V1 exposes shared border tokens rather than feature-specific chrome details.' },
    { path: ['glass', 'innerShadow'], status: 'internal', reason: 'Floating glass surface inner shadow recipe string (GlassPanel), not a standalone editable color token.' },
    { path: ['glass', 'composerInnerShadow'], status: 'internal', reason: 'Reduced-opacity inner shadow recipe for the opt-in glass composer surface only; internal chrome recipe rather than a standalone editable color token.' },
    { path: ['glass', 'castShadow'], status: 'internal', reason: 'Floating glass surface cast shadow recipe string (GlassPanel), not a standalone editable color token.' },
    { path: ['glass', 'composerSurface'], status: 'derived', reason: 'Glass composer fill follows surface.base in light profiles and surface.elevated in dark profiles, preserving the canonical fill when its source is unchanged.' },
    { path: ['glass', 'panelSurface'], status: 'internal', reason: 'Solid grey-ish fill for opt-in glass panels (e.g. the session-list selection action bar); internal chrome recipe rather than a standalone editable color token.' },
    { path: ['glass', 'webBlurTint'], status: 'internal', reason: 'Translucent tint behind the web backdrop-filter blur (GlassSurface webBlur tier); internal chrome recipe rather than a standalone editable color token.' },

    { path: ['status', 'actionRequired'], status: 'derived', reason: 'Connection status color derived from state warning semantics.' },
    { path: ['status', 'connected'], status: 'derived', reason: 'Connection status color derived from state success semantics.' },
    { path: ['status', 'connecting'], status: 'derived', reason: 'Connection status color derived from state info semantics.' },
    { path: ['status', 'default'], status: 'derived', reason: 'Connection status color derived from state neutral semantics.' },
    { path: ['status', 'disconnected'], status: 'derived', reason: 'Connection status color derived from state neutral semantics.' },
    { path: ['status', 'error'], status: 'derived', reason: 'Connection status color derived from state danger semantics.' },

    { path: ['syntax', 'bracket1'], status: 'internal', reason: 'Bracket-pair syntax color is internal until bracket colorization is exposed as a public editor token.' },
    { path: ['syntax', 'bracket2'], status: 'internal', reason: 'Bracket-pair syntax color is internal until bracket colorization is exposed as a public editor token.' },
    { path: ['syntax', 'bracket3'], status: 'internal', reason: 'Bracket-pair syntax color is internal until bracket colorization is exposed as a public editor token.' },
    { path: ['syntax', 'bracket4'], status: 'internal', reason: 'Bracket-pair syntax color is internal until bracket colorization is exposed as a public editor token.' },
    { path: ['syntax', 'bracket5'], status: 'internal', reason: 'Bracket-pair syntax color is internal until bracket colorization is exposed as a public editor token.' },
] as const satisfies readonly ThemeColorTokenClassification[];

const editableThemeColorTokenDefinitionsById = new Map<ThemeColorTokenId, EditableThemeColorTokenDefinition>(
    EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS.map((definition) => [definition.id, definition]),
);

export function getEditableThemeColorTokenDefinition(tokenId: string): EditableThemeColorTokenDefinition | undefined {
    return editableThemeColorTokenDefinitionsById.get(tokenId as ThemeColorTokenId);
}

export function resolveThemeColorTokenBaseValue(theme: Theme, tokenId: string): string | undefined {
    const definition = getEditableThemeColorTokenDefinition(tokenId);
    if (!definition) return undefined;

    let value: unknown = theme.colors;
    for (const segment of definition.path) {
        if (value === null || typeof value !== 'object' || !(segment in value)) return undefined;
        value = (value as Record<string, unknown>)[segment];
    }

    return typeof value === 'string' ? value : undefined;
}
