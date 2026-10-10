import * as React from 'react';

import { previewThemeSelection, useApplyThemeSelection } from '@/components/settings/appearance/useApplyThemeSelection';
import { useHomeSetupDismissals } from '@/components/hub/layout/useHomeSetupDismissals';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { useAccountSettingsScope, useApplyLocalSettings, useApplySettings } from '@/sync/store/settingsWriters';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';

import { createPersonalizeFlowActions, type PersonalizeFlowPorts } from './personalizeFlowController';
import {
    PERSONALIZE_SETUP_ENTRY_ID,
    isPersonalizeStep,
    nextPersonalizePage,
    normalizePersonalizeProgress,
    previousPersonalizePage,
    readPersonalizeChoices,
    resolvePersonalizeResumePage,
    type PersonalizeChoices,
    type PersonalizePageId,
    type PersonalizeProgress,
    type StartingStyleId,
    type ThemeModeChoice,
} from './personalizeFlowModel';

/** The flow's actions bound to the real writers: Account and device settings, the theme owner, Home setup. */
export function usePersonalizeFlowActions(assertCurrent: () => void) {
    const applySettings = useApplySettings();
    const applyLocalSettings = useApplyLocalSettings();
    const applyThemeSelection = useApplyThemeSelection(assertCurrent);
    const { dismiss } = useHomeSetupDismissals();
    return React.useMemo(() => {
        const ports: PersonalizeFlowPorts = {
            readAccount: () => storage.getState().settings,
            readLocal: () => storage.getState().localSettings,
            writeAccount: (delta) => { assertCurrent(); applySettings(delta); },
            writeLocal: (delta) => { assertCurrent(); applyLocalSettings(delta); },
            applyTheme: (mode) => applyThemeSelection(mode, storage.getState().localSettings.themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE),
            readProgress: () => normalizePersonalizeProgress(storage.getState().localSettings.personalizeProgressV1),
            writeProgress: (progress) => {
                assertCurrent();
                applyLocalSettings({ personalizeProgressV1: { savedSteps: [...progress.savedSteps], resumeAt: progress.resumeAt } });
            },
            completeSetup: () => { assertCurrent(); dismiss(PERSONALIZE_SETUP_ENTRY_ID); },
        };
        return createPersonalizeFlowActions(ports);
    }, [applyLocalSettings, applySettings, applyThemeSelection, assertCurrent, dismiss]);
}

/** This device's visit memory for the Home card and the flow's resume page. */
export function usePersonalizeProgress(): PersonalizeProgress {
    const raw = useLocalSetting('personalizeProgressV1');
    return React.useMemo(() => normalizePersonalizeProgress(raw), [raw]);
}

export type PersonalizeFlowStatus = 'idle' | 'saving' | 'failed';

/**
 * One visit of the flow: the page on screen, the person's draft (pre-filled from current settings,
 * or from a starting style), and the save state of the current step. Next saves the step; Skip
 * keeps current values; Back revisits; Later closes with everything saved kept.
 */
