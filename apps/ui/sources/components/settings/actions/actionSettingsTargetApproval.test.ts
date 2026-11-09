import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1} from '@happier-dev/protocol/account/settings/accountSettings';
import { type ActionId } from '@happier-dev/protocol/actions/actionIds';

import {
    getActionTargetApprovalRequired,
    isActionSettingsApprovalAction,
    resolveActionSettingsApprovalSurface,
} from './actionSettingsTargetApproval';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import { listActionSettingsTargetDefinitions } from './actionSettingsTargetDefinitions';

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

/**
 * The settings screen must report the confirmation the runtime actually applies.
 * Every `ui` target here is an in-app surface the app's own Action executor admits
 * with `authority: 'present_user'` (`sync/api/session/sessionAccessApi.ts`). The
 * canonical policy admits reversible present-user assignment directly, while
 * retaining explicit Ask-first and the confirmation floor on automation surfaces.
 */
describe('getActionTargetApprovalRequired', () => {
    it('honors authored UI confirmation defaults in settings while retaining other surfaces and explicit Ask', () => {
        const actionId = 'qa.collection-detail/actions/set-complete' as const;
        const targets = listActionSettingsTargetDefinitions({
            surfaces: { ui: true, agent: true, mcp: true }, placements: [],
            contributedAction: { dangerLevel: 'writesLocal', confirmationWhen: { presentUserUi: false } },
        });
        for (const targetId of ['contextual_ui', 'agent', 'mcp'] as const) {
            const target = targets.find(entry => entry.id === targetId);
            expect(target).toBeDefined();
            expect(getActionTargetApprovalRequired({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId, target }))
                .toBe(targetId !== 'contextual_ui');
            expect(getActionTargetApprovalRequired({
                settings: normalizeActionsSettings({ v: 1, actions: { [actionId]: { approvalRequiredSurfaces: ['ui'] } } }),
                actionId, targetId, target,
            })).toBe(true);
        }
    });

    it('reports execution approval for a visible contributed placement without turning its visibility into an approval control', () => {
        const actionId = 'acme.forge/actions/delete' as const;
        const target = listActionSettingsTargetDefinitions({
            surfaces: { ui: true }, placements: ['command_palette'],
            contributedAction: { dangerLevel: 'destructive' },
        }).find((entry) => entry.id === 'command_palette')!;
        expect(resolveActionSettingsApprovalSurface(actionId, target.id, target)).toBeNull();
        expect(getActionTargetApprovalRequired({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: target.id, target })).toBe(true);
        expect(getActionTargetApprovalRequired({
            settings: normalizeActionsSettings({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['ui'] } }),
            actionId, targetId: target.id, target,
        })).toBe(false);
    });
    it('reports present-user assignment as direct by default, with or without a ui waiver', () => {
        expect(getActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toBe(false);
        expect(getActionTargetApprovalRequired({
            settings: normalizeActionsSettings({
                v: 1,
                actions: {},
                approvalWaivedSurfaces: { 'session.responsibility.set': ['ui'] },
            }),
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toBe(false);
    });

    it('reports an explicit require', () => {
        expect(getActionTargetApprovalRequired({
            settings: normalizeActionsSettings({
                v: 1,
                actions: { 'session.responsibility.set': { approvalRequiredSurfaces: ['ui'] } },
            }),
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toBe(true);
    });

    it.each(['agent', 'mcp', 'cli'] as const)('keeps the dangerous-Action floor on %s, which has no present user', (targetId) => {
        expect(getActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId,
        })).toBe(true);
    });

    it.each([
        'session.access.grant.set',
        'session.access.grant.remove',
        'session.access.context.set',
    ] as const)('reports %s the same way for the mounted Session access editor, with or without an explicit ui waiver', (actionId) => {
        expect(getActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId,
            targetId: 'contextual_ui',
        })).toBe(false);
        expect(getActionTargetApprovalRequired({
            settings: normalizeActionsSettings({
                v: 1,
                actions: {},
                approvalWaivedSurfaces: { [actionId]: ['ui'] },
            }),
            actionId,
            targetId: 'contextual_ui',
        })).toBe(false);
    });
});
