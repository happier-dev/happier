import * as React from 'react';
import { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from '@/components/sessions/transcript/messageViewTestHelpers';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';
import { readPersonalizeChoices } from './personalizeFlowModel';
import { PersonalizeStage, buildPersonalizeListSample } from './PersonalizeStage';
import { SessionTranscriptSample, ThinkingDisplayPreview } from '@/components/settings/session/SessionSettingPreviews';

installMessageViewCommonModuleMocks({ storage: importOriginal => importOriginal() });
afterEach(standardCleanup);

describe('Personalize stage content geometry', () => {
    it.each(['none', 'transcript'] as const)('keeps the phone conversation inside its measured content when focus is %s and the card resizes', async (focus) => {
        const { storage } = await import('@/sync/domains/state/storage');
        const before = storage.getState();
        const choices = readPersonalizeChoices(settingsDefaults, localSettingsDefaults);
        const screen = await renderScreen(<PersonalizeStage testID="stage" draft={choices} presentation="card" focus={focus} />);
        // Native layout is the external boundary. These are card/content boxes,
        // not a second copy of the stage's padding or sidebar calculations.
        const boxes = focus === 'transcript'
            ? [[358, 288], [430, 360]] as const
            : [[358, 292], [430, 364]] as const;
        for (const [cardWidth, contentWidth] of boxes) {
            await act(async () => {
                screen.findHostByTestId('stage')!.props.onLayout?.({
                    nativeEvent: { layout: { x: 0, y: 0, width: cardWidth, height: 300 } },
                });
            });
            const sample = screen.findByType(SessionTranscriptSample);
            await act(async () => {
                sample.parent?.props.onLayout?.({
                    nativeEvent: { layout: { x: 0, y: 0, width: contentWidth, height: 220 } },
                });
            });
            // A full-size sample can inherit the native content box or receive
            // its measured width; an outer-card width clips the real user row.
            expect(screen.findByType(SessionTranscriptSample).props.width ?? contentWidth).toBe(contentWidth);
            expect(screen.getTextContent()).toContain('settingsSessionPages.preview.userMessage');
            expect(screen.getTextContent()).toContain('settingsSessionPages.preview.agentReply');
        }
        expect(storage.getState().settings).toBe(before.settings);
        expect(storage.getState().localSettings).toBe(before.localSettings);
    });
});

describe('Personalize thinking preview transitions', () => {
    it('switches Summary to Hidden and back without losing the remaining conversation', async () => {
        const choices = readPersonalizeChoices(settingsDefaults, localSettingsDefaults);
        const scene = (thinking: 'inline_summary' | 'hidden') => <>
            <PersonalizeStage draft={{ ...choices, thinking }} presentation="window" focus="transcript" />
            <ThinkingDisplayPreview mode={thinking} inlineChrome="plain" />
        </>;
        const screen = await renderScreen(scene('inline_summary'));
        const summary = screen.getTextContent();
        await screen.update(scene('hidden'));
        const hidden = screen.getTextContent();
        expect(hidden).toContain('settingsSessionPages.preview.userMessage');
        expect(hidden).toContain('settingsSessionPages.preview.agentReply');
        expect(hidden.length).toBeGreaterThan(0);
        expect(hidden.length).toBeLessThan(summary.length);
        await screen.update(scene('inline_summary'));
        expect(screen.getTextContent()).toBe(summary);
    });
});

describe('Personalize stage material', () => {
    it('paints the draft presets and exact Custom without changing Account settings', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const before = storage.getState();
        const custom = { ...glassPresetMaterials('everywhere', 'strong'), content: { blur: 'strong' as const, opacity: 0 } };
        const choices = readPersonalizeChoices({ ...settingsDefaults, glassBlurIntensity: 'strong', glassSurfaceMaterials: custom }, localSettingsDefaults);
        const painted: Array<Record<string, unknown>> = [];
        for (const glass of ['solid', 'auto', 'everywhere', 'custom'] as const) {
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
                <PersonalizeStage testID="stage" draft={{ ...choices, glass }} presentation="window" focus="none" />
            </GlassRuntimeEnvironmentProvider>);
            const scope = screen.findAllByType('View').find(node => {
                const style = StyleSheet.flatten(node.props.style);
                return style && '--happier-glass-content-opacity' in style;
            });
            expect(scope, `material scope for ${glass}`).toBeDefined();
            painted.push(StyleSheet.flatten(scope!.props.style));
            expect(screen.findHostByTestId('stage-sessions')).not.toBeNull();
            expect(StyleSheet.flatten(screen.findHostByTestId('stage-sessions')!.props.style).backgroundColor).toContain('--happier-glass-sidebar-opacity');
            standardCleanup();
        }
        expect(painted.map(style => style['--happier-glass-content-opacity'])).toEqual(['100%', '90%', '80%', '0%']);
        const sidebarOpacity = painted.map(style => Number.parseFloat(String(style['--happier-glass-sidebar-opacity'])));
        for (const [index, expected] of [100, 83.6, 80, 80].entries()) {
            expect(sidebarOpacity[index]).toBeCloseTo(expected);
        }
        expect(painted[3]['--happier-glass-content-blur']).toBe('16px');
        expect(storage.getState().settings).toBe(before.settings);
    });

    it('honors reduced transparency for draft Custom and browser Auto fallback', async () => {
        const choices = readPersonalizeChoices({ ...settingsDefaults, glassSurfaceMaterials: glassPresetMaterials('everywhere') }, localSettingsDefaults);
        for (const [glass, environment] of [['custom', { reduceTransparency: true }], ['auto', {}]] as const) {
            const screen = await renderScreen(<GlassRuntimeEnvironmentProvider value={environment}>
                <PersonalizeStage draft={{ ...choices, glass }} presentation="card" focus="sessions" />
            </GlassRuntimeEnvironmentProvider>);
            const scopes = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style));
            expect(scopes.find(style => style?.['--happier-glass-content-opacity'])?.['--happier-glass-content-opacity']).toBe('100%');
            standardCleanup();
        }
    });
});

describe('Personalize attention sample', () => {
    it('uses session facts and reason priority, independent of sample names', async () => {
        // A permission on the craft sample must outrank an action and a ready result;
        // the old review/pricing classifier excludes it solely because of its name.
        const groups = buildPersonalizeListSample('projects', 'global');
        expect(groups[0].rows.map(row => row.id)).toEqual(['personalize-craft', 'personalize-review', 'personalize-pricing']);
        const within = buildPersonalizeListSample('projects', 'withinGroups');
        expect(within[0].rows.map(row => row.id)).toEqual(['personalize-craft', 'personalize-review', 'personalize-reconnect']);
        const off = buildPersonalizeListSample('projects', 'off');
        expect(off[0].rows.map(row => row.id)).toEqual(['personalize-reconnect', 'personalize-craft', 'personalize-review']);
    });
});
