import { describe, expect, it } from 'vitest';

import { resolveThemeProfile } from './resolveThemeProfile';
import { createThemeProfileDraft, resetThemeProfileDraftToken } from './createThemeProfileDraft';
import { BUILT_IN_THEME_PROFILES, getBuiltInThemeProfileDefinition } from './builtInThemeProfiles';

const importedDarkThemePresetIds = [
    'catppuccinMocha',
    'catppuccinMacchiato',
    'catppuccinFrappe',
    'oneDarkPro',
    'monokaiPro',
    'githubDark',
    'darkModern',
] as const;

const sunsetDarkSeed = {
    'background.canvas': '#131111',
    'surface.base': '#191717',
    'surface.inset': '#171515',
    'surface.elevated': '#221C1C',
    'surface.selected': '#292121',
    'surface.pressed': '#302727',
    'border.surface': 'rgba(255,255,255,0.056)',
    'border.strong': 'rgba(255,255,255,0.090)',
    'effect.surfaceHighlight': 'transparent',
    'text.primary': '#EFEFEF',
    'text.secondary': '#8A817C',
    'text.tertiary': '#6C625D',
    'text.link': '#D8B45A',
    'text.destructive': '#D06A49',
    'text.placeholder': '#766C67',
    'text.disabled': '#635955',
    'state.active.background': 'rgba(208,106,73,0.11)',
    'state.active.border': 'rgba(208,106,73,0.26)',
    'state.active.foreground': '#D06A49',
    'state.success.foreground': '#66DC7E',
    'state.success.background': 'rgba(102,220,126,0.11)',
    'state.success.border': 'rgba(102,220,126,0.24)',
    'state.warning.foreground': '#E0B65A',
    'state.warning.background': 'rgba(224,182,90,0.10)',
    'state.warning.border': 'rgba(224,182,90,0.22)',
    'state.danger.foreground': '#D06A49',
    'state.danger.background': 'rgba(208,106,73,0.10)',
    'state.danger.border': 'rgba(208,106,73,0.22)',
    'state.info.foreground': '#D8B45A',
    'state.info.background': 'rgba(216,180,90,0.08)',
    'state.info.border': 'rgba(216,180,90,0.20)',
    'control.input.background': '#171515',
    'control.button.primary.background': '#221C1C',
    'control.button.primary.foreground': '#EFEFEF',
    'control.button.primary.disabled': '#2A2323',
    'control.fab.background': '#221C1C',
    'control.fab.backgroundPressed': '#2A2323',
    'control.fab.foreground': '#EFEFEF',
    'control.segmentedControl.trackBackground': '#201A1A',
    'control.segmentedControl.activeBackground': '#2A2222',
    'control.switch.track.active': '#D06A49',
    'control.switch.track.inactive': '#252121',
    'control.switch.thumb.inactive': '#766C67',
    'control.radio.active': '#E0B65A',
    'control.radio.inactive': '#766C67',
    'control.permissionButton.allowAll.background': 'rgba(216,180,90,0.14)',
    'control.permissionButton.allowAll.foreground': '#D8B45A',
    'control.permissionButton.inactive.background': '#131111',
    'control.permissionButton.inactive.border': 'rgba(255,255,255,0.050)',
    'control.permissionButton.inactive.foreground': '#8A817C',
    'control.permissionButton.selected.background': '#2A2222',
    'control.permissionButton.selected.border': 'rgba(255,255,255,0.090)',
    'message.user.background': '#221C1C',
    'message.event.foreground': '#8A817C',
    'syntax.keyword': '#D06A49',
    'syntax.string': '#66DC7E',
    'syntax.comment': '#6C625D',
    'syntax.number': '#E0B65A',
    'syntax.function': '#E9A06C',
    'overlay.scrim': 'rgba(19,17,17,0.72)',
};

const classicDarkSeed = {
    'background.canvas': '#181818',
    'surface.base': '#202020',
    'surface.inset': '#171717',
    'surface.elevated': '#292929',
    'surface.selected': '#2C2C2C',
    'surface.pressed': '#2C2C2C',
    'text.primary': '#ffffff',
    'text.secondary': '#99999d',
    'text.link': '#2BACCC',
    'text.destructive': '#FF453A',
    'state.active.foreground': '#0A84FF',
    'state.success.foreground': '#32D74B',
    'state.warning.foreground': '#FF9F0A',
    'state.danger.foreground': '#FF453A',
    'control.segmentedControl.trackBackground': '#292929',
    'control.button.primary.background': '#1b1b1b',
    'control.input.background': '#303030',
    'message.user.background': '#2C2C2C',
    'syntax.keyword': '#569CD6',
    'versionControl.added.foreground': '#34C759',
    'permission.acceptEdits': '#0A84FF',
    'overlay.scrim': 'rgba(0, 0, 0, 0.45)',
};

