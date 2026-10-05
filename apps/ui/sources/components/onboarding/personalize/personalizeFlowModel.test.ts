import { describe, expect, it } from 'vitest';

import { applySettings, settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { applyLocalSettings, localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { readGlassPreset } from '@/components/ui/glass/glassMaterial';

import {
    applyStartingStyle,
    listStartingStyleChanges,
    matchStartingStyle,
    nextPersonalizePage,
    previousPersonalizePage,
    readPersonalizeChoices,
    recordPersonalizePageSkipped,
    recordPersonalizeStepSaved,
    resolvePersonalizeCardProgress,
    resolvePersonalizeResumePage,
    resolvePersonalizeStepWrite,
    EMPTY_PERSONALIZE_PROGRESS,
} from './personalizeFlowModel';

const account: Settings = settingsDefaults;
const local = localSettingsDefaults;

describe('Personalize choices', () => {
    it('reads every step from the settings owners, with the shipped defaults', () => {
        expect(readPersonalizeChoices(account, local)).toEqual({
            theme: 'adaptive',
            glass: 'auto',
            glassSettings: {
                glassBlurEnabled: account.glassBlurEnabled,
                glassBlurIntensity: account.glassBlurIntensity,
                glassSurfaceMaterials: account.glassSurfaceMaterials,
            },
            transcriptLayout: 'turns',
            thinking: 'inline_summary',
            toolChrome: 'activity_feed',
            toolDetail: 'default',
            toolTap: 'expand',
            listLayout: 'projects',
            listDensity: 'narrow',
            attention: 'off',
            notifyNeedsYou: true,
            notifyFinished: true,
            notifyPreview: true,
        });
    });

    it('writes only what a step changed, through each owner', () => {
        const choices = readPersonalizeChoices(account, local);
        expect(resolvePersonalizeStepWrite('conversation', choices, account, local)).toEqual({ account: null, local: null, theme: null });

        expect(resolvePersonalizeStepWrite('conversation', { ...choices, transcriptLayout: 'linear', thinking: 'inline_full' }, account, local).account)
            .toEqual({ transcriptGroupingMode: 'linear', sessionThinkingDisplayMode: 'inline', sessionThinkingInlinePresentation: 'full' });
        expect(resolvePersonalizeStepWrite('work', { ...choices, listLayout: 'recent_activity', listDensity: 'cozy' }, account, local).account)
            .toEqual({ sessionListSectionModeV1: 'single', sessionListActiveGroupingV1: 'date', sessionListDensity: 'cozy' });
        expect(resolvePersonalizeStepWrite('attention', { ...choices, attention: 'withinGroups' }, account, local).account)
            .toEqual({ sessionListAttentionPromotionModeV1: 'withinGroups' });
        expect(resolvePersonalizeStepWrite('tools', { ...choices, toolChrome: 'cards', toolTap: 'open' }, account, local).account)
            .toEqual({ toolViewTimelineChromeMode: 'cards', toolViewTapAction: 'open' });

        const look = resolvePersonalizeStepWrite('look', { ...choices, theme: 'dark', glass: 'solid' }, account, local);
        expect(look.theme).toBe('dark');
        // The glass owner's own delta: reading it back gives the picked preset.
        expect(readGlassPreset(applySettings(account, look.account!))).toBe('solid');
    });

    it('keeps a custom glass table unless a preset is picked', () => {
        const custom = applySettings(account, { glassSurfaceMaterials: { chrome: { blur: 'strong', opacity: 0.1 }, sidebar: { blur: 'off', opacity: 1 }, content: { blur: 'off', opacity: 1 }, floating: { blur: 'off', opacity: 1 } } });
        const choices = readPersonalizeChoices(custom, local);
        expect(choices.glass).toBe('custom');
        expect(choices).toMatchObject({ glassSettings: { glassSurfaceMaterials: custom.glassSurfaceMaterials } });
        expect(resolvePersonalizeStepWrite('look', choices, custom, local).account).toBeNull();
    });

    it('writes this device\'s notifications as a whole and turns them on when an event is chosen', () => {
        const off = applyLocalSettings(local, { attentionDeviceOverridesV1: { ...local.attentionDeviceOverridesV1, localNotifications: { ...local.attentionDeviceOverridesV1.localNotifications, enabled: false } } });
        const choices = readPersonalizeChoices(account, off);
        expect(choices.notifyNeedsYou).toBe(false);
        expect(choices.notifyFinished).toBe(false);
        const write = resolvePersonalizeStepWrite('notifications', { ...choices, notifyNeedsYou: true, notifyFinished: false, notifyPreview: false }, account, off);
        expect(write.account).toBeNull();
        expect(write.local?.attentionDeviceOverridesV1?.localNotifications).toEqual({
            ...off.attentionDeviceOverridesV1.localNotifications,
            enabled: true,
            events: { ready: false, permission_request: true, user_action_request: true },
            previewBehavior: 'status_only',
            requestPreviewBehavior: 'status_only',
        });
    });
});

describe('Starting styles', () => {
    it('recognises Happier\'s default and Custom from the actual values', () => {
        const choices = readPersonalizeChoices(account, local);
        expect(matchStartingStyle(choices)).toBe('activity');
        expect(matchStartingStyle({ ...choices, listDensity: 'detailed' })).toBeNull();
    });

    it('pre-fills only the conversation, tools and work choices and lists exactly what changes', () => {
        const choices = { ...readPersonalizeChoices(account, local), theme: 'dark' as const, attention: 'global' as const, listDensity: 'cozy' as const };
        const detail = applyStartingStyle(choices, 'detail');
        expect(detail).toEqual({ ...choices, transcriptLayout: 'linear', thinking: 'inline_full', toolChrome: 'cards', toolDetail: 'full', listDensity: 'detailed' });
        expect(listStartingStyleChanges(choices, 'detail')).toEqual([
            { field: 'transcriptLayout', from: 'turns', to: 'linear' },
            { field: 'thinking', from: 'inline_summary', to: 'inline_full' },
            { field: 'toolChrome', from: 'activity_feed', to: 'cards' },
            { field: 'toolDetail', from: 'default', to: 'full' },
            { field: 'listDensity', from: 'cozy', to: 'detailed' },
        ]);
        expect(listStartingStyleChanges(detail, 'detail')).toEqual([]);
    });
});

describe('Personalize progress', () => {
    it('walks Look, the optional style, the six steps and the summary', () => {
        expect(nextPersonalizePage('look')).toBe('style');
        expect(nextPersonalizePage('style')).toBe('conversation');
        expect(nextPersonalizePage('notifications')).toBe('summary');
        expect(nextPersonalizePage('summary')).toBeNull();
        expect(previousPersonalizePage('look')).toBeNull();
        expect(previousPersonalizePage('conversation')).toBe('style');
    });

    it('saves per step, skips without saving, and resumes where the person left off', () => {
        const fresh = EMPTY_PERSONALIZE_PROGRESS;
        expect(resolvePersonalizeResumePage(fresh)).toBe('look');
        expect(resolvePersonalizeCardProgress(fresh)).toEqual({ started: false, savedCount: 0, nextStep: 'look' });

        const afterLook = recordPersonalizeStepSaved(fresh, 'look');
        const afterStyle = recordPersonalizePageSkipped(afterLook, 'style');
        const afterConversation = recordPersonalizeStepSaved(afterStyle, 'conversation');
        const afterTools = recordPersonalizePageSkipped(afterConversation, 'tools');
        expect(afterTools).toEqual({ savedSteps: ['look', 'conversation'], resumeAt: 'work' });
        expect(resolvePersonalizeResumePage(afterTools)).toBe('work');
        expect(resolvePersonalizeCardProgress(afterTools)).toEqual({ started: true, savedCount: 2, nextStep: 'work' });

        // Saving a step twice counts once; reopening at an earlier step keeps what was saved.
        expect(recordPersonalizeStepSaved(afterTools, 'look')).toEqual({ savedSteps: ['look', 'conversation'], resumeAt: 'style' });
    });

    it('resumes at the summary once the last step is behind the person', () => {
        const done = recordPersonalizePageSkipped({ savedSteps: ['look'], resumeAt: 'notifications' }, 'notifications');
        expect(resolvePersonalizeResumePage(done)).toBe('summary');
        expect(resolvePersonalizeCardProgress(done)).toEqual({ started: true, savedCount: 1, nextStep: null });
    });
});
