import { describe, expect, it } from 'vitest';

import type { ActionId } from '@happier-dev/protocol';

import {
    isActionSettingsApprovalAction,
    resolveActionSettingsApprovalSurface,
} from './actionSettingsTargetApproval';

describe('actionSettingsTargetApproval', () => {
    it.each([
        ['review.start', 'mcp', 'mcp'],
        ['review.start', 'cli', 'cli'],
        ['review.start', 'agent', 'agent'],
        ['review.start', 'voice', 'voice'],
        ['review.start', 'slash_command', 'ui'],
        ['approval.request.decide', 'contextual_ui', 'ui'],
    ] as const)('maps %s target %s to approval surface %s', (actionId, targetId, expectedSurface) => {
        expect(resolveActionSettingsApprovalSurface(actionId, targetId)).toBe(expectedSurface);
    });

    it.each([
        ['review.start', 'command_palette'],
        ['review.start', 'session_action_menu'],
        ['review.start', 'voice_panel'],
    ] as const)('does not create approval state for ordinary placement %s:%s', (actionId, targetId) => {
        expect(resolveActionSettingsApprovalSurface(actionId, targetId)).toBeNull();
    });

    it('identifies approval actions so their targets can stay simple switches', () => {
        expect(isActionSettingsApprovalAction('approval.request.create' as ActionId)).toBe(true);
        expect(isActionSettingsApprovalAction('approval.request.decide' as ActionId)).toBe(true);
        expect(isActionSettingsApprovalAction('review.start' as ActionId)).toBe(false);
    });
});