const tokyoNightSeed = {
    'background.canvas': '#1A1B26',
    'surface.base': '#16161E',
    'surface.inset': '#13131A',
    'surface.elevated': '#202330',
    'surface.selected': '#24283B',
    'surface.pressed': '#292E42',
    'border.surface': 'rgba(122,162,247,0.14)',
    'border.strong': 'rgba(122,162,247,0.20)',
    'effect.surfaceHighlight': 'transparent',
    'text.primary': '#A9B1D6',
    'text.secondary': '#787C99',
    'text.tertiary': '#545C7E',
    'state.active.background': 'rgba(122,162,247,0.12)',
    'state.active.border': 'rgba(122,162,247,0.28)',
    'state.active.foreground': '#7DCFFF',
    'control.input.background': '#14141B',
    'control.button.primary.background': '#202330',
    'control.button.primary.foreground': '#A9B1D6',
    'control.fab.background': '#202330',
    'control.fab.foreground': '#A9B1D6',
    'syntax.keyword': '#7AA2F7',
};

const paperLightSeed = {
    'background.canvas': '#F8F8F2',
    'surface.base': '#FFFFFF',
    'surface.inset': '#F0F0EA',
    'surface.elevated': '#FBFBF7',
    'surface.selected': '#E6E6DF',
    'surface.pressed': '#D8D8D0',
    'effect.surfaceHighlight': 'transparent',
    'text.primary': '#1C1C1C',
    'text.secondary': '#444444',
    'text.tertiary': '#666666',
    'text.link': '#5C84C4',
    'text.destructive': '#B64A4A',
    'text.placeholder': '#777777',
    'text.disabled': '#8A8A8A',
    'state.active.background': 'rgba(92,132,196,0.08)',
    'state.active.border': 'rgba(92,132,196,0.24)',
    'state.active.foreground': '#5C84C4',
    'state.success.foreground': '#4E8B66',
    'state.success.background': 'rgba(78,139,102,0.10)',
    'state.success.border': 'rgba(78,139,102,0.22)',
    'state.warning.foreground': '#A88635',
    'state.warning.background': 'rgba(168,134,53,0.10)',
    'state.warning.border': 'rgba(168,134,53,0.22)',
    'state.danger.foreground': '#B64A4A',
    'state.danger.background': 'rgba(182,74,74,0.10)',
    'state.danger.border': 'rgba(182,74,74,0.22)',
    'state.info.foreground': '#5C84C4',
    'state.info.background': 'rgba(92,132,196,0.08)',
    'state.info.border': 'rgba(92,132,196,0.20)',
    'state.neutral.foreground': '#444444',
    'state.neutral.background': 'rgba(68,68,68,0.07)',
    'state.neutral.border': 'rgba(68,68,68,0.14)',
    'control.input.background': '#FFFFFF',
    'control.button.primary.background': '#F0F0EA',
    'control.button.primary.foreground': '#1C1C1C',
    'control.button.primary.disabled': '#E6E6DF',
    'control.fab.background': '#F0F0EA',
    'control.fab.backgroundPressed': '#D8D8D0',
    'control.fab.foreground': '#1C1C1C',
    'control.segmentedControl.trackBackground': '#F0F0EA',
    'control.segmentedControl.activeBackground': '#E6E6DF',
    'control.switch.track.active': '#5C84C4',
    'control.switch.track.inactive': '#D8D8D0',
    'control.switch.thumb.inactive': '#444444',
    'control.radio.active': '#5C84C4',
    'control.radio.inactive': '#666666',
    'control.permissionButton.allowAll.background': 'rgba(92,132,196,0.08)',
    'control.permissionButton.allowAll.foreground': '#5C84C4',
    'control.permissionButton.inactive.background': '#F0F0EA',
    'control.permissionButton.inactive.border': 'rgba(68,68,68,0.12)',
    'control.permissionButton.inactive.foreground': '#444444',
    'control.permissionButton.selected.background': '#E6E6DF',
    'control.permissionButton.selected.border': 'rgba(68,68,68,0.20)',
    'message.user.background': '#F0F0EA',
    'message.event.foreground': '#444444',
    'syntax.keyword': '#7A54B6',
    'syntax.string': '#4E8B66',
    'syntax.comment': '#777777',
    'syntax.number': '#A88635',
    'syntax.function': '#5C84C4',
    'overlay.scrim': 'rgba(28,28,28,0.34)',
};

