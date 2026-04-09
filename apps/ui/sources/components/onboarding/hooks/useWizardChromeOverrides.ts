import * as React from 'react';
import { areReactNodesStructurallyEqual } from '@/utils/react/areReactNodesStructurallyEqual';

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

function areScopedPrimaryOverridesEquivalent(
    left: ScopedOverride<WizardPrimaryOverride> | null,
    right: ScopedOverride<WizardPrimaryOverride> | null,
): boolean {
    if (left == null || right == null) return left === right;
    return left.__stepId === right.__stepId
        && left.disabled === right.disabled
        && areReactNodesStructurallyEqual(left.label, right.label);
}

function areScopedBackOverridesEquivalent(
    left: ScopedOverride<WizardBackOverride> | null,
    right: ScopedOverride<WizardBackOverride> | null,
): boolean {
    if (left == null || right == null) return left === right;
    return left.__stepId === right.__stepId
        && left.hidden === right.hidden
        && areReactNodesStructurallyEqual(left.label ?? null, right.label ?? null);
}

function areScopedSkipOverridesEquivalent(
    left: ScopedOverride<WizardSkipOverride> | null,
    right: ScopedOverride<WizardSkipOverride> | null,
): boolean {
    if (left == null || right == null) return left === right;
    return left.__stepId === right.__stepId
        && left.hidden === right.hidden
        && left.disabled === right.disabled
        && areReactNodesStructurallyEqual(left.label ?? null, right.label ?? null);
}

function createScopedPrimaryOverride(
    stepId: WizardStepId,
    next: WizardPrimaryOverride | null,
    onPress: WizardPrimaryOverride['onPress'],
): ScopedOverride<WizardPrimaryOverride> | null {
    if (!next) return null;
    return {
        __stepId: stepId,
        label: next.label,
        disabled: next.disabled,
        onPress,
    };
}

function createScopedBackOverride(
    stepId: WizardStepId,
    next: WizardBackOverride | null,
    onPress: NonNullable<WizardBackOverride['onPress']>,
): ScopedOverride<WizardBackOverride> | null {
    if (!next) return null;
    return {
        __stepId: stepId,
        ...(typeof next.hidden === 'boolean' ? { hidden: next.hidden } : {}),
        ...(typeof next.label === 'undefined' ? {} : { label: next.label }),
        ...(typeof next.onPress === 'function' ? { onPress } : {}),
    };
}

function createScopedSkipOverride(
    stepId: WizardStepId,
    next: WizardSkipOverride | null,
    onPress: NonNullable<WizardSkipOverride['onPress']>,
): ScopedOverride<WizardSkipOverride> | null {
    if (!next) return null;
    return {
        __stepId: stepId,
        ...(typeof next.hidden === 'boolean' ? { hidden: next.hidden } : {}),
        ...(typeof next.label === 'undefined' ? {} : { label: next.label }),
        ...(typeof next.disabled === 'boolean' ? { disabled: next.disabled } : {}),
        ...(typeof next.onPress === 'function' ? { onPress } : {}),
    };
}

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
    const primaryOnPressRef = React.useRef<WizardPrimaryOverride['onPress'] | null>(null);
    const backOnPressRef = React.useRef<WizardBackOverride['onPress'] | null>(null);
    const skipOnPressRef = React.useRef<WizardSkipOverride['onPress'] | null>(null);

    const handlePrimaryPress = React.useCallback(() => {
        return primaryOnPressRef.current?.();
    }, []);

    const handleBackPress = React.useCallback(() => {
        return backOnPressRef.current?.();
    }, []);

    const handleSkipPress = React.useCallback(() => {
        return skipOnPressRef.current?.();
    }, []);

    React.useEffect(() => {
        if (!options?.resetOnStepChange) return;
        setPrimaryOverride((current) => {
            if (current && current.__stepId === stepId) return current;
            primaryOnPressRef.current = null;
            return null;
        });
        setBackOverride((current) => {
            if (current && current.__stepId === stepId) return current;
            backOnPressRef.current = null;
            return null;
        });
        setSkipOverride((current) => {
            if (current && current.__stepId === stepId) return current;
            skipOnPressRef.current = null;
            return null;
        });
    }, [options?.resetOnStepChange, stepId]);

    const activePrimaryOverride = primaryOverride?.__stepId === stepId ? primaryOverride : null;
    const activeBackOverride = backOverride?.__stepId === stepId ? backOverride : null;
    const activeSkipOverride = skipOverride?.__stepId === stepId ? skipOverride : null;

    const setWizardPrimaryOverride = React.useCallback((next: WizardPrimaryOverride | null) => {
        primaryOnPressRef.current = next?.onPress ?? null;
        const scopedNext = createScopedPrimaryOverride(stepId, next, handlePrimaryPress);
        setPrimaryOverride((current) => (
            areScopedPrimaryOverridesEquivalent(current, scopedNext)
                ? current
                : scopedNext
        ));
    }, [handlePrimaryPress, stepId]);
    const setWizardBackOverride = React.useCallback((next: WizardBackOverride | null) => {
        backOnPressRef.current = next?.onPress ?? null;
        const scopedNext = createScopedBackOverride(stepId, next, handleBackPress);
        setBackOverride((current) => (
            areScopedBackOverridesEquivalent(current, scopedNext)
                ? current
                : scopedNext
        ));
    }, [handleBackPress, stepId]);
    const setWizardSkipOverride = React.useCallback((next: WizardSkipOverride | null) => {
        skipOnPressRef.current = next?.onPress ?? null;
        const scopedNext = createScopedSkipOverride(stepId, next, handleSkipPress);
        setSkipOverride((current) => (
            areScopedSkipOverridesEquivalent(current, scopedNext)
                ? current
                : scopedNext
        ));
    }, [handleSkipPress, stepId]);

    return {
        activePrimaryOverride,
        activeBackOverride,
        activeSkipOverride,
        setWizardPrimaryOverride,
        setWizardBackOverride,
        setWizardSkipOverride,
    };
}
