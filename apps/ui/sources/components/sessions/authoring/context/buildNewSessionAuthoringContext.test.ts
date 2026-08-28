import { describe, expect, it } from 'vitest';

import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';
import type { NewSessionAutomationDraft } from '@/sync/domains/automations/automationDraft';

import { buildNewSessionAuthoringContext } from './buildNewSessionAuthoringContext';

const DISABLED: NewSessionAutomationDraft = { enabled: false, name: 'Paused recipe', description: '', triggers: [] };
const BASE_DRAFT = { targetType: 'new_session', automation: null } as SessionAuthoringDraft;

function build(params: Readonly<{
    draft: NewSessionAutomationDraft;
    requested?: boolean;
    supported?: boolean;
    machineActive?: boolean;
}>) {
    return buildNewSessionAuthoringContext({
        automationDraft: params.draft,
        automationFeatureEnabled: params.supported ?? true,
        automationRequestedByRoute: params.requested ?? false,
        selectedMachineId: 'machine-1',
        selectedMachine: { id: 'machine-1', active: params.machineActive ?? true, activeAt: Date.now() } as any,
        selectedPath: '/repo/project',
        buildDraft: (automation) => ({ ...BASE_DRAFT, automation }),
    });
}

describe('buildNewSessionAuthoringContext', () => {
    it('uses live launch for an ordinary disabled inline draft', () => {
        const context = build({ draft: DISABLED });
        expect(context.submissionMode).toBe('launch');
        expect(context.canSubmit).toBe(true);
    });

    it('preserves a disabled zero-trigger recipe when entered through the Automation route', () => {
        const context = build({ draft: DISABLED, requested: true, machineActive: false });
        expect(context.submissionMode).toBe('createAutomation');
        expect(context.submitAccessibilityLabelKey).toBe('automations.create.createButtonTitle');
        expect(context.canSubmit).toBe(true);
        expect(context.draft.automation).toEqual(DISABLED);
    });

    it('falls back to live launch gating when Automation support is unavailable', () => {
        const context = build({ draft: { ...DISABLED, enabled: true }, supported: false, machineActive: false });
        expect(context.submissionMode).toBe('launch');
        expect(context.showAutomationActionChips).toBe(false);
        expect(context.canSubmit).toBe(false);
    });
});
