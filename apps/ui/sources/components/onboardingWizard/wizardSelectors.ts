import { getWizardStepDefinition, wizardStepRegistry } from './wizardStepRegistry';
import type { WizardContext, WizardStepId } from './wizardTypes';

export function getVisibleWizardStepIds(context: WizardContext): WizardStepId[] {
    return wizardStepRegistry
        .filter((step) => step.visibleWhen(context))
        .map((step) => step.id);
}

export function getWizardStepIndex(context: WizardContext, stepId: WizardStepId): number {
    return getVisibleWizardStepIds(context).indexOf(stepId);
}

export function isWizardStepVisible(context: WizardContext, stepId: WizardStepId): boolean {
    return getWizardStepIndex(context, stepId) >= 0;
}

export function canSkipWizardStep(context: WizardContext, stepId: WizardStepId): boolean {
    if (!isWizardStepVisible(context, stepId)) return false;
    return getWizardStepDefinition(stepId).canSkip;
}

export function getSelectedSetupAction(context: WizardContext): 'local' | 'remote' | 'tailscale' | null {
    return context.setupAction;
}

export function getNextWizardStepId(context: WizardContext, stepId: WizardStepId): WizardStepId | null {
    const visibleStepIds = getVisibleWizardStepIds(context);
    const currentIndex = visibleStepIds.indexOf(stepId);
    if (currentIndex < 0) return null;
    return visibleStepIds[currentIndex + 1] ?? null;
}

export function getPreviousWizardStepId(context: WizardContext, stepId: WizardStepId): WizardStepId | null {
    const visibleStepIds = getVisibleWizardStepIds(context);
    const currentIndex = visibleStepIds.indexOf(stepId);
    if (currentIndex <= 0) return null;
    return visibleStepIds[currentIndex - 1] ?? null;
}

export function getWizardProgress(context: WizardContext, stepId: WizardStepId): Readonly<{ current: number; total: number }> {
    const visibleStepIds = getVisibleWizardStepIds(context);
    const current = visibleStepIds.indexOf(stepId);
    return {
        current: current < 0 ? 0 : current + 1,
        total: visibleStepIds.length,
    };
}