export function usePersonalizeFlow(params: Readonly<{ initialPage?: PersonalizePageId; onExit: () => void }>) {
    const scope = useAccountSettingsScope();
    const [launchingScope] = React.useState(scope);
    const retired = React.useRef(false);
    const saving = React.useRef(false);
    const previewingTheme = React.useRef(false);
    const isCurrent = React.useCallback(() => {
        const current = storage.getState().settingsScope;
        return !retired.current && (current === launchingScope || areAccountSettingsScopesEqual(current, launchingScope));
    }, [launchingScope]);
    const assertCurrent = React.useCallback(() => {
        if (!isCurrent()) throw new Error('Personalize Account scope changed');
    }, [isCurrent]);
    const actions = usePersonalizeFlowActions(assertCurrent);
    const [page, setPage] = React.useState<PersonalizePageId>(() => params.initialPage
        ?? resolvePersonalizeResumePage(normalizePersonalizeProgress(storage.getState().localSettings.personalizeProgressV1)));
    // The values as the visit found them: the summary's "was", and Skip's "keep what you have".
    const [openedWith] = React.useState<PersonalizeChoices>(() => actions.readCurrentChoices());
    const [draft, setDraft] = React.useState<PersonalizeChoices>(openedWith);
    const [style, setStyle] = React.useState<StartingStyleId | 'keep'>('keep');
    const [status, setStatus] = React.useState<PersonalizeFlowStatus>('idle');
    const [direction, setDirection] = React.useState<'forward' | 'backward'>('forward');
    // A step reopened from the summary ("Change") returns to the summary once it is saved or skipped.
    const [returnToSummary, setReturnToSummary] = React.useState(false);
    const onExitRef = React.useRef(params.onExit);
    onExitRef.current = params.onExit;

    const restoreThemePreview = React.useCallback(() => {
        if (!previewingTheme.current) return;
        previewingTheme.current = false;
        const local = storage.getState().localSettings;
        previewThemeSelection(local.themePreference, local.themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE);
    }, []);
    React.useEffect(() => {
        if (isCurrent()) return;
        if (retired.current) return;
        retired.current = true;
        restoreThemePreview();
        onExitRef.current();
    }, [isCurrent, restoreThemePreview, scope]);
    React.useEffect(() => {
        retired.current = false;
        return () => {
            retired.current = true;
            restoreThemePreview();
        };
    }, [restoreThemePreview]);

    const goTo = React.useCallback((next: PersonalizePageId | null, towards: 'forward' | 'backward') => {
        setStatus('idle');
        if (!next) return;
        if (next === 'summary') setReturnToSummary(false);
        setDirection(towards);
        setPage(next);
    }, []);

    const update = React.useCallback((patch: Partial<PersonalizeChoices>) => {
        if (!isCurrent() || saving.current) return;
        setStatus('idle');
        setDraft((current) => ({ ...current, ...patch }));
    }, [isCurrent]);

    /** Runtime-only preview: the durable theme owner commits this choice on Next. */
    const selectTheme = React.useCallback((theme: ThemeModeChoice) => {
        if (!isCurrent() || saving.current) return;
        update({ theme });
        previewingTheme.current = true;
        previewThemeSelection(theme, storage.getState().localSettings.themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE);
    }, [isCurrent, update]);

    /** Next: saves the page's step and moves on. False when the save failed (the page stays). */
    const next = React.useCallback(async (): Promise<boolean> => {
        if (!isCurrent() || saving.current) return false;
        if (page === 'summary') {
            actions.complete();
            retired.current = true;
            restoreThemePreview();
            onExitRef.current();
            return true;
        }
        if (page === 'style') {
            setDraft((current) => actions.prefillStyle(current, style));
            actions.skipPage('style');
            goTo(nextPersonalizePage(page), 'forward');
            return true;
        }
        saving.current = true;
        setStatus('saving');
        const result = await actions.saveStep(page, draft);
        saving.current = false;
        if (!isCurrent()) return false;
        if (!result.ok) {
            setStatus('failed');
            return false;
        }
        if (page === 'look') restoreThemePreview();
        goTo(returnToSummary ? 'summary' : nextPersonalizePage(page), 'forward');
        return true;
    }, [actions, draft, goTo, isCurrent, page, restoreThemePreview, returnToSummary, style]);

    const skip = React.useCallback(() => {
        if (!isCurrent() || saving.current) return;
        if (isPersonalizeStep(page)) {
            // Skipping keeps the current values: the step's draft returns to what is saved.
            const current = readPersonalizeChoices(storage.getState().settings, storage.getState().localSettings);
            setDraft((existing) => ({ ...existing, ...pickStepChoices(page, current) }));
        }
        if (page === 'look') restoreThemePreview();
        actions.skipPage(page);
        goTo(returnToSummary ? 'summary' : nextPersonalizePage(page), 'forward');
    }, [actions, goTo, isCurrent, page, restoreThemePreview, returnToSummary]);

    const back = React.useCallback(() => {
        if (!isCurrent() || saving.current) return;
        goTo(previousPersonalizePage(page), 'backward');
    }, [goTo, isCurrent, page]);
    const open = React.useCallback((target: PersonalizePageId) => {
        if (!isCurrent() || saving.current) return;
        setReturnToSummary(page === 'summary');
        goTo(target, 'backward');
    }, [goTo, isCurrent, page]);

    const later = React.useCallback(() => {
        if (!isCurrent()) return;
        retired.current = true;
        restoreThemePreview();
        onExitRef.current();
    }, [isCurrent, restoreThemePreview]);

    return { page, draft, openedWith, style, setStyle, status, direction, update, selectTheme, next, skip, back, open, later };
}

export type PersonalizeFlow = ReturnType<typeof usePersonalizeFlow>;

const STEP_FIELDS = {
    look: ['theme', 'glass', 'glassSettings'],
    conversation: ['transcriptLayout', 'thinking'],
    tools: ['toolChrome', 'toolDetail', 'toolTap'],
    work: ['listLayout', 'listDensity'],
    attention: ['attention'],
    notifications: ['notifyNeedsYou', 'notifyFinished', 'notifyPreview'],
} as const satisfies Record<string, readonly (keyof PersonalizeChoices)[]>;

function pickStepChoices(step: keyof typeof STEP_FIELDS, choices: PersonalizeChoices): Partial<PersonalizeChoices> {
    return Object.fromEntries(STEP_FIELDS[step].map((field) => [field, choices[field]])) as Partial<PersonalizeChoices>;
}
