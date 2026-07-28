import { describe, expect, it } from 'vitest';

import {
    resolveAgentRequestKind,
    shouldShowGenericPermissionPromptForToolName,
} from './permissionPromptPolicy';

describe('permissionPromptPolicy AskUserQuestion aliases', () => {
    it.each(['AskUserQuestion', 'ask_user_question'] as const)('classifies %s as the same custom user action', (toolName) => {
        expect(resolveAgentRequestKind({ toolName })).toBe('user_action');
        expect(shouldShowGenericPermissionPromptForToolName(toolName)).toBe(false);
    });

    it('retains the other custom user-action tools without broadening ordinary permissions', () => {
        expect(resolveAgentRequestKind({ toolName: 'ExitPlanMode' })).toBe('user_action');
        expect(resolveAgentRequestKind({ toolName: 'Bash' })).toBe('permission');
    });
});
