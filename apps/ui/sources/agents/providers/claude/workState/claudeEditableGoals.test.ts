import { describe, expect, it } from 'vitest';

import { claudeGoalActionCapabilityProfile, claudeSupportsEditableGoals } from './claudeEditableGoals';

function metadataWithGoal(canEdit: boolean | undefined) {
    return {
        sessionWorkStateV1: {
            v: 1,
            backendId: 'claude',
            updatedAt: 10,
            primaryItemId: 'goal:claude',
            items: [
                {
                    id: 'goal:claude',
                    kind: 'goal',
                    origin: 'vendor',
                    status: 'active',
                    title: 'Ship goals',
                    updatedAt: 10,
                    ...(canEdit === undefined ? {} : { goalCapabilities: { canEdit } }),
                },
            ],
        },
    };
}

function metadataWithSlashCommands(commands: string[]) {
    return { slashCommands: commands };
}

describe('claudeSupportsEditableGoals', () => {
    it('is true for an active Claude session whose goal item advertises canEdit', () => {
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: {
                active: true,
                metadata: metadataWithGoal(true),
                agentState: { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: true } },
            },
        })).toBe(true);
    });

    it('fails closed for an active session when provider goal metadata outlives its runtime controls', () => {
        const session = { active: true, metadata: metadataWithGoal(true) };
        expect(claudeSupportsEditableGoals({ agentId: 'claude', session })).toBe(false);
        expect(claudeGoalActionCapabilityProfile({ agentId: 'claude', session })).toEqual({
            canEdit: false,
            canStop: false,
            canClear: false,
            canConfigureBudget: false,
        });
    });

    it('is true for a resumable (inactive) Claude session carrying an editable goal item', () => {
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: { active: false, metadata: metadataWithGoal(true) },
        })).toBe(true);
    });

    it('is false when the goal capability is absent', () => {
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: { active: true, metadata: metadataWithGoal(undefined) },
        })).toBe(false);
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: { active: true, metadata: metadataWithGoal(false) },
        })).toBe(false);
    });

    it('does not branch true for non-Claude agents', () => {
        expect(claudeSupportsEditableGoals({
            agentId: 'codex',
            session: { active: true, metadata: metadataWithGoal(true) },
        })).toBe(false);
        // even with `/goal` in slash commands, the gate is Claude-only
        expect(claudeSupportsEditableGoals({
            agentId: 'codex',
            session: { active: true, metadata: metadataWithSlashCommands(['goal']) },
        })).toBe(false);
    });

    it('is false when there is no goal capability signal at all', () => {
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: { active: true, metadata: null },
        })).toBe(false);
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: { active: true, metadata: metadataWithSlashCommands(['help', 'compact']) },
        })).toBe(false);
    });

    // Regression: the chip is the primary entry point for SETTING the first goal, so the
    // editable-goal gate must NOT require a pre-existing goal item. An active Claude session whose
    // runtime advertises the `/goal` slash command (system-init `slash_commands`, published to
    // `metadata.slashCommands` on every launcher path) is editable with no goal yet — mirroring the
    // Codex gate which derives editability from runtime identity, not from an existing goal.
    it('is true for an active Claude session that advertises the /goal command with no goal set yet', () => {
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: {
                active: true,
                metadata: metadataWithSlashCommands(['goal', 'help']),
                agentState: { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: true } },
            },
        })).toBe(true);
    });

    // G1: the slash-command shape parity is owned by the shared protocol normalizer, so BOTH the
    // bare `goal` and the slash-prefixed `/goal` shapes (and trimmed/cased variants) enable the chip.
    it('accepts the slash-prefixed /goal command shape (G1 parity)', () => {
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: {
                active: true,
                metadata: metadataWithSlashCommands(['/goal']),
                agentState: { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: true } },
            },
        })).toBe(true);
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: {
                active: true,
                metadata: metadataWithSlashCommands(['  /Goal ']),
                agentState: { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: true } },
            },
        })).toBe(true);
    });

    it('publishes set and clear independently from the controls registered by the active runtime', () => {
        const metadata = metadataWithSlashCommands(['/goal']);
        expect(claudeGoalActionCapabilityProfile({
            agentId: 'claude',
            session: {
                active: true,
                metadata,
                agentState: { capabilities: { sessionGoalSetSupported: true, sessionGoalClearSupported: false } },
            },
        })).toEqual({ canEdit: true, canStop: false, canClear: false, canConfigureBudget: false });
        expect(claudeGoalActionCapabilityProfile({
            agentId: 'claude',
            session: {
                active: true,
                metadata,
                agentState: { capabilities: { sessionGoalSetSupported: false, sessionGoalClearSupported: true } },
            },
        })).toEqual({ canEdit: false, canStop: false, canClear: true, canConfigureBudget: false });
    });

    it('requires an active session for the slash-command capability (inactive without a goal item is not editable)', () => {
        // The live `/goal` injection only works on an active session; an inactive session must seed
        // through the goal-item path (set-on-inactive → inject on resume), so slash-command-only
        // capability on an inactive session does not enable editing.
        expect(claudeSupportsEditableGoals({
            agentId: 'claude',
            session: { active: false, metadata: metadataWithSlashCommands(['goal']) },
        })).toBe(false);
    });
});
