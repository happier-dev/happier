import type { WizardResumeState } from './wizardTypes';

export function serializeWizardResumeState(resumeState: WizardResumeState): string {
    return JSON.stringify(resumeState);
}

export function parseWizardResumeState(raw: string): WizardResumeState | null {
    const trimmed = String(raw ?? '').trim();
    if (!trimmed) return null;
    try {
        const parsed = JSON.parse(trimmed) as Partial<WizardResumeState>;
        if (!parsed || typeof parsed !== 'object') return null;
        if (typeof parsed.mode !== 'string') return null;
        if (typeof parsed.stepId !== 'string') return null;
        if (!parsed.relaySelection || typeof parsed.relaySelection !== 'object') return null;
        if (typeof parsed.authIntent !== 'string') return null;
        return parsed as WizardResumeState;
    } catch {
        return null;
    }
}
