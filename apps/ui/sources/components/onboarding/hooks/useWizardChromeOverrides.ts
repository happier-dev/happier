import * as React from 'react';

import type { WizardStepId } from '../state/wizardTypes';

export type WizardPrimaryOverride = Readonly<{
    label: React.ReactNode;
    disabled: boolean;
    onPress: (() => void) | (() => Promise<void>);
}>;

export type WizardBackOverride = Readonly<{
    hidden?: boolean;
    label?: React.ReactNode;
    onPress?: () => void;
}>;

export type WizardSkipOverride = Readonly<{
    hidden?: boolean;
    label?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
}>;

type ScopedOverride<T> = Readonly<{ __stepId: WizardStepId }> & T;

type WizardChromeOverrides = Readonly<{
    activePrimaryOverride: WizardPrimaryOverride | null;
    activeBackOverride: WizardBackOverride | null;
    activeSkipOverride: WizardSkipOverride | null;
    setWizardPrimaryOverride: (next: WizardPrimaryOverride | null) => void;
    setWizardBackOverride: (next: WizardBackOverride | null) => void;
    setWizardSkipOverride: (next: WizardSkipOverride | null) => void;
}>;

export type UseWizardChromeOverridesOptions = Readonly<{
    /**
     * When true, overrides are cleared as soon as the wizard moves away from the step.
     * This matches the historical behavior of post-auth setup surfaces where overrides
     * are intended to be step-local and not resume when navigating back.
     */
    resetOnStepChange?: boolean;
}>;

export function useWizardChromeOverrides(stepId: WizardStepId, options?: UseWizardChromeOverridesOptions): WizardChromeOverrides {
    const [primaryOverride, setPrimaryOverride] = React.useState<ScopedOverride<WizardPrimaryOverride> | null>(null);
    const [backOverride, setBackOverride] = React.useState<ScopedOverride<WizardBackOverride> | null>(null);
    const [skipOverride, setSkipOverride] = React.useState<ScopedOverride<WizardSkipOverride> | null>(null);

    React.useEffect(() => {
        if (!options?.resetOnStepChange) return;
        setPrimaryOverride((current) => (current && current.__stepId === stepId ? current : null));
        setBackOverride((current) => (current && current.__stepId === stepId ? current : null));
        setSkipOverride((current) => (current && current.__stepId === stepId ? current : null));
    }, [options?.resetOnStepChange, stepId]);

    const activePrimaryOverride = primaryOverride?.__stepId === stepId ? primaryOverride : null;
    const activeBackOverride = backOverride?.__stepId === stepId ? backOverride : null;
    const activeSkipOverride = skipOverride?.__stepId === stepId ? skipOverride : null;

    const setWizardPrimaryOverride = React.useCallback((next: WizardPrimaryOverride | null) => {
        setPrimaryOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);
    const setWizardBackOverride = React.useCallback((next: WizardBackOverride | null) => {
        setBackOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);
    const setWizardSkipOverride = React.useCallback((next: WizardSkipOverride | null) => {
        setSkipOverride(next ? { __stepId: stepId, ...next } : null);
    }, [stepId]);

    return {
        activePrimaryOverride,
        activeBackOverride,
        activeSkipOverride,
        setWizardPrimaryOverride,
        setWizardBackOverride,
        setWizardSkipOverride,
    };
}