const graphiteDarkSeed = {
    'background.canvas': '#121212',
    'surface.base': '#191919',
    'surface.inset': '#161616',
    'surface.elevated': '#222222',
    'surface.selected': '#2A2A2A',
    'surface.pressed': '#333333',
    'effect.surfaceHighlight': 'transparent',
    'text.primary': '#EAEAEA',
    'text.secondary': '#ACACAC',
    'text.tertiary': '#8E8E8E',
    'text.link': '#ACACAC',
    'text.destructive': '#C36A5A',
    'text.placeholder': '#8E8E8E',
    'text.disabled': '#767676',
    'state.active.background': 'rgba(172,172,172,0.08)',
    'state.active.border': 'rgba(172,172,172,0.18)',
    'state.active.foreground': '#EAEAEA',
    'state.success.foreground': '#9AA59A',
    'state.success.background': 'rgba(154,165,154,0.09)',
    'state.success.border': 'rgba(154,165,154,0.20)',
    'state.warning.foreground': '#C3A86A',
    'state.warning.background': 'rgba(195,168,106,0.09)',
    'state.warning.border': 'rgba(195,168,106,0.20)',
    'state.danger.foreground': '#C36A5A',
    'state.danger.background': 'rgba(195,106,90,0.09)',
    'state.danger.border': 'rgba(195,106,90,0.20)',
    'state.info.foreground': '#A8A8A8',
    'state.info.background': 'rgba(168,168,168,0.08)',
    'state.info.border': 'rgba(168,168,168,0.18)',
    'state.neutral.foreground': '#ACACAC',
    'state.neutral.background': 'rgba(172,172,172,0.06)',
    'state.neutral.border': 'rgba(172,172,172,0.12)',
    'control.input.background': '#191919',
    'control.button.primary.background': '#222222',
    'control.button.primary.foreground': '#EAEAEA',
    'control.button.primary.disabled': '#2A2A2A',
    'control.fab.background': '#222222',
    'control.fab.backgroundPressed': '#333333',
    'control.fab.foreground': '#EAEAEA',
    'control.segmentedControl.trackBackground': '#161616',
    'control.segmentedControl.activeBackground': '#2A2A2A',
    'control.switch.track.active': '#A8A8A8',
    'control.switch.track.inactive': '#333333',
    'control.switch.thumb.inactive': '#ACACAC',
    'control.radio.active': '#EAEAEA',
    'control.radio.inactive': '#8E8E8E',
    'control.permissionButton.allowAll.background': 'rgba(168,168,168,0.08)',
    'control.permissionButton.allowAll.foreground': '#A8A8A8',
    'control.permissionButton.inactive.background': '#161616',
    'control.permissionButton.inactive.border': 'rgba(255,255,255,0.055)',
    'control.permissionButton.inactive.foreground': '#ACACAC',
    'control.permissionButton.selected.background': '#2A2A2A',
    'control.permissionButton.selected.border': 'rgba(255,255,255,0.085)',
    'message.user.background': '#222222',
    'message.event.foreground': '#ACACAC',
    'syntax.keyword': '#A8A8A8',
    'syntax.string': '#B7B7B7',
    'syntax.comment': '#8E8E8E',
    'syntax.number': '#C3A86A',
    'syntax.function': '#A8A8A8',
    'overlay.scrim': 'rgba(18,18,18,0.74)',
};

const premiumDarkSeed = {
    'background.canvas': '#050506',
    'surface.base': '#141417',
    'surface.inset': '#0D0D10',
    'surface.elevated': '#1B1B20',
    'surface.selected': '#26262D',
    'surface.pressed': '#2D2D35',
    'border.surface': 'rgba(255,255,255,0.075)',
    'border.strong': 'rgba(255,255,255,0.13)',
    'effect.surfaceHighlight': 'transparent',
    'text.primary': '#ECECEF',
    'text.secondary': '#9A9AA3',
    'text.tertiary': '#6F6F78',
    'state.active.background': 'rgba(78,116,190,0.18)',
    'state.active.border': 'rgba(100,145,230,0.45)',
    'state.active.foreground': '#DDE8FF',
    'state.success.foreground': '#70D98A',
    'state.warning.foreground': '#E6B84A',
    'state.danger.foreground': '#E87878',
    'state.info.foreground': '#82A8FF',
    'control.input.background': '#17171C',
    'control.button.primary.background': '#24242B',
    'control.button.primary.foreground': '#ECECEF',
    'control.fab.background': '#24242B',
    'control.fab.foreground': '#ECECEF',
    'syntax.keyword': '#82A8FF',
};

