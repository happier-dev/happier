import { describe, expect, it } from 'vitest';

import { applySettings, settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { applyLocalSettings, localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';

import { createPersonalizeFlowActions } from './personalizeFlowController';
import {
    EMPTY_PERSONALIZE_PROGRESS,
    readPersonalizeChoices,
    resolvePersonalizeCardProgress,
    resolvePersonalizeResumePage,
    type PersonalizeProgress,
} from './personalizeFlowModel';

/** Account, device and visit-memory storage are the persistence boundaries; the flow logic above them is real. */
function createHarness(options: Readonly<{ failAccountWrites?: boolean }> = {}) {
    let account: Settings = settingsDefaults;
    let local: LocalSettings = localSettingsDefaults;
    let progress: PersonalizeProgress = EMPTY_PERSONALIZE_PROGRESS;
    const completed: string[] = [];
    let failAccountWrites = options.failAccountWrites === true;
    const actions = createPersonalizeFlowActions({
        readAccount: () => account,
        readLocal: () => local,
        writeAccount: (delta) => {
            if (failAccountWrites) throw new Error('account_settings_scope_changed');
            account = applySettings(account, delta);
        },
        writeLocal: (delta) => { local = applyLocalSettings(local, delta); },
        applyTheme: (mode) => { local = applyLocalSettings(local, { themePreference: mode }); },
        readProgress: () => progress,
        writeProgress: (next) => { progress = next; },
        completeSetup: () => { completed.push('personalize'); },
    });
    return {
        actions,
        account: () => account,
        local: () => local,
        progress: () => progress,
        completed,
        setFailAccountWrites: (value: boolean) => { failAccountWrites = value; },
    };
}

describe('Personalize flow actions', () => {
    it('saves each step on Next through its writers and remembers where to resume', async () => {
        const flow = createHarness();
        const draft = readPersonalizeChoices(flow.account(), flow.local());

        expect(await flow.actions.saveStep('look', { ...draft, theme: 'dark', glass: 'everywhere' })).toEqual({ ok: true });
        expect(flow.local().themePreference).toBe('dark');
        expect(flow.account().glassBlurEnabled).toBe(true);
        expect(readPersonalizeChoices(flow.account(), flow.local()).glass).toBe('everywhere');

        flow.actions.skipPage('style');
        expect(await flow.actions.saveStep('conversation', { ...draft, transcriptLayout: 'linear' })).toEqual({ ok: true });
        expect(flow.account().transcriptGroupingMode).toBe('linear');
        expect(flow.progress()).toEqual({ savedSteps: ['look', 'conversation'], resumeAt: 'tools' });
    });

    it('keeps current values when a step is skipped', () => {
        const flow = createHarness();
        const before = flow.account();
        flow.actions.skipPage('tools');
        expect(flow.account()).toBe(before);
        expect(flow.progress()).toEqual({ savedSteps: [], resumeAt: 'work' });
    });

    it('stays on a step whose save fails, keeping the choice and every step already saved', async () => {
        const flow = createHarness();
        const draft = readPersonalizeChoices(flow.account(), flow.local());
        await flow.actions.saveStep('attention', { ...draft, attention: 'global' });
        flow.setFailAccountWrites(true);

        const result = await flow.actions.saveStep('work', { ...draft, listDensity: 'cozy' });
        expect(result.ok).toBe(false);
        expect(flow.account().sessionListDensity).toBe('narrow');
        expect(flow.account().sessionListAttentionPromotionModeV1).toBe('global');
        expect(flow.progress()).toEqual({ savedSteps: ['attention'], resumeAt: 'notifications' });

        // Try again succeeds with the same draft.
        flow.setFailAccountWrites(false);
        expect(await flow.actions.saveStep('work', { ...draft, listDensity: 'cozy' })).toEqual({ ok: true });
        expect(flow.account().sessionListDensity).toBe('cozy');
    });

    it('finishing later keeps saved choices, and reopening resumes with them pre-selected', async () => {
        const flow = createHarness();
        const draft = readPersonalizeChoices(flow.account(), flow.local());
        await flow.actions.saveStep('look', { ...draft, theme: 'light' });
        flow.actions.skipPage('style');
        await flow.actions.saveStep('conversation', { ...draft, thinking: 'hidden' });
        await flow.actions.saveStep('tools', { ...draft, toolChrome: 'cards' });
        // "Finish later": nothing else happens; the card reads the visit memory.

        expect(resolvePersonalizeResumePage(flow.progress())).toBe('work');
        expect(resolvePersonalizeCardProgress(flow.progress())).toEqual({ started: true, savedCount: 3, nextStep: 'work' });
        expect(flow.actions.readCurrentChoices()).toMatchObject({ theme: 'light', thinking: 'hidden', toolChrome: 'cards' });
        expect(flow.completed).toEqual([]);
    });

    it('a starting style only pre-fills the draft; nothing is written until each step\'s Next', () => {
        const flow = createHarness();
        const draft = flow.actions.readCurrentChoices();
        const prefilled = flow.actions.prefillStyle(draft, 'detail');
        expect(prefilled).toMatchObject({ transcriptLayout: 'linear', toolChrome: 'cards', listDensity: 'detailed' });
        expect(flow.actions.prefillStyle(draft, 'keep')).toBe(draft);
        expect(flow.account()).toBe(settingsDefaults);
    });

    it('"Use this setup" completes the Home card and clears the visit memory', async () => {
        const flow = createHarness();
        await flow.actions.saveStep('look', { ...flow.actions.readCurrentChoices(), theme: 'dark' });
        flow.actions.complete();
        expect(flow.completed).toEqual(['personalize']);
        expect(flow.progress()).toEqual(EMPTY_PERSONALIZE_PROGRESS);
        expect(flow.local().themePreference).toBe('dark');
    });
});
