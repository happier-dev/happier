import { describe, expect, it } from 'vitest';

import { DEFAULT_ACTIONS_SETTINGS_V1} from '@happier-dev/protocol/account/settings/accountSettings';
import { type ActionId } from '@happier-dev/protocol/actions/actionIds';

import * as actionSettingsTargets from './actionSettingsTargets';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { getActionTargetApprovalOverride } from './actionSettingsTargetApproval';
import { resolveActionApprovalLooseningNoticeData } from './resolveActionSettingsControlState';
import { applyActionPolicyMutation } from '@happier-dev/protocol/actions/actionAudiencePolicy';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol/plugins/actions/invocation';
import { isApprovalRequiredByActionsSettings, resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';

const resolveControlState = actionSettingsTargets.resolveActionSettingsTargetControlState;
const applyControlState = actionSettingsTargets.applyActionSettingsTargetControlState;

describe('resolveActionSettingsTargetControlState', () => {
    it.each(['ask_first', 'allowed'] as const)('retains explicit %s for input-dependent contributed confirmation', (value) => {
        const actionId = 'example.capabilities/actions/change';
        const target = actionSettingsTargets.listActionSettingsTargetDefinitions({
            surfaces: { ui: true }, placements: [], contributedAction: {
                dangerLevel: 'writesRemote', confirmationWhen: { op: 'truthy', path: 'publish' },
            },
        }).find(target => target.id === 'contextual_ui')!;
        const settings = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId,
            targetId: target.id, target, value });
        expect(getActionTargetApprovalOverride({ settings, actionId, targetId: target.id, target })).toBe(value === 'ask_first');
        expect(resolveControlState({ settings, actionId, targetId: target.id, target })).toMatchObject({ value });
        for (const publish of [true, false]) {
            const input = { publish };
            const declarationDefault = pluginActionRequiresPresentUserIntent(target.contributedAction!, 'ui', input, 'present_user');
            const routing = resolveActionApprovalRouting({ actionId: 'action.invoke', profileActionId: actionId,
                spec: getActionSpec('action.invoke'), settings, input,
                context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } },
                defaultConfirmation: declarationDefault, defaultUiConfirmation: declarationDefault });
            expect(routing.required || routing.uiConfirmationRequired === true).toBe(value === 'ask_first');
        }
    });
    it.each(['ask_first', 'allowed'] as const)('retains explicit %s for built-in input-dependent UI confirmation', (value) => {
        const actionId = 'usage.sources.consent.set';
        const targetId = 'contextual_ui';
        expect(resolveControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId }))
            .toMatchObject({ approvalAskedForInput: true });
        const settings = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId, value });
        expect(getActionTargetApprovalOverride({ settings, actionId, targetId })).toBe(value === 'ask_first');
    });
    it('reports irreversible UI confirmation and retains an explicit waiver', () => {
        const actionId = 'usage.sources.history.delete';
        const targetId = 'contextual_ui';
        expect(resolveControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId }))
            .toMatchObject({ approvalRequiredByPolicy: true });
        const settings = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId, value: 'allowed' });
        expect(getActionTargetApprovalOverride({ settings, actionId, targetId })).toBe(false);
        expect(resolveControlState({ settings, actionId, targetId })).toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false });
    });
    it('keeps a deliberate foreign HTML grant distinct from its refused default', () => {
        const actionId = 'session.message.send';
        const targetId = 'foreign_session_html' as const;
        expect(resolveControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId })).toMatchObject({ value: 'off' });
        const allowed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId, value: 'allowed' });
        expect(allowed.callerSurfacePolicies?.foreign_session_html?.[actionId]).toBe('allowed');
        expect(resolveControlState({ settings: allowed, actionId, targetId })).toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false });
        const reset = applyControlState({ settings: allowed, actionId, targetId, value: 'default' });
        expect(resolveControlState({ settings: reset, actionId, targetId })).toMatchObject({ value: 'off' });
    });
    // Owner decision 2026-11-12 (W7): Agent placement in a managed target asks by default and
    // the person can allow it from the existing Create session row.
    it.each(['agent', 'mcp'] as const)('lets the person explicitly allow %s managed-target placement on Create session', (targetId) => {
        const actionId = 'session.spawn_new';
        const placement = { managedTargetPlacement: { managedId: 'managed-1', workspaceRoot: '/workspace' } };
        expect(resolveControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId }))
            .toMatchObject({ value: 'default', approvalRequiredByPolicy: false, approvalAskedForInput: true });
        expect(isApprovalRequiredByActionsSettings(actionId, DEFAULT_ACTIONS_SETTINGS_V1, { surface: targetId },
            undefined, undefined, placement)).toBe(true);
        const allowed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId, value: 'allowed' });
        expect(resolveControlState({ settings: allowed, actionId, targetId })).toMatchObject({ value: 'allowed' });
        expect(isApprovalRequiredByActionsSettings(actionId, allowed, { surface: targetId },
            undefined, undefined, placement)).toBe(false);
        const reset = applyControlState({ settings: allowed, actionId, targetId, value: 'default' });
        expect(isApprovalRequiredByActionsSettings(actionId, reset, { surface: targetId },
            undefined, undefined, placement)).toBe(true);
        // The person's own app placement is not changed by this default.
        expect(resolveControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'cli' }))
            .not.toHaveProperty('approvalAskedForInput');
    });

    it('keeps an Allowed token-update waiver disclosed and restores only its CLI Ask preference', () => {
        const actionId = 'account.apiTokens.update';
        const sibling = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.stop', targetId: 'cli', value: 'off' });
        const allowed = applyControlState({ settings: sibling, actionId, targetId: 'cli', value: 'allowed' });
        const state = resolveControlState({ settings: allowed, actionId, targetId: 'cli' });
        expect(state).toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false, approvalWaivable: true,
            approvalLooseningNotice: { keepAskFirst: { actionId, audience: 'cli', mode: 'default' } } });
        if (state.kind !== 'approval' || !state.approvalLooseningNotice) throw new Error('Missing token permission warning');
        const spec = getActionSpec(actionId);
        for (const patch of [{ label: sealPrivateLabelV1({ mode: 'plain', binding: { entity: 'api_token', field: 'label', id: '550e8400-e29b-41d4-a716-446655440000' }, value: 'Renamed CI' }) }, { grant: API_TOKEN_FULL_GRANT_V1 }, { authorizeUnattendedTeamAccess: true }]) {
            const admittedInput = spec.inputSchema.parse({ tokenId: '550e8400-e29b-41d4-a716-446655440000', ...patch });
            expect(resolveActionApprovalLooseningNoticeData({ spec, admittedInput, actionId, audience: 'cli',
                mode: 'allowed', approvalRequiredByPolicy: state.approvalRequiredByPolicy, approvalWaivable: state.approvalWaivable,
                keepAskFirst: state.approvalLooseningNotice.keepAskFirst }))
                .toEqual(state.approvalLooseningNotice);
        }
        const reverted = applyActionPolicyMutation(allowed, state.approvalLooseningNotice.keepAskFirst).settings;
        expect(resolveControlState({ settings: reverted, actionId, targetId: 'cli' }))
            .toMatchObject({ approvalRequiredByPolicy: true });
        expect(resolveControlState({ settings: reverted, actionId, targetId: 'cli' }))
            .not.toHaveProperty('approvalLooseningNotice');
        expect(reverted.actions['session.stop']).toEqual(sibling.actions['session.stop']);
        expect(resolveControlState({ settings: reverted, actionId: 'session.stop', targetId: 'cli' }))
            .toMatchObject({ value: 'off' });
    });

    it.each([
        ['review.start', 'command_palette', 'allowed'], ['review.start', 'slash_command', 'ask_first'],
        ['machines.setup.adminAccess.set', 'agent', 'on'], ['machines.setup.adminAccess.set', 'agent', 'off'],
    ] as const)('refuses scoped %s/%s/%s instead of widening it into a global mutation', (actionId, targetId, value) => {
        expect(() => applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId, targetId, value,
            scope: { kind: 'machine', machineId: 'A' } })).toThrow();
    });

    it('consumes the admin Machine preference and shared exact-key warning/revert without changing global or sibling policy', () => {
        const actionId = 'machines.setup.adminAccess.set';
        const scope = { kind: 'machine', machineId: 'A' } as const;
        const sibling = { actionId, scope: { kind: 'machine', machineId: 'B' } as const,
            approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['agent'] };
        const otherAction = { ...sibling, actionId: 'session.stop', scope };
        const settings = normalizeActionsSettingsV1({ v: 1, actions: {}, scopedApprovalPreferences: [sibling, otherAction] });
        const params = { settings, actionId, targetId: 'agent', scope } as const;
        const allowed = applyControlState({ ...params, value: 'allowed' });
        expect(allowed.approvalWaivedSurfaces).toEqual(settings.approvalWaivedSurfaces);
        expect(allowed.scopedApprovalPreferences).toEqual([sibling, otherAction,
            { actionId, scope, approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['agent'] }]);
        const state = resolveControlState({ ...params, settings: allowed });
        // The setting above already asks, so Keep Ask first returns this Machine to it rather than pinning an override.
        expect(state).toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false, permissionChanging: true,
            approvalLooseningNotice: { keepAskFirst: { actionId, audience: 'agent', scope, mode: 'default' } } });
        if (state.kind !== 'approval' || !state.approvalLooseningNotice) throw new Error('Missing shared warning');
        const reverted = applyActionPolicyMutation(allowed, state.approvalLooseningNotice.keepAskFirst).settings;
        expect(resolveControlState({ ...params, settings: reverted })).toMatchObject({ approvalRequiredByPolicy: true });
        expect(resolveControlState({ ...params, settings: reverted })).not.toHaveProperty('approvalLooseningNotice');
        expect(reverted.scopedApprovalPreferences?.[0]).toBe(allowed.scopedApprovalPreferences?.[0]);
        expect(reverted.scopedApprovalPreferences?.[1]).toBe(allowed.scopedApprovalPreferences?.[1]);
        expect(reverted.actions).toEqual(settings.actions);
        expect(reverted.approvalWaivedSurfaces).toEqual(settings.approvalWaivedSurfaces);
    });

    it('shows the shared warning for globally Allowed admin access inherited by a Machine, while a Machine Ask override wins', () => {
        const actionId = 'machines.setup.adminAccess.set';
        const scope = { kind: 'machine', machineId: 'A' } as const;
        const settings = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'mcp', value: 'allowed' });
        const params = { settings, actionId, targetId: 'mcp', scope } as const;
        expect(resolveControlState(params)).toMatchObject({ value: 'default', approvalRequiredByPolicy: false,
            approvalLooseningNotice: { keepAskFirst: { actionId, audience: 'mcp', scope, mode: 'ask_first' } } });
        const required = applyControlState({ ...params, value: 'ask_first' });
        expect(resolveControlState({ ...params, settings: required })).toMatchObject({ value: 'ask_first', approvalRequiredByPolicy: true });
        expect(resolveControlState({ ...params, settings: required })).not.toHaveProperty('approvalLooseningNotice');
        expect(resolveControlState({ settings: required, actionId, targetId: 'mcp' })).toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false });
    });

    it.each([{ kind: 'machine', machineId: 'A' }, { kind: 'environment', environmentId: 'staging' }] as const)(
        'restores only the exact scoped preference from shared notice data (%j)', scope => {
            const actionId = 'machines.agentIsolation.set';
            const sibling = { actionId, scope: { kind: 'machine', machineId: 'B' } as const,
                approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['agent'] };
            const settings = normalizeActionsSettingsV1({ v: 1, actions: {}, scopedApprovalPreferences: [sibling,
                { actionId, scope, approvalRequiredSurfaces: [], approvalWaivedSurfaces: ['agent'] }] });
            const notice = resolveActionApprovalLooseningNoticeData({ spec: getActionSpec(actionId), actionId,
                audience: 'agent', scope, mode: 'allowed', approvalRequiredByPolicy: false, approvalWaivable: true });
            expect(notice?.keepAskFirst).toEqual({ actionId, audience: 'agent', scope, mode: 'ask_first' });
            if (!notice) throw new Error('missing permission-changing notice');
            const reverted = applyActionPolicyMutation(settings, notice.keepAskFirst).settings;
            expect(reverted.scopedApprovalPreferences).toEqual([sibling,
                { actionId, scope, approvalRequiredSurfaces: ['agent'], approvalWaivedSurfaces: [] }]);
            expect(reverted.actions).toEqual(settings.actions);
        });
    it('carries one permission-changing Allowed notice and exact audience revert to the real Settings control', () => {
        const actionId = 'machines.agentIsolation.set';
        const allowed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'agent', value: 'allowed' });
        expect(resolveControlState({ settings: allowed, actionId, targetId: 'agent' })).toMatchObject({
            permissionChanging: true, approvalLooseningNotice: {
                keepAskFirst: { actionId, audience: 'agent', mode: 'default' },
            },
        });
        expect(resolveControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'agent' }))
            .not.toHaveProperty('approvalLooseningNotice');
        const ordinary = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId: 'session.stop', targetId: 'agent', value: 'allowed' });
        expect(resolveControlState({ settings: ordinary, actionId: 'session.stop', targetId: 'agent' }))
            .not.toHaveProperty('approvalLooseningNotice');
    });
    it.each(['cli', 'agent', 'mcp'] as const)('restores default approval when Ask first is chosen again on %s', (targetId) => {
        const actionId = 'mcp.servers.signIn.start';
        const allowed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId, value: 'allowed' });
        expect(resolveControlState({ settings: allowed, actionId, targetId }))
            .toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false });

        const restored = applyControlState({ settings: allowed, actionId, targetId, value: 'ask_first' });
        expect(getActionTargetApprovalOverride({ settings: restored, actionId, targetId })).toBeNull();
        expect(resolveControlState({ settings: restored, actionId, targetId }))
            .toMatchObject({ value: 'default', approvalRequiredByPolicy: true });
    });

    it('restores a direct UI default while preserving other audience and Action preferences', () => {
        const actionId = 'mcp.servers.tools.set';
        const neighbour = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId: 'review.start', targetId: 'cli', value: 'off' });
        const cliAllowed = applyControlState({ settings: neighbour, actionId, targetId: 'cli', value: 'allowed' });
        const asking = applyControlState({ settings: cliAllowed, actionId, targetId: 'contextual_ui', value: 'ask_first' });
        expect(resolveControlState({ settings: asking, actionId, targetId: 'contextual_ui' }))
            .toMatchObject({ value: 'ask_first', approvalRequiredByPolicy: true });

        const restored = applyControlState({ settings: asking, actionId, targetId: 'contextual_ui', value: 'allowed' });
        expect(getActionTargetApprovalOverride({ settings: restored, actionId, targetId: 'contextual_ui' })).toBeNull();
        expect(resolveControlState({ settings: restored, actionId, targetId: 'contextual_ui' }))
            .toMatchObject({ value: 'default', approvalRequiredByPolicy: false });
        expect(restored.approvalWaivedSurfaces?.[actionId]).toEqual(['cli']);
        expect(restored.actions['review.start']).toEqual(neighbour.actions['review.start']);
    });

    it.each(['safe', 'writesLocal'] as const)('restores a contributed Action default from its %s declaration', (dangerLevel) => {
        const actionId = 'example.capabilities/actions/change';
        const target = actionSettingsTargets.listActionSettingsTargetDefinitions({
            surfaces: { cli: true }, placements: [], contributedAction: { dangerLevel },
        }).find(target => target.id === 'cli')!;
        const approvalRequired = false; // Safe and CLI-local edits both inherit Direct.
        const changed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'cli', target,
            value: approvalRequired ? 'allowed' : 'ask_first' });
        const restored = applyControlState({ settings: changed, actionId, targetId: 'cli', target,
            value: approvalRequired ? 'ask_first' : 'allowed' });
        expect(getActionTargetApprovalOverride({ settings: restored, actionId, targetId: 'cli', target })).toBeNull();
        expect(resolveControlState({ settings: restored, actionId, targetId: 'cli', target }))
            .toMatchObject({ value: 'default', approvalRequiredByPolicy: approvalRequired });
    });

    it('resolves approval-capable targets to the inherited default', () => {

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toEqual({
            kind: 'approval',
            value: 'default',
            approvalSurface: 'mcp',
            approvalRequiredByPolicy: false,
            approvalWaivable: true,
            approvalAskedBySourceControl: false,
        });
    });

    it('resolves approval-required surfaces to ask first', () => {
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        expect(resolveControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({
            kind: 'approval',
            value: 'ask_first',
        });
    });

    it('resolves opt-in placements to simple off and on states', () => {
        const enabledSettings = actionSettingsTargets.setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
            selected: true,
        });

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
        })).toEqual({
            kind: 'switch',
            value: 'off',
        });
        expect(resolveControlState({
            settings: enabledSettings,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
        })).toEqual({
            kind: 'switch',
            value: 'on',
        });
    });

    it('requires confirmation for a dangerous Agent Action by default', () => {

        // `prompt_doc.update` is the LIVE-1 fixture: danger + agent with no persisted override.
        const state = resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
        });

        // The tab stays on the inherited `default`; what the row must not do is
        // leave that default unstated, because on `agent` it really does confirm.
        expect(state).toEqual({
            kind: 'approval',
            value: 'default',
            approvalSurface: 'agent',
            approvalRequiredByPolicy: true,
            approvalWaivable: true,
            approvalAskedBySourceControl: false,
        });
    });

    it('inherits the declared direct UI assignment policy without retaining a redundant waiver', () => {

        // Assignment now declares direct UI admission at the canonical Action spec.
        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toEqual({
            kind: 'approval',
            value: 'default',
            approvalSurface: 'ui',
            approvalRequiredByPolicy: false,
            approvalWaivable: true,
            approvalAskedBySourceControl: false,
        });

        const waived = applyControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
            value: 'allowed',
        });

        expect(resolveControlState({
            settings: waived,
            actionId: 'session.responsibility.set',
            targetId: 'contextual_ui',
        })).toEqual({
            kind: 'approval',
            value: 'default',
            approvalSurface: 'ui',
            approvalRequiredByPolicy: false,
            approvalWaivable: true,
            approvalAskedBySourceControl: false,
        });
    });

    it('does not floor read-only agent actions or non-agent surfaces (CON-5)', () => {

        // Read-only agent verb: not floored.
        const readOnly = resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'browser.automation.snapshot' as ActionId,
            targetId: 'agent',
        });
        expect(readOnly).toMatchObject({ kind: 'approval', value: 'default' });
    });

    it('preserves a disabled floored agent target as stricter than ask_first (LIVE-1)', () => {
        const settings = actionSettingsTargets.setActionTargetSelected({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
            selected: false,
        });

        expect(resolveControlState({
            settings,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
        })).toEqual({
            kind: 'approval',
            value: 'off',
            approvalSurface: 'agent',
            approvalRequiredByPolicy: true,
            approvalWaivable: true,
            approvalAskedBySourceControl: false,
        });
    });

    it('persists an explicit dangerous Action waiver and restores the default', () => {

        const next = applyControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
            value: 'allowed',
        });
        const state = resolveControlState({
            settings: next,
            actionId: 'prompt_doc.update' as ActionId,
            targetId: 'agent',
        });
        expect(state).toMatchObject({ value: 'allowed' });
        expect(next.approvalWaivedSurfaces?.['prompt_doc.update']).toEqual(['agent']);
        const restored = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: next,
            actionId: 'prompt_doc.update',
            targetId: 'agent',
            approvalRequired: null,
        });
        expect(resolveControlState({ settings: restored, actionId: 'prompt_doc.update', targetId: 'agent' }))
            .toMatchObject({ value: 'default' });
    });

    it('restores inherited approval policy without disabling the surface', () => {
        const required = applyControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'ask_first',
        });

        const restored = applyControlState({
            settings: required,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'default',
        });

        expect(restored.actions['review.start']?.approvalRequiredSurfaces ?? []).toEqual([]);
        expect(restored.approvalWaivedSurfaces?.['review.start']).toBeUndefined();
        expect(resolveControlState({
            settings: restored,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({ kind: 'approval', value: 'default' });
    });

    it('does not expose approval controls for approval actions', () => {

        expect(resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'approval.request.create',
            targetId: 'mcp',
        })).toEqual({
            kind: 'switch',
            value: 'on',
        });
    });

    it('preserves target preferences while resolving a globally disabled action', () => {
        const settings = actionSettingsTargets.setActionEnabled({
            settings: actionSettingsTargets.setActionTargetApprovalRequired({
                settings: DEFAULT_ACTIONS_SETTINGS_V1,
                actionId: 'review.start',
                targetId: 'mcp',
                approvalRequired: true,
            }),
            actionId: 'review.start',
            enabled: false,
        });

        expect(resolveControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
        })).toMatchObject({
            kind: 'approval',
            value: 'ask_first',
        });
    });

    it('applies off by disabling the target and clearing matching approval state', () => {
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'off',
        });

        expect(next.actions['review.start']).toMatchObject({
            enabledPlacements: [],
            disabledSurfaces: ['mcp'],
            disabledPlacements: [],
            approvalRequiredSurfaces: [],
        });
    });

    it('applies allowed by enabling the target and clearing matching approval state', () => {
        const settings = actionSettingsTargets.setActionTargetSelected({
            settings: actionSettingsTargets.setActionTargetApprovalRequired({
                settings: DEFAULT_ACTIONS_SETTINGS_V1,
                actionId: 'review.start',
                targetId: 'mcp',
                approvalRequired: true,
            }),
            actionId: 'review.start',
            targetId: 'mcp',
            selected: false,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'mcp',
            value: 'allowed',
        });

        expect(next.actions['review.start']?.approvalRequiredSurfaces ?? []).toEqual([]);
        expect(next.approvalWaivedSurfaces?.['review.start']).toBeUndefined();
    });

    it('applies simple off without clearing unrelated approval surfaces', () => {
        const settings = actionSettingsTargets.setActionTargetApprovalRequired({
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            actionId: 'review.start',
            targetId: 'mcp',
            approvalRequired: true,
        });

        const next = applyControlState({
            settings,
            actionId: 'review.start',
            targetId: 'agent_input_chips',
            value: 'off',
        });

        expect(next.actions['review.start']).toEqual({
            enabledPlacements: [],
            disabledSurfaces: [],
            disabledPlacements: [],
            approvalRequiredSurfaces: ['mcp'],
            toolExposureModes: {},
        });
    });
    describe('Source Control remote confirmation preference', () => {
        it.each(['always', 'never'] as const)('keeps an explicit choice with the inherited %s preference and force-push consequence', (scmRemoteConfirmPolicy) => {
            const actionId = 'scm.remote.push';
            const value = scmRemoteConfirmPolicy === 'always' ? 'ask_first' : 'allowed';
            const opposite = value === 'ask_first' ? 'allowed' : 'ask_first';
            const changed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'contextual_ui', scmRemoteConfirmPolicy, value: opposite });
            const restored = applyControlState({ settings: changed, actionId, targetId: 'contextual_ui', scmRemoteConfirmPolicy, value });
            expect(getActionTargetApprovalOverride({ settings: restored, actionId, targetId: 'contextual_ui' })).toBe(value === 'ask_first');
            expect(resolveControlState({ settings: restored, actionId, targetId: 'contextual_ui', scmRemoteConfirmPolicy }))
                .toMatchObject({ value, approvalRequiredByPolicy: scmRemoteConfirmPolicy === 'always', approvalAskedForInput: true });
        });

        const remote = (actionId: 'scm.remote.pull' | 'scm.remote.push', scmRemoteConfirmPolicy: unknown) => resolveControlState({
            settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId, targetId: 'contextual_ui', scmRemoteConfirmPolicy,
        });

        it('reports the inherited default of pull and push as asking when the preference asks, and says why', () => {
            expect(remote('scm.remote.push', 'push_only')).toMatchObject({
                kind: 'approval', value: 'default', approvalRequiredByPolicy: true, approvalWaivable: true, approvalAskedBySourceControl: true,
            });
            expect(remote('scm.remote.pull', 'always')).toMatchObject({ approvalRequiredByPolicy: true, approvalAskedBySourceControl: true });
            // The preference is per operation: pushing is not affected by a pull-only preference.
            expect(remote('scm.remote.push', 'pull_only')).toMatchObject({ approvalRequiredByPolicy: false, approvalAskedBySourceControl: false });
            expect(remote('scm.remote.push', 'never')).toMatchObject({ approvalRequiredByPolicy: false, approvalAskedBySourceControl: false });
        });

        it('leaves an explicit choice in charge: Allowed does not ask, and Ask first is the Action policy rather than the preference', () => {
            const allowed = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId: 'scm.remote.push', targetId: 'contextual_ui', scmRemoteConfirmPolicy: 'always', value: 'allowed' });
            expect(resolveControlState({ settings: allowed, actionId: 'scm.remote.push', targetId: 'contextual_ui', scmRemoteConfirmPolicy: 'always' }))
                .toMatchObject({ value: 'allowed', approvalRequiredByPolicy: false, approvalAskedBySourceControl: false });
            const askFirst = applyControlState({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId: 'scm.remote.push', targetId: 'contextual_ui', scmRemoteConfirmPolicy: 'never', value: 'ask_first' });
            expect(resolveControlState({ settings: askFirst, actionId: 'scm.remote.push', targetId: 'contextual_ui', scmRemoteConfirmPolicy: 'always' }))
                .toMatchObject({ value: 'ask_first', approvalRequiredByPolicy: true, approvalAskedBySourceControl: false });
        });
    });
});