const premiumLightSeed = {
    'background.canvas': '#F6F6F4',
    'surface.base': '#FFFFFF',
    'surface.inset': '#F2F2F0',
    'surface.elevated': '#FCFCFC',
    'border.surface': 'rgba(0,0,0,0.08)',
    'border.strong': 'rgba(0,0,0,0.14)',
    'effect.surfaceHighlight': 'transparent',
    'text.primary': '#111114',
    'text.secondary': '#5A5A5F',
    'text.tertiary': '#7A7A80',
    'state.active.background': 'rgba(10,132,255,0.08)',
    'state.active.border': 'rgba(10,132,255,0.40)',
    'state.active.foreground': '#111114',
    'state.success.foreground': '#248A3D',
    'state.warning.foreground': '#B26A00',
    'state.danger.foreground': '#D70015',
    'state.info.foreground': '#0A84FF',
};

const nightDarkSeed = {
    'background.canvas': '#020204',
    'surface.base': '#090A0E',
    'surface.inset': '#050609',
    'surface.elevated': '#101116',
    'surface.selected': '#141620',
    'surface.pressed': '#191C28',
    'border.surface': 'rgba(255,255,255,0.055)',
    'border.strong': 'rgba(255,255,255,0.095)',
    'effect.surfaceHighlight': 'rgba(255,255,255,0.028)',
    'text.primary': '#E4E3E8',
    'text.secondary': '#898892',
    'text.tertiary': '#5D5C66',
    'state.active.background': 'rgba(225,151,63,0.10)',
    'state.active.border': 'rgba(225,177,90,0.26)',
    'state.active.foreground': '#E8C46F',
    'control.input.background': '#0D0E14',
    'control.button.primary.background': '#141620',
    'control.fab.background': '#141620',
    'overlay.scrim': 'rgba(0,0,0,0.72)',
};

const pitchDarkSeed = {
    'background.canvas': '#090909',
    'surface.base': '#131313',
    'surface.inset': '#1B1B1B',
    'surface.elevated': '#202020',
    'surface.selected': '#1A1A1A',
    'surface.pressed': '#202020',
    'surface.pressedOverlay': 'rgba(255,255,255,0.035)',
    'surface.ripple': 'rgba(255,255,255,0.055)',
    'border.surface': 'rgba(255,255,255,0.05)',
    'border.strong': 'rgba(255,255,255,0.075)',
    'effect.surfaceHighlight': 'transparent',
    'chrome.header.background': '#131313',
    'chrome.header.foreground': '#E8E8E8',
    'text.primary': '#E8E8E8',
    'text.secondary': '#939393',
    'text.tertiary': '#6E6E6E',
    'text.link': '#70CFF8',
    'text.destructive': '#F98181',
    'text.placeholder': '#6A6A6A',
    'text.disabled': '#575757',
    'state.active.background': 'rgba(112,207,248,0.10)',
    'state.active.border': 'rgba(112,207,248,0.24)',
    'state.active.foreground': '#70CFF8',
    'state.success.foreground': '#B9F18D',
    'state.success.background': 'rgba(185,241,141,0.10)',
    'state.success.border': 'rgba(185,241,141,0.22)',
    'state.warning.foreground': '#FBBE88',
    'state.warning.background': 'rgba(251,190,136,0.10)',
    'state.warning.border': 'rgba(251,190,136,0.22)',
    'state.danger.foreground': '#F98181',
    'state.danger.background': 'rgba(249,129,129,0.10)',
    'state.danger.border': 'rgba(249,129,129,0.22)',
    'state.info.foreground': '#70CFF8',
    'state.info.background': 'rgba(112,207,248,0.08)',
    'state.info.border': 'rgba(112,207,248,0.20)',
    'control.input.background': '#131313',
    'control.button.primary.background': '#1B1B1B',
    'control.button.primary.foreground': '#E8E8E8',
    'control.button.primary.disabled': '#232323',
    'control.fab.background': '#1B1B1B',
    'control.fab.backgroundPressed': '#202020',
    'control.fab.foreground': '#E8E8E8',
    'control.segmentedControl.trackBackground': '#131313',
    'control.segmentedControl.activeBackground': '#1A1A1A',
    'control.switch.track.active': '#70CFF8',
    'control.switch.track.inactive': '#202020',
    'control.switch.thumb.inactive': '#939393',
    'control.radio.active': '#70CFF8',
    'control.radio.inactive': '#6E6E6E',
    'control.permissionButton.allowAll.background': 'rgba(112,207,248,0.14)',
    'control.permissionButton.allowAll.foreground': '#70CFF8',
    'control.permissionButton.inactive.background': '#131313',
    'control.permissionButton.inactive.border': 'rgba(255,255,255,0.05)',
    'control.permissionButton.inactive.foreground': '#939393',
    'control.permissionButton.selected.background': '#1A1A1A',
    'control.permissionButton.selected.border': 'rgba(255,255,255,0.075)',
    'message.user.background': '#1A1A1A',
    'message.event.foreground': '#939393',
    'syntax.keyword': '#70CFF8',
    'syntax.string': '#B9F18D',
    'syntax.comment': '#6E6E6E',
    'syntax.number': '#FBBE88',
    'syntax.function': '#C0A7FF',
    'overlay.scrim': 'rgba(9,9,9,0.74)',
};

