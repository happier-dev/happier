import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
}));

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
        if (params && Object.keys(params).length > 0) {
            return `${key}:${JSON.stringify(params)}`;
        }
        return key;
    },
}));

const buildMemberTarget = (memberId: string): SessionParticipantTarget => ({
    key: `member-${memberId}`,
    displayLabel: `Member ${memberId}`,
    recipient: {
        kind: 'agent_team_member',
        teamId: 'team-1',
        memberId,
    } satisfies ParticipantRecipientV1,
});

const buildRunTarget = (runId: string): SessionParticipantTarget => ({
    key: `run-${runId}`,
    displayLabel: `Run ${runId}`,
    recipient: {
        kind: 'execution_run',
        runId,
    } satisfies ParticipantRecipientV1,
});

describe('createRecipientActionChip', () => {
    it('returns undefined when read-only', async () => {
        const { createRecipientActionChip } = await import('./createRecipientActionChip');

        const chip = createRecipientActionChip({
            isReadOnly: true,
            participantTargets: [buildMemberTarget('alpha')],
            recipient: null,
            onRecipientChange: () => {},
        });

        expect(chip).toBeUndefined();
    });

    it('returns undefined when there are no participant targets', async () => {
        const { createRecipientActionChip } = await import('./createRecipientActionChip');

        const chip = createRecipientActionChip({
            isReadOnly: false,
            participantTargets: [],
            recipient: null,
            onRecipientChange: () => {},
        });

        expect(chip).toBeUndefined();
    });

    it("publishes a 'list' presentation collapsedOptionsPopover with a rootStep section (no flat options)", async () => {
        const { createRecipientActionChip } = await import('./createRecipientActionChip');

        const chip = createRecipientActionChip({
            isReadOnly: false,
            participantTargets: [buildMemberTarget('alpha'), buildRunTarget('A1')],
            recipient: null,
            onRecipientChange: () => {},
        });

        expect(chip).toBeTruthy();
        const popover = chip!.collapsedOptionsPopover;
        expect(popover).toBeTruthy();
        expect(popover!.presentation).toBe('list');
        expect(popover!.rootStep).toBeTruthy();
        // The flat `options` field MUST be absent on a 'list' descriptor
        // (one-of invariant enforced by AgentInputCollapsedOptionsPopover).
        expect((popover as Record<string, unknown>).options).toBeUndefined();

        const sections = popover!.rootStep!.sections;
        expect(sections).toHaveLength(1);
        const section = sections[0];
        expect(section.kind).toBe('static');
        if (section.kind !== 'static') return;
        expect(section.options.map((option) => option.id)).toEqual(['lead', 'member-alpha', 'run-A1']);
    });

    it('exposes per-option onSelect callbacks that dispatch the resolved recipient (lead → null) so the action-menu overlay route fires the mutation', async () => {
        const { createRecipientActionChip } = await import('./createRecipientActionChip');

        const onRecipientChange = vi.fn();
        const targets = [buildMemberTarget('alpha'), buildRunTarget('A1')];

        const chip = createRecipientActionChip({
            isReadOnly: false,
            participantTargets: targets,
            recipient: null,
            onRecipientChange,
        });

        // The collapsed action-menu overlay (`AgentInputOverlayLayer`) does NOT
        // call descriptor-level `onSelect` for `presentation: 'list'` chips —
        // it relies on per-option callbacks. Each `SelectionListOption.onSelect`
        // MUST be present and dispatch the mutation.
        const section = chip!.collapsedOptionsPopover!.rootStep!.sections[0];
        if (section.kind !== 'static') throw new Error('expected static section');

        const leadOption = section.options.find((option) => option.id === 'lead');
        const runOption = section.options.find((option) => option.id === 'run-A1');
        expect(typeof leadOption?.onSelect).toBe('function');
        expect(typeof runOption?.onSelect).toBe('function');

        leadOption!.onSelect!();
        expect(onRecipientChange).toHaveBeenCalledWith(null);

        runOption!.onSelect!();
        expect(onRecipientChange).toHaveBeenCalledWith({
            kind: 'execution_run',
            runId: 'A1',
        });
    });

    it('descriptor-level onSelect is a documented close-only no-op (does NOT mutate recipient state)', async () => {
        const { createRecipientActionChip } = await import('./createRecipientActionChip');

        const onRecipientChange = vi.fn();
        const targets = [buildMemberTarget('alpha'), buildRunTarget('A1')];

        const chip = createRecipientActionChip({
            isReadOnly: false,
            participantTargets: targets,
            recipient: null,
            onRecipientChange,
        });

        // Calling the descriptor-level onSelect must NOT call onRecipientChange.
        // The overlay route calls only the per-option callbacks; the descriptor
        // callback is a no-op for parity with the picker contract.
        chip!.collapsedOptionsPopover!.onSelect('lead');
        chip!.collapsedOptionsPopover!.onSelect('run-A1');
        expect(onRecipientChange).not.toHaveBeenCalled();
    });

    it("reports the lead option as the selected option id when no recipient is set", async () => {
        const { createRecipientActionChip } = await import('./createRecipientActionChip');

        const chip = createRecipientActionChip({
            isReadOnly: false,
            participantTargets: [buildMemberTarget('alpha'), buildRunTarget('A1')],
            recipient: null,
            onRecipientChange: () => {},
        });

        expect(chip!.collapsedOptionsPopover!.selectedOptionId).toBe('lead');
    });
});
