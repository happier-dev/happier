import type { BuiltInThemeProfileDefinition, BuiltInThemeProfilePresetId, ThemeProfileColorOverrides, ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';
import { createBuiltInProfile } from './builtInThemeProfileFactory';

type CuratedThemePalette = Readonly<{
    canvas: string;
    base: string;
    inset: string;
    elevated: string;
    selected: string;
    pressed: string;
    pressedOverlay: string;
    sectionTint: string;
    ripple: string;
    borderDefault: string;
    borderSurface: string;
    borderStrong: string;
    borderModal: string;
    highlight: string;
    textPrimary: string;
    textSecondary: string;
    textTertiary: string;
    textLink: string;
    textDestructive: string;
    textPlaceholder: string;
    textDisabled: string;
    activeBackground: string;
    activeBorder: string;
    activeForeground: string;
    successForeground: string;
    successBackground: string;
    successBorder: string;
    warningForeground: string;
    warningBackground: string;
    warningBorder: string;
    dangerForeground: string;
    dangerBackground: string;
    dangerBorder: string;
    infoForeground: string;
    infoBackground: string;
    infoBorder: string;
    neutralBackground: string;
    neutralBorder: string;
    buttonBackground: string;
    buttonDisabled: string;
    inputBackground: string;
    switchActive: string;
    radioDot: string;
    syntaxKeyword: string;
    syntaxString: string;
    syntaxComment: string;
    syntaxNumber: string;
    syntaxFunction: string;
    diffAddedForeground: string;
    diffRemovedForeground: string;
    diffHunkForeground: string;
    permissionPlan: string;
    permissionReadOnly: string;
    overlayScrimSoft: string;
    overlayScrim: string;
    overlayScrimStrong: string;
    overlayScrimWizard: string;
}>;

const createCuratedThemeOverrides = (palette: CuratedThemePalette): ThemeProfileColorOverrides => ({
    'background.canvas': palette.canvas,
    'surface.base': palette.base,
    'surface.inset': palette.inset,
    'surface.elevated': palette.elevated,
    'surface.selected': palette.selected,
    'surface.pressed': palette.pressed,
    'surface.pressedOverlay': palette.pressedOverlay,
    'surface.sectionTint': palette.sectionTint,
    'surface.ripple': palette.ripple,
    'border.default': palette.borderDefault,
    'border.surface': palette.borderSurface,
    'border.strong': palette.borderStrong,
    'border.modal': palette.borderModal,
    'effect.surfaceHighlight': 'transparent',
    'chrome.header.background': palette.base,
    'chrome.header.foreground': palette.textPrimary,
    'text.primary': palette.textPrimary,
    'text.secondary': palette.textSecondary,
    'text.tertiary': palette.textTertiary,
    'text.link': palette.textLink,
    'text.destructive': palette.textDestructive,
    'text.placeholder': palette.textPlaceholder,
    'text.disabled': palette.textDisabled,
    'state.active.background': palette.activeBackground,
    'state.active.border': palette.activeBorder,
    'state.active.foreground': palette.activeForeground,
    'state.success.foreground': palette.successForeground,
    'state.success.background': palette.successBackground,
    'state.success.border': palette.successBorder,
    'state.warning.foreground': palette.warningForeground,
    'state.warning.background': palette.warningBackground,
    'state.warning.border': palette.warningBorder,
    'state.danger.foreground': palette.dangerForeground,
    'state.danger.background': palette.dangerBackground,
    'state.danger.border': palette.dangerBorder,
    'state.info.foreground': palette.infoForeground,
    'state.info.background': palette.infoBackground,
    'state.info.border': palette.infoBorder,
    'state.neutral.foreground': palette.textSecondary,
    'state.neutral.background': palette.neutralBackground,
    'state.neutral.border': palette.neutralBorder,
    'control.button.primary.background': palette.buttonBackground,
    'control.button.primary.foreground': palette.textPrimary,
    'control.button.primary.disabled': palette.buttonDisabled,
    'control.button.secondary.background': 'transparent',
    'control.button.secondary.foreground': palette.textPrimary,
    'control.input.background': palette.inputBackground,
    'control.input.foreground': palette.textPrimary,
    'control.input.placeholder': palette.textPlaceholder,
    'control.switch.track.active': palette.switchActive,
    'control.switch.track.inactive': palette.pressed,
    'control.switch.thumb.active': palette.textPrimary,
    'control.switch.thumb.inactive': palette.textSecondary,
    'control.radio.active': palette.activeForeground,
    'control.radio.inactive': palette.textTertiary,
    'control.radio.dot': palette.radioDot,
    'control.segmentedControl.trackBackground': palette.inset,
    'control.segmentedControl.activeBackground': palette.selected,
    'control.fab.background': palette.buttonBackground,
    'control.fab.backgroundPressed': palette.pressed,
    'control.fab.foreground': palette.textPrimary,
    'control.permissionButton.allow.background': palette.successBackground,
    'control.permissionButton.allow.foreground': palette.successForeground,
    'control.permissionButton.deny.background': palette.dangerBackground,
    'control.permissionButton.deny.foreground': palette.dangerForeground,
    'control.permissionButton.allowAll.background': palette.infoBackground,
    'control.permissionButton.allowAll.foreground': palette.infoForeground,
    'control.permissionButton.inactive.background': palette.inset,
    'control.permissionButton.inactive.border': palette.borderSurface,
    'control.permissionButton.inactive.foreground': palette.textSecondary,
    'control.permissionButton.selected.background': palette.selected,
    'control.permissionButton.selected.border': palette.borderStrong,
    'control.permissionButton.selected.foreground': palette.textPrimary,
    'message.user.background': palette.buttonBackground,
    'message.user.foreground': palette.textPrimary,
    'message.agent.foreground': palette.textPrimary,
    'message.event.foreground': palette.textSecondary,
    'syntax.keyword': palette.syntaxKeyword,
    'syntax.string': palette.syntaxString,
    'syntax.comment': palette.syntaxComment,
    'syntax.number': palette.syntaxNumber,
    'syntax.function': palette.syntaxFunction,
    'syntax.default': palette.textPrimary,
    'versionControl.added.foreground': palette.successForeground,
    'versionControl.removed.foreground': palette.dangerForeground,
    'versionControl.added.background': palette.successBackground,
    'versionControl.removed.background': palette.dangerBackground,
    'diff.added.background': palette.successBackground,
    'diff.added.foreground': palette.diffAddedForeground,
    'diff.removed.background': palette.dangerBackground,
    'diff.removed.foreground': palette.diffRemovedForeground,
    'diff.hunk.background': palette.infoBackground,
    'diff.hunk.foreground': palette.diffHunkForeground,
    'diff.context.foreground': palette.textSecondary,
    'diff.inlineAdded.background': palette.successBorder,
    'diff.inlineAdded.foreground': palette.diffAddedForeground,
    'diff.inlineRemoved.background': palette.dangerBorder,
    'diff.inlineRemoved.foreground': palette.diffRemovedForeground,
    'permission.default': palette.textSecondary,
    'permission.acceptEdits': palette.successForeground,
    'permission.bypass': palette.dangerForeground,
    'permission.plan': palette.permissionPlan,
    'permission.readOnly': palette.permissionReadOnly,
    'permission.safeYolo': palette.warningForeground,
    'permission.yolo': palette.dangerForeground,
    'overlay.scrimSoft': palette.overlayScrimSoft,
    'overlay.scrim': palette.overlayScrim,
    'overlay.scrimStrong': palette.overlayScrimStrong,
    'overlay.scrimWizard': palette.overlayScrimWizard,
    'overlay.foreground': palette.textPrimary,
    'overlay.secondaryForeground': palette.textSecondary,
});

const createCuratedBuiltInProfile = (
    presetId: BuiltInThemeProfilePresetId,
    name: string,
    preferredMode: ThemeProfileMode,
    overrides: ThemeProfileV1['overrides'],
): BuiltInThemeProfileDefinition => ({
    presetId,
    translationKey: `settingsAppearance.themeProfiles.presets.${presetId}`,
    preferredMode,
    cloneable: true,
    editable: false,
    deletable: false,
    profile: createBuiltInProfile(presetId, name, preferredMode, overrides),
});

const createDarkProfile = (presetId: BuiltInThemeProfilePresetId, name: string, palette: CuratedThemePalette): BuiltInThemeProfileDefinition => (
    createCuratedBuiltInProfile(presetId, name, 'dark', { light: {}, dark: createCuratedThemeOverrides(palette) })
);

const createLightProfile = (presetId: BuiltInThemeProfilePresetId, name: string, palette: CuratedThemePalette): BuiltInThemeProfileDefinition => (
    createCuratedBuiltInProfile(presetId, name, 'light', { light: createCuratedThemeOverrides(palette), dark: {} })
);

export const COMMUNITY_BUILT_IN_THEME_PROFILES: readonly BuiltInThemeProfileDefinition[] = [
    createDarkProfile('catppuccinMocha', 'Catppuccin Mocha', {
        canvas: '#11111B', base: '#1E1E2E', inset: '#181825', elevated: '#313244', selected: '#45475A', pressed: '#585B70',
        pressedOverlay: 'rgba(205,214,244,0.08)', sectionTint: 'rgba(255,255,255,0.014)', ripple: 'rgba(205,214,244,0.12)', borderDefault: 'rgba(205,214,244,0.08)', borderSurface: 'rgba(205,214,244,0.11)', borderStrong: 'rgba(205,214,244,0.18)', borderModal: 'rgba(205,214,244,0.14)', highlight: 'rgba(205,214,244,0.045)',
        textPrimary: '#CDD6F4', textSecondary: '#BAC2DE', textTertiary: '#9399B2', textLink: '#89B4FA', textDestructive: '#F38BA8', textPlaceholder: '#7F849C', textDisabled: '#6C7086',
        activeBackground: 'rgba(137,180,250,0.16)', activeBorder: 'rgba(137,180,250,0.38)', activeForeground: '#89B4FA', successForeground: '#A6E3A1', successBackground: 'rgba(166,227,161,0.12)', successBorder: 'rgba(166,227,161,0.24)', warningForeground: '#F9E2AF', warningBackground: 'rgba(249,226,175,0.12)', warningBorder: 'rgba(249,226,175,0.24)', dangerForeground: '#F38BA8', dangerBackground: 'rgba(243,139,168,0.13)', dangerBorder: 'rgba(243,139,168,0.26)', infoForeground: '#89B4FA', infoBackground: 'rgba(137,180,250,0.13)', infoBorder: 'rgba(137,180,250,0.28)', neutralBackground: 'rgba(186,194,222,0.10)', neutralBorder: 'rgba(186,194,222,0.20)',
        buttonBackground: '#313244', buttonDisabled: '#45475A', inputBackground: '#181825', switchActive: '#89B4FA', radioDot: '#11111B', syntaxKeyword: '#CBA6F7', syntaxString: '#A6E3A1', syntaxComment: '#6C7086', syntaxNumber: '#FAB387', syntaxFunction: '#89B4FA', diffAddedForeground: '#D0F5CD', diffRemovedForeground: '#F7C7D5', diffHunkForeground: '#CFE0FF', permissionPlan: '#CBA6F7', permissionReadOnly: '#89B4FA', overlayScrimSoft: 'rgba(17,17,27,0.60)', overlayScrim: 'rgba(17,17,27,0.76)', overlayScrimStrong: 'rgba(17,17,27,0.88)', overlayScrimWizard: 'rgba(17,17,27,0.80)',
    }),
    createDarkProfile('catppuccinMacchiato', 'Catppuccin Macchiato', {
        canvas: '#181926', base: '#24273A', inset: '#1E2030', elevated: '#363A4F', selected: '#494D64', pressed: '#5B6078',
        pressedOverlay: 'rgba(202,211,245,0.08)', sectionTint: 'rgba(255,255,255,0.014)', ripple: 'rgba(202,211,245,0.12)', borderDefault: 'rgba(202,211,245,0.08)', borderSurface: 'rgba(202,211,245,0.11)', borderStrong: 'rgba(202,211,245,0.18)', borderModal: 'rgba(202,211,245,0.14)', highlight: 'rgba(202,211,245,0.045)',
        textPrimary: '#CAD3F5', textSecondary: '#B8C0E0', textTertiary: '#939AB7', textLink: '#8AADF4', textDestructive: '#ED8796', textPlaceholder: '#8087A2', textDisabled: '#6E738D',
        activeBackground: 'rgba(138,173,244,0.16)', activeBorder: 'rgba(138,173,244,0.38)', activeForeground: '#8AADF4', successForeground: '#A6DA95', successBackground: 'rgba(166,218,149,0.12)', successBorder: 'rgba(166,218,149,0.24)', warningForeground: '#EED49F', warningBackground: 'rgba(238,212,159,0.12)', warningBorder: 'rgba(238,212,159,0.24)', dangerForeground: '#ED8796', dangerBackground: 'rgba(237,135,150,0.13)', dangerBorder: 'rgba(237,135,150,0.26)', infoForeground: '#8AADF4', infoBackground: 'rgba(138,173,244,0.13)', infoBorder: 'rgba(138,173,244,0.28)', neutralBackground: 'rgba(184,192,224,0.10)', neutralBorder: 'rgba(184,192,224,0.20)',
        buttonBackground: '#363A4F', buttonDisabled: '#494D64', inputBackground: '#1E2030', switchActive: '#8AADF4', radioDot: '#181926', syntaxKeyword: '#C6A0F6', syntaxString: '#A6DA95', syntaxComment: '#6E738D', syntaxNumber: '#F5A97F', syntaxFunction: '#8AADF4', diffAddedForeground: '#D1F1C9', diffRemovedForeground: '#F6C4CB', diffHunkForeground: '#CEDCFF', permissionPlan: '#C6A0F6', permissionReadOnly: '#8AADF4', overlayScrimSoft: 'rgba(24,25,38,0.60)', overlayScrim: 'rgba(24,25,38,0.76)', overlayScrimStrong: 'rgba(24,25,38,0.88)', overlayScrimWizard: 'rgba(24,25,38,0.80)',
    }),
    createDarkProfile('catppuccinFrappe', 'Catppuccin Frappé', {
        canvas: '#232634', base: '#303446', inset: '#292C3C', elevated: '#414559', selected: '#51576D', pressed: '#626880',
        pressedOverlay: 'rgba(198,208,245,0.08)', sectionTint: 'rgba(255,255,255,0.014)', ripple: 'rgba(198,208,245,0.12)', borderDefault: 'rgba(198,208,245,0.08)', borderSurface: 'rgba(198,208,245,0.11)', borderStrong: 'rgba(198,208,245,0.18)', borderModal: 'rgba(198,208,245,0.14)', highlight: 'rgba(198,208,245,0.045)',
        textPrimary: '#C6D0F5', textSecondary: '#B5BFE2', textTertiary: '#949CBB', textLink: '#8CAAEE', textDestructive: '#E78284', textPlaceholder: '#838BA7', textDisabled: '#737994',
        activeBackground: 'rgba(140,170,238,0.16)', activeBorder: 'rgba(140,170,238,0.38)', activeForeground: '#8CAAEE', successForeground: '#A6D189', successBackground: 'rgba(166,209,137,0.12)', successBorder: 'rgba(166,209,137,0.24)', warningForeground: '#E5C890', warningBackground: 'rgba(229,200,144,0.12)', warningBorder: 'rgba(229,200,144,0.24)', dangerForeground: '#E78284', dangerBackground: 'rgba(231,130,132,0.13)', dangerBorder: 'rgba(231,130,132,0.26)', infoForeground: '#8CAAEE', infoBackground: 'rgba(140,170,238,0.13)', infoBorder: 'rgba(140,170,238,0.28)', neutralBackground: 'rgba(181,191,226,0.10)', neutralBorder: 'rgba(181,191,226,0.20)',
        buttonBackground: '#414559', buttonDisabled: '#51576D', inputBackground: '#292C3C', switchActive: '#8CAAEE', radioDot: '#232634', syntaxKeyword: '#CA9EE6', syntaxString: '#A6D189', syntaxComment: '#737994', syntaxNumber: '#EF9F76', syntaxFunction: '#8CAAEE', diffAddedForeground: '#D0EAC1', diffRemovedForeground: '#F2BCBE', diffHunkForeground: '#CFDCFF', permissionPlan: '#CA9EE6', permissionReadOnly: '#8CAAEE', overlayScrimSoft: 'rgba(35,38,52,0.60)', overlayScrim: 'rgba(35,38,52,0.76)', overlayScrimStrong: 'rgba(35,38,52,0.88)', overlayScrimWizard: 'rgba(35,38,52,0.80)',
    }),
    createDarkProfile('oneDarkPro', 'One Dark Pro', {
        canvas: '#21252B', base: '#282C34', inset: '#1D1F23', elevated: '#2C313A', selected: '#3E4452', pressed: '#404754',
        pressedOverlay: 'rgba(171,178,191,0.08)', sectionTint: 'rgba(255,255,255,0.014)', ripple: 'rgba(171,178,191,0.12)', borderDefault: '#3E4452', borderSurface: 'rgba(171,178,191,0.11)', borderStrong: 'rgba(171,178,191,0.19)', borderModal: 'rgba(171,178,191,0.15)', highlight: 'rgba(171,178,191,0.04)',
        textPrimary: '#ABB2BF', textSecondary: '#8B93A1', textTertiary: '#5C6370', textLink: '#61AFEF', textDestructive: '#E06C75', textPlaceholder: '#5C6370', textDisabled: '#495162',
        activeBackground: 'rgba(97,175,239,0.15)', activeBorder: 'rgba(97,175,239,0.36)', activeForeground: '#61AFEF', successForeground: '#98C379', successBackground: 'rgba(152,195,121,0.12)', successBorder: 'rgba(152,195,121,0.25)', warningForeground: '#E5C07B', warningBackground: 'rgba(229,192,123,0.12)', warningBorder: 'rgba(229,192,123,0.25)', dangerForeground: '#E06C75', dangerBackground: 'rgba(224,108,117,0.13)', dangerBorder: 'rgba(224,108,117,0.27)', infoForeground: '#61AFEF', infoBackground: 'rgba(97,175,239,0.13)', infoBorder: 'rgba(97,175,239,0.28)', neutralBackground: 'rgba(171,178,191,0.10)', neutralBorder: 'rgba(171,178,191,0.19)',
        buttonBackground: '#404754', buttonDisabled: '#3E4452', inputBackground: '#1D1F23', switchActive: '#528BFF', radioDot: '#21252B', syntaxKeyword: '#C678DD', syntaxString: '#98C379', syntaxComment: '#5C6370', syntaxNumber: '#D19A66', syntaxFunction: '#61AFEF', diffAddedForeground: '#C8E5B5', diffRemovedForeground: '#F0BDC2', diffHunkForeground: '#C4E5FF', permissionPlan: '#C678DD', permissionReadOnly: '#61AFEF', overlayScrimSoft: 'rgba(33,37,43,0.58)', overlayScrim: 'rgba(33,37,43,0.74)', overlayScrimStrong: 'rgba(33,37,43,0.88)', overlayScrimWizard: 'rgba(33,37,43,0.80)',
    }),
    createDarkProfile('monokaiPro', 'Monokai Pro', {
        canvas: '#221F22', base: '#2D2A2E', inset: '#19181A', elevated: '#403E41', selected: '#5B595C', pressed: '#68666A',
        pressedOverlay: 'rgba(252,252,250,0.07)', sectionTint: 'rgba(255,255,255,0.014)', ripple: 'rgba(252,252,250,0.11)', borderDefault: '#19181A', borderSurface: 'rgba(252,252,250,0.10)', borderStrong: 'rgba(252,252,250,0.18)', borderModal: 'rgba(252,252,250,0.14)', highlight: 'rgba(252,252,250,0.045)',
        textPrimary: '#FCFCFA', textSecondary: '#C1C0C0', textTertiary: '#939293', textLink: '#78DCE8', textDestructive: '#FF6188', textPlaceholder: '#727072', textDisabled: '#727072',
        activeBackground: 'rgba(255,216,102,0.15)', activeBorder: 'rgba(255,216,102,0.36)', activeForeground: '#FFD866', successForeground: '#A9DC76', successBackground: 'rgba(169,220,118,0.12)', successBorder: 'rgba(169,220,118,0.25)', warningForeground: '#FFD866', warningBackground: 'rgba(255,216,102,0.12)', warningBorder: 'rgba(255,216,102,0.25)', dangerForeground: '#FF6188', dangerBackground: 'rgba(255,97,136,0.13)', dangerBorder: 'rgba(255,97,136,0.27)', infoForeground: '#78DCE8', infoBackground: 'rgba(120,220,232,0.12)', infoBorder: 'rgba(120,220,232,0.26)', neutralBackground: 'rgba(193,192,192,0.10)', neutralBorder: 'rgba(193,192,192,0.20)',
        buttonBackground: '#403E41', buttonDisabled: '#5B595C', inputBackground: '#221F22', switchActive: '#FFD866', radioDot: '#221F22', syntaxKeyword: '#FF6188', syntaxString: '#FFD866', syntaxComment: '#727072', syntaxNumber: '#AB9DF2', syntaxFunction: '#A9DC76', diffAddedForeground: '#D9F3B8', diffRemovedForeground: '#FFC2D1', diffHunkForeground: '#C5F2F7', permissionPlan: '#AB9DF2', permissionReadOnly: '#78DCE8', overlayScrimSoft: 'rgba(34,31,34,0.60)', overlayScrim: 'rgba(34,31,34,0.76)', overlayScrimStrong: 'rgba(34,31,34,0.88)', overlayScrimWizard: 'rgba(34,31,34,0.80)',
    }),
    createDarkProfile('githubDark', 'GitHub Dark', {
        canvas: '#0D1117', base: '#161B22', inset: '#010409', elevated: '#21262D', selected: '#30363D', pressed: '#3B434D',
        pressedOverlay: 'rgba(230,237,243,0.08)', sectionTint: 'rgba(255,255,255,0.014)', ripple: 'rgba(230,237,243,0.12)', borderDefault: '#30363D', borderSurface: '#30363D', borderStrong: '#484F58', borderModal: '#30363D', highlight: 'rgba(230,237,243,0.035)',
        textPrimary: '#E6EDF3', textSecondary: '#7D8590', textTertiary: '#6E7681', textLink: '#2F81F7', textDestructive: '#F85149', textPlaceholder: '#6E7681', textDisabled: '#484F58',
        activeBackground: 'rgba(47,129,247,0.14)', activeBorder: 'rgba(47,129,247,0.38)', activeForeground: '#2F81F7', successForeground: '#3FB950', successBackground: 'rgba(63,185,80,0.12)', successBorder: 'rgba(63,185,80,0.25)', warningForeground: '#D29922', warningBackground: 'rgba(210,153,34,0.12)', warningBorder: 'rgba(210,153,34,0.25)', dangerForeground: '#F85149', dangerBackground: 'rgba(248,81,73,0.13)', dangerBorder: 'rgba(248,81,73,0.27)', infoForeground: '#2F81F7', infoBackground: 'rgba(47,129,247,0.13)', infoBorder: 'rgba(47,129,247,0.28)', neutralBackground: 'rgba(125,133,144,0.11)', neutralBorder: 'rgba(125,133,144,0.22)',
        buttonBackground: '#21262D', buttonDisabled: '#30363D', inputBackground: '#0D1117', switchActive: '#238636', radioDot: '#0D1117', syntaxKeyword: '#FF7B72', syntaxString: '#A5D6FF', syntaxComment: '#8B949E', syntaxNumber: '#79C0FF', syntaxFunction: '#D2A8FF', diffAddedForeground: '#AFF5B4', diffRemovedForeground: '#FFDCD7', diffHunkForeground: '#A5D6FF', permissionPlan: '#D2A8FF', permissionReadOnly: '#79C0FF', overlayScrimSoft: 'rgba(1,4,9,0.56)', overlayScrim: 'rgba(1,4,9,0.74)', overlayScrimStrong: 'rgba(1,4,9,0.88)', overlayScrimWizard: 'rgba(1,4,9,0.80)',
    }),
    createDarkProfile('darkModern', 'Dark Modern', {
        canvas: '#181818', base: '#1F1F1F', inset: '#141414', elevated: '#2A2A2A', selected: '#313131', pressed: '#3A3A3A',
        pressedOverlay: 'rgba(204,204,204,0.08)', sectionTint: 'rgba(255,255,255,0.014)', ripple: 'rgba(204,204,204,0.12)', borderDefault: '#2B2B2B', borderSurface: '#3C3C3C', borderStrong: '#5A5A5A', borderModal: '#454545', highlight: 'rgba(255,255,255,0.035)',
        textPrimary: '#CCCCCC', textSecondary: '#A6A6A6', textTertiary: '#858585', textLink: '#0078D4', textDestructive: '#F14C4C', textPlaceholder: '#858585', textDisabled: '#6E7681',
        activeBackground: 'rgba(0,120,212,0.16)', activeBorder: 'rgba(0,120,212,0.40)', activeForeground: '#0078D4', successForeground: '#89D185', successBackground: 'rgba(137,209,133,0.12)', successBorder: 'rgba(137,209,133,0.25)', warningForeground: '#CCA700', warningBackground: 'rgba(204,167,0,0.12)', warningBorder: 'rgba(204,167,0,0.25)', dangerForeground: '#F14C4C', dangerBackground: 'rgba(241,76,76,0.13)', dangerBorder: 'rgba(241,76,76,0.27)', infoForeground: '#0078D4', infoBackground: 'rgba(0,120,212,0.13)', infoBorder: 'rgba(0,120,212,0.28)', neutralBackground: 'rgba(166,166,166,0.10)', neutralBorder: 'rgba(166,166,166,0.20)',
        buttonBackground: '#313131', buttonDisabled: '#3A3A3A', inputBackground: '#313131', switchActive: '#0078D4', radioDot: '#181818', syntaxKeyword: '#569CD6', syntaxString: '#CE9178', syntaxComment: '#6A9955', syntaxNumber: '#B5CEA8', syntaxFunction: '#DCDCAA', diffAddedForeground: '#B5F2B1', diffRemovedForeground: '#FFC9C9', diffHunkForeground: '#9CDCFE', permissionPlan: '#C586C0', permissionReadOnly: '#9CDCFE', overlayScrimSoft: 'rgba(0,0,0,0.52)', overlayScrim: 'rgba(0,0,0,0.70)', overlayScrimStrong: 'rgba(0,0,0,0.84)', overlayScrimWizard: 'rgba(0,0,0,0.78)',
    }),
    createDarkProfile('graphiteDark', 'Graphite Dark', {
        canvas: '#121212', base: '#191919', inset: '#161616', elevated: '#222222', selected: '#2A2A2A', pressed: '#333333',
        pressedOverlay: 'rgba(234,234,234,0.035)', sectionTint: 'rgba(255,255,255,0.014)', ripple: 'rgba(234,234,234,0.055)', borderDefault: 'rgba(255,255,255,0.045)', borderSurface: 'rgba(255,255,255,0.055)', borderStrong: 'rgba(255,255,255,0.085)', borderModal: 'rgba(255,255,255,0.060)', highlight: 'transparent',
        textPrimary: '#EAEAEA', textSecondary: '#ACACAC', textTertiary: '#8E8E8E', textLink: '#ACACAC', textDestructive: '#C36A5A', textPlaceholder: '#8E8E8E', textDisabled: '#767676',
        activeBackground: 'rgba(172,172,172,0.08)', activeBorder: 'rgba(172,172,172,0.18)', activeForeground: '#EAEAEA', successForeground: '#9AA59A', successBackground: 'rgba(154,165,154,0.09)', successBorder: 'rgba(154,165,154,0.20)', warningForeground: '#C3A86A', warningBackground: 'rgba(195,168,106,0.09)', warningBorder: 'rgba(195,168,106,0.20)', dangerForeground: '#C36A5A', dangerBackground: 'rgba(195,106,90,0.09)', dangerBorder: 'rgba(195,106,90,0.20)', infoForeground: '#A8A8A8', infoBackground: 'rgba(168,168,168,0.08)', infoBorder: 'rgba(168,168,168,0.18)', neutralBackground: 'rgba(172,172,172,0.06)', neutralBorder: 'rgba(172,172,172,0.12)',
        buttonBackground: '#222222', buttonDisabled: '#2A2A2A', inputBackground: '#191919', switchActive: '#A8A8A8', radioDot: '#121212', syntaxKeyword: '#A8A8A8', syntaxString: '#B7B7B7', syntaxComment: '#8E8E8E', syntaxNumber: '#C3A86A', syntaxFunction: '#A8A8A8', diffAddedForeground: '#D7D7D7', diffRemovedForeground: '#E9B3A9', diffHunkForeground: '#D0D0D0', permissionPlan: '#A8A8A8', permissionReadOnly: '#A8A8A8', overlayScrimSoft: 'rgba(18,18,18,0.56)', overlayScrim: 'rgba(18,18,18,0.74)', overlayScrimStrong: 'rgba(18,18,18,0.88)', overlayScrimWizard: 'rgba(18,18,18,0.80)',
    }),
    createLightProfile('paperLight', 'Paper Light', {
        canvas: '#F8F8F2', base: '#FFFFFF', inset: '#F0F0EA', elevated: '#FBFBF7', selected: '#E6E6DF', pressed: '#D8D8D0',
        pressedOverlay: 'rgba(28,28,28,0.04)', sectionTint: 'rgba(0,0,0,0.012)', ripple: 'rgba(28,28,28,0.06)', borderDefault: 'rgba(68,68,68,0.10)', borderSurface: 'rgba(68,68,68,0.12)', borderStrong: 'rgba(68,68,68,0.20)', borderModal: 'rgba(68,68,68,0.14)', highlight: 'transparent',
        textPrimary: '#1C1C1C', textSecondary: '#444444', textTertiary: '#666666', textLink: '#5C84C4', textDestructive: '#B64A4A', textPlaceholder: '#777777', textDisabled: '#8A8A8A',
        activeBackground: 'rgba(92,132,196,0.08)', activeBorder: 'rgba(92,132,196,0.24)', activeForeground: '#5C84C4', successForeground: '#4E8B66', successBackground: 'rgba(78,139,102,0.10)', successBorder: 'rgba(78,139,102,0.22)', warningForeground: '#A88635', warningBackground: 'rgba(168,134,53,0.10)', warningBorder: 'rgba(168,134,53,0.22)', dangerForeground: '#B64A4A', dangerBackground: 'rgba(182,74,74,0.10)', dangerBorder: 'rgba(182,74,74,0.22)', infoForeground: '#5C84C4', infoBackground: 'rgba(92,132,196,0.08)', infoBorder: 'rgba(92,132,196,0.20)', neutralBackground: 'rgba(68,68,68,0.07)', neutralBorder: 'rgba(68,68,68,0.14)',
        buttonBackground: '#F0F0EA', buttonDisabled: '#E6E6DF', inputBackground: '#FFFFFF', switchActive: '#5C84C4', radioDot: '#FFFFFF', syntaxKeyword: '#7A54B6', syntaxString: '#4E8B66', syntaxComment: '#777777', syntaxNumber: '#A88635', syntaxFunction: '#5C84C4', diffAddedForeground: '#3F7A58', diffRemovedForeground: '#9E3F3F', diffHunkForeground: '#2E5D9E', permissionPlan: '#7A54B6', permissionReadOnly: '#5C84C4', overlayScrimSoft: 'rgba(28,28,28,0.20)', overlayScrim: 'rgba(28,28,28,0.34)', overlayScrimStrong: 'rgba(28,28,28,0.50)', overlayScrimWizard: 'rgba(28,28,28,0.42)',
    }),
    createLightProfile('catppuccinLatte', 'Catppuccin Latte', {
        canvas: '#EFF1F5', base: '#FFFFFF', inset: '#E6E9EF', elevated: '#F8F9FC', selected: '#DCE0E8', pressed: '#CCD0DA',
        pressedOverlay: 'rgba(76,79,105,0.08)', sectionTint: 'rgba(0,0,0,0.012)', ripple: 'rgba(76,79,105,0.11)', borderDefault: 'rgba(76,79,105,0.12)', borderSurface: 'rgba(76,79,105,0.14)', borderStrong: 'rgba(76,79,105,0.24)', borderModal: 'rgba(76,79,105,0.18)', highlight: 'transparent',
        textPrimary: '#4C4F69', textSecondary: '#5C5F77', textTertiary: '#7C7F93', textLink: '#1E66F5', textDestructive: '#D20F39', textPlaceholder: '#8C8FA1', textDisabled: '#9CA0B0',
        activeBackground: 'rgba(30,102,245,0.10)', activeBorder: 'rgba(30,102,245,0.34)', activeForeground: '#1E66F5', successForeground: '#40A02B', successBackground: 'rgba(64,160,43,0.10)', successBorder: 'rgba(64,160,43,0.22)', warningForeground: '#DF8E1D', warningBackground: 'rgba(223,142,29,0.10)', warningBorder: 'rgba(223,142,29,0.22)', dangerForeground: '#D20F39', dangerBackground: 'rgba(210,15,57,0.10)', dangerBorder: 'rgba(210,15,57,0.22)', infoForeground: '#1E66F5', infoBackground: 'rgba(30,102,245,0.10)', infoBorder: 'rgba(30,102,245,0.24)', neutralBackground: 'rgba(92,95,119,0.08)', neutralBorder: 'rgba(92,95,119,0.18)',
        buttonBackground: '#E6E9EF', buttonDisabled: '#DCE0E8', inputBackground: '#FFFFFF', switchActive: '#1E66F5', radioDot: '#FFFFFF', syntaxKeyword: '#8839EF', syntaxString: '#40A02B', syntaxComment: '#9CA0B0', syntaxNumber: '#FE640B', syntaxFunction: '#1E66F5', diffAddedForeground: '#1E6B18', diffRemovedForeground: '#A40C2C', diffHunkForeground: '#144AAE', permissionPlan: '#8839EF', permissionReadOnly: '#1E66F5', overlayScrimSoft: 'rgba(76,79,105,0.20)', overlayScrim: 'rgba(76,79,105,0.34)', overlayScrimStrong: 'rgba(76,79,105,0.50)', overlayScrimWizard: 'rgba(76,79,105,0.42)',
    }),
    createLightProfile('githubLight', 'GitHub Light', {
        canvas: '#FFFFFF', base: '#F6F8FA', inset: '#F6F8FA', elevated: '#FFFFFF', selected: '#EAEEF2', pressed: '#D8DEE4',
        pressedOverlay: 'rgba(31,35,40,0.07)', sectionTint: 'rgba(0,0,0,0.012)', ripple: 'rgba(31,35,40,0.10)', borderDefault: '#D0D7DE', borderSurface: '#D0D7DE', borderStrong: '#8C959F', borderModal: '#D0D7DE', highlight: 'transparent',
        textPrimary: '#1F2328', textSecondary: '#656D76', textTertiary: '#6E7781', textLink: '#0969DA', textDestructive: '#CF222E', textPlaceholder: '#6E7781', textDisabled: '#8C959F',
        activeBackground: 'rgba(9,105,218,0.10)', activeBorder: 'rgba(9,105,218,0.34)', activeForeground: '#0969DA', successForeground: '#1F883D', successBackground: 'rgba(31,136,61,0.10)', successBorder: 'rgba(31,136,61,0.22)', warningForeground: '#9A6700', warningBackground: 'rgba(154,103,0,0.10)', warningBorder: 'rgba(154,103,0,0.22)', dangerForeground: '#CF222E', dangerBackground: 'rgba(207,34,46,0.10)', dangerBorder: 'rgba(207,34,46,0.22)', infoForeground: '#0969DA', infoBackground: 'rgba(9,105,218,0.10)', infoBorder: 'rgba(9,105,218,0.24)', neutralBackground: 'rgba(101,109,118,0.08)', neutralBorder: 'rgba(101,109,118,0.18)',
        buttonBackground: '#F6F8FA', buttonDisabled: '#EAEEF2', inputBackground: '#FFFFFF', switchActive: '#1F883D', radioDot: '#FFFFFF', syntaxKeyword: '#CF222E', syntaxString: '#0A3069', syntaxComment: '#6E7781', syntaxNumber: '#0550AE', syntaxFunction: '#8250DF', diffAddedForeground: '#116329', diffRemovedForeground: '#A40E26', diffHunkForeground: '#0969DA', permissionPlan: '#8250DF', permissionReadOnly: '#0969DA', overlayScrimSoft: 'rgba(31,35,40,0.20)', overlayScrim: 'rgba(31,35,40,0.34)', overlayScrimStrong: 'rgba(31,35,40,0.50)', overlayScrimWizard: 'rgba(31,35,40,0.42)',
    }),
] as const;