describe('built-in theme profiles', () => {
    it('exposes curated themes as read-only cloneable presets with locked seed palettes', () => {
        expect(BUILT_IN_THEME_PROFILES.map((definition) => definition.presetId)).toEqual([
            'premiumDark',
            'pitchDark',
            'sunsetDark',
            'tokyoNight',
            'nightDark',
            'classicDark',
            'catppuccinMocha',
            'catppuccinMacchiato',
            'catppuccinFrappe',
            'oneDarkPro',
            'monokaiPro',
            'githubDark',
            'darkModern',
            'graphiteDark',
            'premiumLight',
            'paperLight',
            'catppuccinLatte',
            'githubLight',
        ]);
        expect(getBuiltInThemeProfileDefinition('premiumDark')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('premiumLight')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'light' });
        expect(getBuiltInThemeProfileDefinition('nightDark')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('sunsetDark')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('classicDark')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('catppuccinLatte')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'light' });
        expect(getBuiltInThemeProfileDefinition('catppuccinFrappe')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('catppuccinMacchiato')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('catppuccinMocha')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('oneDarkPro')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('monokaiPro')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('githubDark')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('githubLight')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'light' });
        expect(getBuiltInThemeProfileDefinition('darkModern')).toMatchObject({ cloneable: true, editable: false, deletable: false, preferredMode: 'dark' });
        expect(getBuiltInThemeProfileDefinition('premiumDark')?.profile.overrides.dark).toMatchObject(premiumDarkSeed);
        expect(Object.keys(getBuiltInThemeProfileDefinition('premiumDark')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(80);
        expect(BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === 'pitchDark')?.profile.overrides.dark).toMatchObject(pitchDarkSeed);
        expect(Object.keys(BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === 'pitchDark')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(20);
        expect(BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === 'sunsetDark')?.profile.overrides.dark).toMatchObject(sunsetDarkSeed);
        expect(Object.keys(BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === 'sunsetDark')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(20);
        expect(BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === 'classicDark')?.profile.overrides.dark).toMatchObject(classicDarkSeed);
        expect(Object.keys(BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === 'classicDark')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(50);
        expect(BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === 'tokyoNight')?.profile.overrides.dark).toMatchObject(tokyoNightSeed);
        expect(Object.keys(BUILT_IN_THEME_PROFILES.find((definition) => definition.presetId === 'tokyoNight')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(20);
        expect(getBuiltInThemeProfileDefinition('premiumLight')?.profile.overrides.light).toEqual(premiumLightSeed);
        expect(getBuiltInThemeProfileDefinition('nightDark')?.profile.overrides.dark).toMatchObject(nightDarkSeed);
        expect(Object.keys(getBuiltInThemeProfileDefinition('nightDark')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(80);
        expect(getBuiltInThemeProfileDefinition('nightDark')?.profile.overrides.dark['effect.surfaceHighlight']).toBe('rgba(255,255,255,0.028)');
        for (const presetId of importedDarkThemePresetIds) {
            expect(getBuiltInThemeProfileDefinition(presetId)?.profile.overrides.dark['effect.surfaceHighlight']).toBe('transparent');
        }
        expect(getBuiltInThemeProfileDefinition('catppuccinMocha')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#11111B',
            'surface.base': '#1E1E2E',
            'text.primary': '#CDD6F4',
            'text.secondary': '#BAC2DE',
            'state.active.foreground': '#89B4FA',
            'syntax.keyword': '#CBA6F7',
        });
        expect(getBuiltInThemeProfileDefinition('catppuccinLatte')?.profile.overrides.light).toMatchObject({
            'background.canvas': '#EFF1F5',
            'surface.base': '#FFFFFF',
            'text.primary': '#4C4F69',
            'text.secondary': '#5C5F77',
            'state.active.foreground': '#1E66F5',
            'syntax.keyword': '#8839EF',
        });
        expect(getBuiltInThemeProfileDefinition('paperLight')?.profile.overrides.light).toMatchObject(paperLightSeed);
        expect(Object.keys(getBuiltInThemeProfileDefinition('paperLight')?.profile.overrides.light ?? {}).length).toBeGreaterThan(20);
        expect(getBuiltInThemeProfileDefinition('oneDarkPro')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#21252B',
            'surface.base': '#282C34',
            'text.primary': '#ABB2BF',
            'state.active.foreground': '#61AFEF',
            'syntax.keyword': '#C678DD',
        });
        expect(getBuiltInThemeProfileDefinition('monokaiPro')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#221F22',
            'surface.base': '#2D2A2E',
            'text.primary': '#FCFCFA',
            'state.active.foreground': '#FFD866',
            'syntax.keyword': '#FF6188',
        });
        expect(getBuiltInThemeProfileDefinition('githubDark')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#0D1117',
            'surface.base': '#161B22',
            'text.primary': '#E6EDF3',
            'state.active.foreground': '#2F81F7',
            'syntax.keyword': '#FF7B72',
        });
        expect(getBuiltInThemeProfileDefinition('githubLight')?.profile.overrides.light).toMatchObject({
            'background.canvas': '#FFFFFF',
            'surface.base': '#F6F8FA',
            'text.primary': '#1F2328',
            'state.active.foreground': '#0969DA',
            'syntax.keyword': '#CF222E',
        });
        expect(getBuiltInThemeProfileDefinition('graphiteDark')?.profile.overrides.dark).toMatchObject(graphiteDarkSeed);
        expect(Object.keys(getBuiltInThemeProfileDefinition('graphiteDark')?.profile.overrides.dark ?? {}).length).toBeGreaterThan(20);
        expect(getBuiltInThemeProfileDefinition('darkModern')?.profile.overrides.dark).toMatchObject({
            'background.canvas': '#181818',
            'surface.base': '#1F1F1F',
            'text.primary': '#CCCCCC',
            'state.active.foreground': '#0078D4',
            'syntax.keyword': '#569CD6',
        });
    });

    it('clones a built-in profile into an editable flat custom profile', () => {
        const builtIn = getBuiltInThemeProfileDefinition('premiumDark')?.profile;
        if (!builtIn) throw new Error('missing premium dark');

        const clone = createThemeProfileDraft({ id: 'clone', name: 'My Crisp Dark', now: '2026-05-11T00:00:00.000Z', sourceProfile: builtIn });

        expect(clone.id).toBe('clone');
        expect(clone.overrides).toEqual(builtIn.overrides);
        expect(clone.overrides).not.toBe(builtIn.overrides);
    });

    it('resolves internal feed card surfaces from each built-in preset palette', () => {
        for (const definition of BUILT_IN_THEME_PROFILES) {
            const effective = resolveThemeProfile({
                mode: definition.preferredMode,
                profile: definition.profile,
            });

            expect(effective.colors.feed.card.background).toBe(effective.colors.surface.elevated);
        }
    });

    it('resets a token in a built-in clone back to canonical base, not the preset value', () => {
        const builtIn = getBuiltInThemeProfileDefinition('premiumDark')?.profile;
        if (!builtIn) throw new Error('missing premium dark');
        const clone = createThemeProfileDraft({ id: 'clone', name: 'My Crisp Dark', now: '2026-05-11T00:00:00.000Z', sourceProfile: builtIn });
        const reset = resetThemeProfileDraftToken(clone, 'dark', 'background.canvas', '2026-05-11T00:01:00.000Z');

        expect(resolveThemeProfile({ mode: 'dark', profile: reset }).colors.background.canvas).toBe('#131111');
    });
});
