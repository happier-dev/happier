import { describe, expect, it } from 'vitest';

import { AutomationApiError } from '../../sync/api/automations/apiAutomations';
import { formatAutomationError } from './automationErrorFormatting';
import { WorkflowActionError } from '@/sync/domains/workflows/workflowActionError';

describe('formatAutomationError', () => {
    it('maps typed API codes to safe user text and recovery action', () => {
        const result = formatAutomationError(
            new AutomationApiError({ code: 'sourceTurnNotCurrent', status: 409, message: 'secret server detail' }),
            'Fallback',
        );
        expect(result.action).toBe('Use current turn');
        expect(result.message).toBe(
            'The selected turn is no longer the active parent turn. Refresh and choose the current turn explicitly.',
        );
        expect(result.message).not.toContain('secret server detail');
    });

    it('does not expose unknown server messages', () => {
        expect(formatAutomationError(
            new AutomationApiError({ code: 'unknown', status: 500, message: 'internal secret' }),
            'Fallback',
        )).toEqual({ message: 'Fallback', action: 'Please try again' });
    });

    it('directs an uncertain manual admission to inspection instead of repeating the effect', () => {
        const result = formatAutomationError(new WorkflowActionError({ rawCode: 'workflow_outcome_unresolved', message: 'private server detail' }), 'Fallback');
        expect(result.action).toBe('Refresh');
        expect(result.message).not.toBe('Fallback');
        expect(result.message).not.toContain('private server detail');
    });
});
