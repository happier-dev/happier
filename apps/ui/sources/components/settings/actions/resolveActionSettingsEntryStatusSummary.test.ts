import { describe, expect, it } from 'vitest';
import {
    listActionSettingsEntryStatusParts,
    resolveActionSettingsEntryStatusSummary,
    type ActionSettingsEntryStatusTarget,
} from './resolveActionSettingsEntryStatusSummary';
import { normalizeActionsSettings } from './normalizeActionsSettings';
import { getActionSettingsTargetDefinition } from './actionSettingsTargets';
import { listActionSettingsTargetDefinitions } from './actionSettingsTargetDefinitions';

function target(
    id: ActionSettingsEntryStatusTarget['id'],
    state: ActionSettingsEntryStatusTarget['state'] = 'on',
    actionId: Parameters<typeof getActionSettingsTargetDefinition>[0] = 'review.start',
): ActionSettingsEntryStatusTarget {
    return {
        id,
        state,
        definition: getActionSettingsTargetDefinition(actionId, id),
    };
}

describe('resolveActionSettingsEntryStatusSummary', () => {
    it('describes effective approval by audience and declared danger, including an explicit integration waiver', () => {
        const actionId = 'acme.forge/actions/merge' as const;
        const definitions = listActionSettingsTargetDefinitions({
            surfaces: { ui: true, agent: true, mcp: true, api: true, plugin: true },
            placements: [],
            contributedAction: { dangerLevel: 'externalSideEffect' },
        });
        const settings = normalizeActionsSettings({ v: 1, actions: {}, approvalWaivedSurfaces: { [actionId]: ['plugin'] } });
        const summary = resolveActionSettingsEntryStatusSummary({ settings, actionId, targets: definitions.map((definition) => ({ id: definition.id, definition, state: 'on' })) });
        expect(summary).toMatchObject({
            audiences: [
                { audience: 'human', allowedCount: 0, askFirstCount: 1, offCount: 0 },
                { audience: 'agent', allowedCount: 0, askFirstCount: 1, offCount: 0 },
                { audience: 'integration', allowedCount: 1, askFirstCount: 2, offCount: 1, departed: true },
            ],
            danger: 'external',
        });
        expect(listActionSettingsEntryStatusParts(summary).map((part) => part.labelKey)).toEqual([
            // Only the audience set away from its defaults (the integration waiver) is named, once.
            'settingsActions.status.integrationAskFirst',
            'settingsActions.status.external',
        ]);
    });
    it('counts the in-app remote push as asking first when the Source Control preference asks, and as allowed when it does not', () => {
        const settings = normalizeActionsSettings({ v: 1, actions: {} });
        const targets = [target('contextual_ui', 'on', 'scm.remote.push')];
        const human = (scmRemoteConfirmPolicy: unknown) => resolveActionSettingsEntryStatusSummary({ settings, actionId: 'scm.remote.push', targets, scmRemoteConfirmPolicy })
            .audiences.find((audience) => audience.audience === 'human');
        expect(human('always')).toMatchObject({ askFirstCount: 1, allowedCount: 0 });
        expect(human('pull_only')).toMatchObject({ askFirstCount: 0, allowedCount: 1 });
    });
    it('counts allowed, ask-first, off, and unavailable target states from one action entry', () => {
        const settings = normalizeActionsSettings({
            v: 1,
            actions: {
                'review.start': {
                    enabledPlacements: [],
                    disabledPlacements: ['command_palette'],
                    disabledSurfaces: [],
                    approvalRequiredSurfaces: ['cli'],
                },
            },
        });

        expect(resolveActionSettingsEntryStatusSummary({
            settings,
            actionId: 'review.start',
            targets: [
                target('cli'),
                target('command_palette'),
                target('mcp', 'unavailable'),
            ],
        })).toMatchObject({
            allowedCount: 0,
            askFirstCount: 1,
            offCount: 1,
            unavailableCount: 1,
        });
    });

    it('counts an inherited default approval policy as enabled', () => {
        const settings = normalizeActionsSettings({ v: 1, actions: {} });

        expect(resolveActionSettingsEntryStatusSummary({
            settings,
            actionId: 'review.start',
            targets: [target('cli')],
        })).toMatchObject({
            allowedCount: 1,
            askFirstCount: 0,
            offCount: 0,
            unavailableCount: 0,
        });
    });

    /**
     * `session.responsibility.set` is a dangerous Action exposed on the in-app,
     * Agent, MCP and CLI surfaces. The present-user app edit is direct, while
     * automation surfaces retain confirmation; the summary reads that policy
     * answer rather than assuming every inherited default means allowed.
     */
    it('reports assignment as direct for the present user and ask-first for automation', () => {
        const settings = normalizeActionsSettings({ v: 1, actions: {} });

        expect(resolveActionSettingsEntryStatusSummary({
            settings,
            actionId: 'session.responsibility.set',
            targets: [
                target('contextual_ui', 'on', 'session.responsibility.set'),
                target('agent', 'on', 'session.responsibility.set'),
                target('mcp', 'on', 'session.responsibility.set'),
                target('cli', 'on', 'session.responsibility.set'),
            ],
        })).toMatchObject({
            allowedCount: 1,
            askFirstCount: 3,
            offCount: 0,
            unavailableCount: 0,
        });
    });

    it('omits unavailable targets from the user-facing compact status by default', () => {
        expect(listActionSettingsEntryStatusParts({
            allowedCount: 1,
            askFirstCount: 0,
            offCount: 1,
            unavailableCount: 6,
            audiences: [{ audience: 'integration', allowedCount: 1, askFirstCount: 0, offCount: 1, departed: true }],
            danger: null,
        })).toEqual([
            // A tie reads as the stricter state, once.
            { labelKey: 'settingsActions.status.integrationOff', partial: true },
        ]);
    });

    it('names each audience once per row, by the state most of its surfaces have', () => {
        expect(listActionSettingsEntryStatusParts({
            allowedCount: 3,
            askFirstCount: 2,
            offCount: 1,
            unavailableCount: 0,
            audiences: [
                { audience: 'agent', allowedCount: 0, askFirstCount: 1, offCount: 0, departed: true },
                { audience: 'integration', allowedCount: 3, askFirstCount: 1, offCount: 1, departed: true },
            ],
            danger: null,
        })).toEqual([
            { labelKey: 'settingsActions.status.agentAskFirst', partial: false },
            { labelKey: 'settingsActions.status.integrationAllowed', partial: true },
        ]);
    });
    it('says nothing about an audience left on its defaults', () => {
        expect(listActionSettingsEntryStatusParts({
            allowedCount: 1, askFirstCount: 1, offCount: 0, unavailableCount: 0,
            audiences: [
                { audience: 'human', allowedCount: 1, askFirstCount: 0, offCount: 0 },
                { audience: 'agent', allowedCount: 0, askFirstCount: 1, offCount: 0, departed: true },
            ],
            danger: null,
        })).toEqual([{ labelKey: 'settingsActions.status.agentAskFirst', partial: false }]);
    });
    it('does not count an opt-in placement left at its default (off) as a change', () => {
        const settings = normalizeActionsSettings({ v: 1, actions: {} });
        const summary = resolveActionSettingsEntryStatusSummary({
            settings, actionId: 'review.start', targets: [target('agent_input_chips', 'on', 'review.start')],
        });
        expect(summary.audiences.every((audience) => audience.departed !== true)).toBe(true);
        expect(listActionSettingsEntryStatusParts(summary)).toEqual([]);
    });
});
