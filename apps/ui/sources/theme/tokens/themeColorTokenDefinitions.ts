import type { Theme } from '@/theme';

export type ThemeColorTokenGroup =
    | 'background'
    | 'surface'
    | 'border'
    | 'effect'
    | 'chrome'
    | 'text'
    | 'state'
    | 'control'
    | 'composer'
    | 'message'
    | 'syntax'
    | 'versionControl'
    | 'diff'
    | 'permission'
    | 'overlay';

export type ThemeColorTokenContrastPair = Readonly<{
    tokenId: string;
    minRatio: number;
}>;

type EditableThemeColorTokenDefinitionInput = Readonly<{
    id: string;
    path: readonly string[];
    group: ThemeColorTokenGroup;
    label: string;
    description: string;
    valueKind: 'color';
    contrastPairs?: readonly ThemeColorTokenContrastPair[];
}>;

export type EditableThemeColorTokenDefinition = EditableThemeColorTokenDefinitionInput & Readonly<{
    id: ThemeColorTokenId;
}>;

export type ThemeColorTokenClassificationStatus = 'internal' | 'derived' | 'deprecated';

export type ThemeColorTokenClassification = Readonly<{
    path: readonly string[];
    status: ThemeColorTokenClassificationStatus;
    reason: string;
}>;

const textOnCanvasAndSurface = [
    { tokenId: 'background.canvas', minRatio: 4.5 },
    { tokenId: 'surface.base', minRatio: 4.5 },
] as const;

const stateContrast = (backgroundTokenId: string) => [{ tokenId: backgroundTokenId, minRatio: 4.5 }] as const;

const defineEditableThemeColorToken = <TDefinition extends EditableThemeColorTokenDefinitionInput>(definition: TDefinition) => definition;

export const EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS = [
    defineEditableThemeColorToken({ id: 'background.canvas', path: ['background', 'canvas'], group: 'background', label: 'Canvas background', description: 'App, root, screen, and settings-list backdrop color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'surface.base', path: ['surface', 'base'], group: 'surface', label: 'Base surface', description: 'Primary cards, sheets, grouped item containers, and default bounded surfaces.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'surface.inset', path: ['surface', 'inset'], group: 'surface', label: 'Inset surface', description: 'Recessed wells, code and editor backgrounds, skeleton troughs, nested panels, and input-like inner surfaces.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'surface.elevated', path: ['surface', 'elevated'], group: 'surface', label: 'Elevated surface', description: 'Selected, lifted, notice, overlay, and floating surfaces that should stand apart from their parent.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'surface.pressed', path: ['surface', 'pressed'], group: 'surface', label: 'Pressed surface', description: 'Pressed-state fill for touchable surface rows and controls.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'surface.selected', path: ['surface', 'selected'], group: 'surface', label: 'Selected surface', description: 'Selected-state fill for surface rows and selectable containers.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'surface.pressedOverlay', path: ['surface', 'pressedOverlay'], group: 'surface', label: 'Pressed overlay', description: 'Overlay color applied on top of pressed surfaces where the platform uses an overlay effect.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'surface.ripple', path: ['surface', 'ripple'], group: 'surface', label: 'Ripple overlay', description: 'Android and web ripple/touch feedback color for surface interactions.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'surface.sectionTint', path: ['surface', 'sectionTint'], group: 'surface', label: 'Section tint', description: 'Barely-there baked opacity tint for grouped item sections that need a hair of separation from the base surface without reading as a recessed inset.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'border.default', path: ['border', 'default'], group: 'border', label: 'Default border', description: 'Standard separators and divider lines.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'border.surface', path: ['border', 'surface'], group: 'border', label: 'Surface border', description: 'Outer stroke for cards, popovers, dropdowns, composer panels, and other bounded surfaces.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'border.strong', path: ['border', 'strong'], group: 'border', label: 'Strong border', description: 'Higher-emphasis outline for elevated or focused surface boundaries.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'border.modal', path: ['border', 'modal'], group: 'border', label: 'Modal border', description: 'Border color for modal card and dialog chrome surfaces.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'effect.surfaceHighlight', path: ['effect', 'surfaceHighlight'], group: 'effect', label: 'Surface highlight', description: 'Surface chrome accent for bounded cards, popovers, and composer surfaces.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'chrome.header.background', path: ['chrome', 'header', 'background'], group: 'chrome', label: 'Header background', description: 'Navigation and screen header background color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'chrome.header.foreground', path: ['chrome', 'header', 'foreground'], group: 'chrome', label: 'Header foreground', description: 'Navigation header title and icon color.', valueKind: 'color', contrastPairs: stateContrast('chrome.header.background') }),

    defineEditableThemeColorToken({ id: 'text.primary', path: ['text', 'primary'], group: 'text', label: 'Primary text', description: 'Main foreground for body copy, titles, and high-emphasis icons.', valueKind: 'color', contrastPairs: textOnCanvasAndSurface }),
    defineEditableThemeColorToken({ id: 'text.secondary', path: ['text', 'secondary'], group: 'text', label: 'Secondary text', description: 'Broad muted foreground for secondary text, metadata, low-emphasis icons, chevrons, loaders, and chrome details.', valueKind: 'color', contrastPairs: textOnCanvasAndSurface }),
    defineEditableThemeColorToken({ id: 'text.tertiary', path: ['text', 'tertiary'], group: 'text', label: 'Tertiary text', description: 'Lowest-emphasis readable foreground for section labels and subtle metadata.', valueKind: 'color', contrastPairs: textOnCanvasAndSurface }),
    defineEditableThemeColorToken({ id: 'text.link', path: ['text', 'link'], group: 'text', label: 'Link text', description: 'Interactive inline links and link-like navigation affordances.', valueKind: 'color', contrastPairs: textOnCanvasAndSurface }),
    defineEditableThemeColorToken({ id: 'text.destructive', path: ['text', 'destructive'], group: 'text', label: 'Destructive text', description: 'Destructive inline text and icon foreground when no state background is present.', valueKind: 'color', contrastPairs: textOnCanvasAndSurface }),
    defineEditableThemeColorToken({ id: 'text.placeholder', path: ['text', 'placeholder'], group: 'text', label: 'Placeholder text', description: 'Placeholder foreground for empty input fields.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'text.disabled', path: ['text', 'disabled'], group: 'text', label: 'Disabled text', description: 'Foreground for disabled text and disabled low-emphasis controls.', valueKind: 'color' }),

    defineEditableThemeColorToken({ id: 'state.success.foreground', path: ['state', 'success', 'foreground'], group: 'state', label: 'Success foreground', description: 'Success icons, labels, and action indicators.', valueKind: 'color', contrastPairs: stateContrast('state.success.background') }),
    defineEditableThemeColorToken({ id: 'state.success.background', path: ['state', 'success', 'background'], group: 'state', label: 'Success background', description: 'Background for success badges, notices, and pills.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.success.border', path: ['state', 'success', 'border'], group: 'state', label: 'Success border', description: 'Border for success badges, notices, and selected success affordances.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.warning.foreground', path: ['state', 'warning', 'foreground'], group: 'state', label: 'Warning foreground', description: 'Warning icons, labels, and caution indicators.', valueKind: 'color', contrastPairs: stateContrast('state.warning.background') }),
    defineEditableThemeColorToken({ id: 'state.warning.background', path: ['state', 'warning', 'background'], group: 'state', label: 'Warning background', description: 'Background for warning badges, notices, and pills.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.warning.border', path: ['state', 'warning', 'border'], group: 'state', label: 'Warning border', description: 'Border for warning badges, notices, and caution affordances.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.danger.foreground', path: ['state', 'danger', 'foreground'], group: 'state', label: 'Danger foreground', description: 'Danger, destructive, error, and delete icons or labels.', valueKind: 'color', contrastPairs: stateContrast('state.danger.background') }),
    defineEditableThemeColorToken({ id: 'state.danger.background', path: ['state', 'danger', 'background'], group: 'state', label: 'Danger background', description: 'Background for danger badges, error notices, and destructive state pills.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.danger.border', path: ['state', 'danger', 'border'], group: 'state', label: 'Danger border', description: 'Border for danger badges, error notices, and destructive state affordances.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.info.foreground', path: ['state', 'info', 'foreground'], group: 'state', label: 'Info foreground', description: 'Informational icons, labels, and neutral guidance accents.', valueKind: 'color', contrastPairs: stateContrast('state.info.background') }),
    defineEditableThemeColorToken({ id: 'state.info.background', path: ['state', 'info', 'background'], group: 'state', label: 'Info background', description: 'Background for informational badges, notices, and pills.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.info.border', path: ['state', 'info', 'border'], group: 'state', label: 'Info border', description: 'Border for informational badges, notices, and active info affordances.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.neutral.foreground', path: ['state', 'neutral', 'foreground'], group: 'state', label: 'Neutral foreground', description: 'Neutral status foreground and migrated gray warning-style indicators.', valueKind: 'color', contrastPairs: stateContrast('state.neutral.background') }),
    defineEditableThemeColorToken({ id: 'state.neutral.background', path: ['state', 'neutral', 'background'], group: 'state', label: 'Neutral background', description: 'Background for neutral badges, notices, and inactive status pills.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.neutral.border', path: ['state', 'neutral', 'border'], group: 'state', label: 'Neutral border', description: 'Border for neutral badges, notices, and inactive status affordances.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.active.foreground', path: ['state', 'active', 'foreground'], group: 'state', label: 'Active foreground', description: 'Foreground for active chips, toolbar pills, segmented choices, and active controls.', valueKind: 'color', contrastPairs: stateContrast('state.active.background') }),
    defineEditableThemeColorToken({ id: 'state.active.background', path: ['state', 'active', 'background'], group: 'state', label: 'Active background', description: 'Background for active chips, toolbar pills, segmented choices, and active controls.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'state.active.border', path: ['state', 'active', 'border'], group: 'state', label: 'Active border', description: 'Border for active chips, toolbar pills, segmented choices, and active controls.', valueKind: 'color' }),

    defineEditableThemeColorToken({ id: 'control.button.primary.background', path: ['button', 'primary', 'background'], group: 'control', label: 'Primary button background', description: 'Fill for primary buttons and primary action controls.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.button.primary.foreground', path: ['button', 'primary', 'tint'], group: 'control', label: 'Primary button foreground', description: 'Text and icon color on primary buttons.', valueKind: 'color', contrastPairs: stateContrast('control.button.primary.background') }),
    defineEditableThemeColorToken({ id: 'control.button.primary.disabled', path: ['button', 'primary', 'disabled'], group: 'control', label: 'Primary button disabled', description: 'Disabled primary button fill or foreground depending on component context.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.button.secondary.background', path: ['button', 'secondary', 'background'], group: 'control', label: 'Secondary button background', description: 'Ambient secondary button background; transparent in canonical themes.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.button.secondary.foreground', path: ['button', 'secondary', 'tint'], group: 'control', label: 'Secondary button foreground', description: 'Text and icon color for secondary buttons and row actions.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.input.background', path: ['input', 'background'], group: 'control', label: 'Input background', description: 'Input field and search field background color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.input.foreground', path: ['input', 'text'], group: 'control', label: 'Input foreground', description: 'Input text foreground color.', valueKind: 'color', contrastPairs: stateContrast('control.input.background') }),
    defineEditableThemeColorToken({ id: 'control.input.placeholder', path: ['input', 'placeholder'], group: 'control', label: 'Input placeholder', description: 'Input placeholder foreground color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.switch.track.active', path: ['switch', 'track', 'active'], group: 'control', label: 'Active switch track', description: 'Track color for enabled switches.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.switch.track.inactive', path: ['switch', 'track', 'inactive'], group: 'control', label: 'Inactive switch track', description: 'Track color for disabled/off switches.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.switch.thumb.active', path: ['switch', 'thumb', 'active'], group: 'control', label: 'Active switch thumb', description: 'Thumb color for enabled switches.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.switch.thumb.inactive', path: ['switch', 'thumb', 'inactive'], group: 'control', label: 'Inactive switch thumb', description: 'Thumb color for disabled/off switches.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.radio.active', path: ['radio', 'active'], group: 'control', label: 'Active radio', description: 'Active radio button outline and selected state color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.radio.inactive', path: ['radio', 'inactive'], group: 'control', label: 'Inactive radio', description: 'Inactive radio button outline color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.radio.dot', path: ['radio', 'dot'], group: 'control', label: 'Radio dot', description: 'Selected radio dot color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.segmentedControl.trackBackground', path: ['segmentedControl', 'trackBackground'], group: 'control', label: 'Segmented control track', description: 'Track background for segmented controls.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.segmentedControl.activeBackground', path: ['segmentedControl', 'activeBackground'], group: 'control', label: 'Segmented control active background', description: 'Active segment background for segmented controls.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.fab.background', path: ['fab', 'background'], group: 'control', label: 'FAB background', description: 'Floating action button background color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.fab.backgroundPressed', path: ['fab', 'backgroundPressed'], group: 'control', label: 'Pressed FAB background', description: 'Pressed floating action button background color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.fab.foreground', path: ['fab', 'icon'], group: 'control', label: 'FAB foreground', description: 'Floating action button icon color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.allow.background', path: ['permissionButton', 'allow', 'background'], group: 'control', label: 'Allow permission background', description: 'Allow button background in permission prompts.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.allow.foreground', path: ['permissionButton', 'allow', 'text'], group: 'control', label: 'Allow permission foreground', description: 'Allow button text and icon color in permission prompts.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.deny.background', path: ['permissionButton', 'deny', 'background'], group: 'control', label: 'Deny permission background', description: 'Deny button background in permission prompts.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.deny.foreground', path: ['permissionButton', 'deny', 'text'], group: 'control', label: 'Deny permission foreground', description: 'Deny button text and icon color in permission prompts.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.allowAll.background', path: ['permissionButton', 'allowAll', 'background'], group: 'control', label: 'Allow-all permission background', description: 'Allow-all button background in permission prompts.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.allowAll.foreground', path: ['permissionButton', 'allowAll', 'text'], group: 'control', label: 'Allow-all permission foreground', description: 'Allow-all button text and icon color in permission prompts.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.inactive.background', path: ['permissionButton', 'inactive', 'background'], group: 'control', label: 'Inactive permission background', description: 'Inactive permission button background.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.inactive.border', path: ['permissionButton', 'inactive', 'border'], group: 'control', label: 'Inactive permission border', description: 'Inactive permission button border.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.inactive.foreground', path: ['permissionButton', 'inactive', 'text'], group: 'control', label: 'Inactive permission foreground', description: 'Inactive permission button text and icon color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.selected.background', path: ['permissionButton', 'selected', 'background'], group: 'control', label: 'Selected permission background', description: 'Selected permission button background.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.selected.border', path: ['permissionButton', 'selected', 'border'], group: 'control', label: 'Selected permission border', description: 'Selected permission button border.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'control.permissionButton.selected.foreground', path: ['permissionButton', 'selected', 'text'], group: 'control', label: 'Selected permission foreground', description: 'Selected permission button text and icon color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'composer.chipTint', path: ['composer', 'chipTint'], group: 'composer', label: 'Composer chip tint', description: 'Foreground for composer chips, pills, and their low-emphasis action labels.', valueKind: 'color' }),

    defineEditableThemeColorToken({ id: 'message.user.background', path: ['message', 'user', 'background'], group: 'message', label: 'User message background', description: 'Background for user-authored transcript messages.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'message.user.foreground', path: ['message', 'user', 'foreground'], group: 'message', label: 'User message foreground', description: 'Foreground for user-authored transcript messages.', valueKind: 'color', contrastPairs: stateContrast('message.user.background') }),
    defineEditableThemeColorToken({ id: 'message.agent.foreground', path: ['message', 'agent', 'foreground'], group: 'message', label: 'Agent message foreground', description: 'Foreground for agent-authored transcript messages.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'message.event.foreground', path: ['message', 'event', 'foreground'], group: 'message', label: 'Event message foreground', description: 'Foreground for transcript event labels and metadata.', valueKind: 'color' }),

    defineEditableThemeColorToken({ id: 'syntax.keyword', path: ['syntax', 'keyword'], group: 'syntax', label: 'Syntax keyword', description: 'Keyword token foreground in code and syntax highlighting.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'syntax.string', path: ['syntax', 'string'], group: 'syntax', label: 'Syntax string', description: 'String token foreground in code and syntax highlighting.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'syntax.comment', path: ['syntax', 'comment'], group: 'syntax', label: 'Syntax comment', description: 'Comment token foreground in code and syntax highlighting.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'syntax.number', path: ['syntax', 'number'], group: 'syntax', label: 'Syntax number', description: 'Number token foreground in code and syntax highlighting.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'syntax.function', path: ['syntax', 'function'], group: 'syntax', label: 'Syntax function', description: 'Function/type token foreground in code and syntax highlighting.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'syntax.default', path: ['syntax', 'default'], group: 'syntax', label: 'Syntax default', description: 'Default code foreground for syntax themes.', valueKind: 'color', contrastPairs: stateContrast('surface.inset') }),

    defineEditableThemeColorToken({ id: 'versionControl.added.foreground', path: ['versionControl', 'added', 'foreground'], group: 'versionControl', label: 'Added foreground', description: 'Foreground for added source-control counts and labels.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'versionControl.removed.foreground', path: ['versionControl', 'removed', 'foreground'], group: 'versionControl', label: 'Removed foreground', description: 'Foreground for removed source-control counts and labels.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'versionControl.added.background', path: ['versionControl', 'added', 'background'], group: 'versionControl', label: 'Added background', description: 'Background for added source-control badges or pills.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'versionControl.removed.background', path: ['versionControl', 'removed', 'background'], group: 'versionControl', label: 'Removed background', description: 'Background for removed source-control badges or pills.', valueKind: 'color' }),

    defineEditableThemeColorToken({ id: 'diff.added.background', path: ['diff', 'added', 'background'], group: 'diff', label: 'Diff added background', description: 'Background for added lines in diff views.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'diff.added.foreground', path: ['diff', 'added', 'foreground'], group: 'diff', label: 'Diff added foreground', description: 'Foreground for added lines in diff views.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'diff.removed.background', path: ['diff', 'removed', 'background'], group: 'diff', label: 'Diff removed background', description: 'Background for removed lines in diff views.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'diff.removed.foreground', path: ['diff', 'removed', 'foreground'], group: 'diff', label: 'Diff removed foreground', description: 'Foreground for removed lines in diff views.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'diff.hunk.background', path: ['diff', 'hunk', 'background'], group: 'diff', label: 'Diff hunk background', description: 'Background for diff hunk header lines.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'diff.hunk.foreground', path: ['diff', 'hunk', 'foreground'], group: 'diff', label: 'Diff hunk foreground', description: 'Foreground for diff hunk header lines.', valueKind: 'color', contrastPairs: stateContrast('diff.hunk.background') }),
    defineEditableThemeColorToken({ id: 'diff.context.foreground', path: ['diff', 'context', 'foreground'], group: 'diff', label: 'Diff context foreground', description: 'Foreground for unchanged context lines in diff views.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'diff.inlineAdded.background', path: ['diff', 'inlineAdded', 'background'], group: 'diff', label: 'Inline added background', description: 'Background for inline added segments in diff views.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'diff.inlineAdded.foreground', path: ['diff', 'inlineAdded', 'foreground'], group: 'diff', label: 'Inline added foreground', description: 'Foreground for inline added segments in diff views.', valueKind: 'color', contrastPairs: stateContrast('diff.inlineAdded.background') }),
    defineEditableThemeColorToken({ id: 'diff.inlineRemoved.background', path: ['diff', 'inlineRemoved', 'background'], group: 'diff', label: 'Inline removed background', description: 'Background for inline removed segments in diff views.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'diff.inlineRemoved.foreground', path: ['diff', 'inlineRemoved', 'foreground'], group: 'diff', label: 'Inline removed foreground', description: 'Foreground for inline removed segments in diff views.', valueKind: 'color', contrastPairs: stateContrast('diff.inlineRemoved.background') }),

    defineEditableThemeColorToken({ id: 'permission.default', path: ['permission', 'default'], group: 'permission', label: 'Default permission', description: 'Default permission-mode color.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'permission.acceptEdits', path: ['permission', 'acceptEdits'], group: 'permission', label: 'Accept-edits permission', description: 'Permission-mode color for accepting edits.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'permission.bypass', path: ['permission', 'bypass'], group: 'permission', label: 'Bypass permission', description: 'Permission-mode color for bypass mode.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'permission.plan', path: ['permission', 'plan'], group: 'permission', label: 'Plan permission', description: 'Permission-mode color for plan mode.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'permission.readOnly', path: ['permission', 'readOnly'], group: 'permission', label: 'Read-only permission', description: 'Permission-mode color for read-only mode.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'permission.safeYolo', path: ['permission', 'safeYolo'], group: 'permission', label: 'Safe-yolo permission', description: 'Permission-mode color for safe-yolo mode.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'permission.yolo', path: ['permission', 'yolo'], group: 'permission', label: 'Yolo permission', description: 'Permission-mode color for yolo mode.', valueKind: 'color' }),

    defineEditableThemeColorToken({ id: 'overlay.scrimSoft', path: ['overlay', 'scrimSoft'], group: 'overlay', label: 'Soft scrim', description: 'Soft overlay scrim for lightweight overlays.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'overlay.scrim', path: ['overlay', 'scrim'], group: 'overlay', label: 'Scrim', description: 'Default overlay scrim for modals and overlays.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'overlay.scrimStrong', path: ['overlay', 'scrimStrong'], group: 'overlay', label: 'Strong scrim', description: 'Stronger overlay scrim for high-emphasis overlays.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'overlay.scrimWizard', path: ['overlay', 'scrimWizard'], group: 'overlay', label: 'Wizard scrim', description: 'Overlay scrim for wizard and guided flows.', valueKind: 'color' }),
    defineEditableThemeColorToken({ id: 'overlay.foreground', path: ['overlay', 'foreground'], group: 'overlay', label: 'Overlay foreground', description: 'Foreground rendered on top of overlay scrims.', valueKind: 'color', contrastPairs: stateContrast('overlay.scrim') }),
    defineEditableThemeColorToken({ id: 'overlay.secondaryForeground', path: ['overlay', 'secondaryForeground'], group: 'overlay', label: 'Overlay secondary foreground', description: 'Secondary foreground rendered on top of overlay scrims.', valueKind: 'color' }),
] as const;

export type ThemeColorTokenId = typeof EDITABLE_THEME_COLOR_TOKEN_DEFINITIONS[number]['id'];

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

const shadowLevelTokenClassifications = [1, 2, 3, 4, 5].flatMap((level) => [
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

    { path: ['feed', 'card', 'background'], status: 'derived', reason: 'Tool feed card surface derived from surface.elevated so private transcript chrome follows active theme profiles.' },
    { path: ['shadow', 'color'], status: 'internal', reason: 'Legacy tint helper for computed shadows, not a standalone editable color token.' },
    { path: ['shadowPopoverArrowBoxShadow'], status: 'internal', reason: 'Popover arrow shadow recipe string, not a standalone editable color token.' },
    { path: ['glass', 'border'], status: 'internal', reason: 'Floating glass surface rim recipe (GlassPanel); V1 exposes shared border tokens rather than feature-specific chrome details.' },
    { path: ['glass', 'innerShadow'], status: 'internal', reason: 'Floating glass surface inner shadow recipe string (GlassPanel), not a standalone editable color token.' },
    { path: ['glass', 'composerInnerShadow'], status: 'internal', reason: 'Reduced-opacity inner shadow recipe for the opt-in glass composer surface only; internal chrome recipe rather than a standalone editable color token.' },
    { path: ['glass', 'castShadow'], status: 'internal', reason: 'Floating glass surface cast shadow recipe string (GlassPanel), not a standalone editable color token.' },
    { path: ['glass', 'composerSurface'], status: 'internal', reason: 'Solid fill for the opt-in glass composer surface; internal chrome recipe rather than a standalone editable color token.' },
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
