import { describe, expect, it } from 'vitest';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { buildExecutableParticipantPickerOption } from '@/components/sessions/authoring/executableParticipantPicker';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import type { SessionAccessCandidateRowModel } from '@/components/sessions/access/sessionAccessEditorTypes';
import { buildDiscussionInviteCandidates, type DiscussionInviteCandidatesInput } from './discussionInviteCandidates';
import { createSessionAccessFixture } from '@/dev/testkit';

const scope = { serverId: 'home-a', accountId: 'owner' };
function person(accountId: string): SessionAccessCandidateRowModel {
    return { principal: presentSharePrincipal({ ref: { kind: 'account', accountId }, name: accountId }),
        addition: { kind: 'allowed' }, operation: { kind: 'idle' } };
}
function model(serverId = scope.serverId) {
    const option = buildExecutableParticipantPickerOption({
        selection: { kind: 'model', launch: { executionTarget: { serverId, machineId: 'machine-a' },
            directory: { kind: 'path', path: '/work' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } },
        label: 'Selected model', readiness: { configured: true, machine: { selectedMachineId: 'machine-a', machine: null },
            agent: null, selection: null, inventory: { status: 'idle', lastCheckedAt: null },
            invocation: null, mayRepairAgent: false },
    });
    if (!option) throw new Error('Invalid canonical model fixture');
    return option;
}

describe('Discussion Invite candidates', () => {
    it('preserves canonical title readability independently of the display label', () => {
        const input = { scope, people: [], modelOptions: [], sessions: [
            { address: { serverId: scope.serverId, sessionId: 'locked' }, label: 'Encrypted session', titleReadable: false,
                access: createSessionAccessFixture() },
            { address: { serverId: scope.serverId, sessionId: 'readable' }, label: 'Encrypted session', titleReadable: true,
                access: createSessionAccessFixture() },
        ] } satisfies DiscussionInviteCandidatesInput;
        const candidates = buildDiscussionInviteCandidates(input);
        expect(candidates).toMatchObject([
            { kind: 'session', titleReadable: false, label: 'Encrypted session' },
            { kind: 'session', titleReadable: true, label: 'Encrypted session' },
        ]);
        const repeated = buildDiscussionInviteCandidates({ ...input,
            sessions: input.sessions.map(row => ({ ...row, address: { ...row.address } })),
        }, candidates);
        expect(repeated).toBe(candidates);
        const reordered = buildDiscussionInviteCandidates({ ...input, sessions: [...input.sessions].reverse() }, candidates);
        expect(reordered[0]).toBe(candidates[1]);
        expect(reordered[1]).toBe(candidates[0]);
        const changed = buildDiscussionInviteCandidates({ ...input,
            sessions: input.sessions.map((row, index) => index === 0 ? { ...row, titleReadable: true } : row),
        }, candidates);
        expect(changed[0]).not.toBe(candidates[0]);
        expect(changed[0]).toMatchObject({ titleReadable: true });
        expect(changed[1]).toBe(candidates[1]);
    });

    it('deduplicates people and existing Agents against the Discussion roster, never the source Session grants', () => {
        const selected = model().value;
        if (selected.kind !== 'model') throw new Error('Expected model fixture');
        const roster = DiscussionParticipantsListResponseV1Schema.parse({ discussionId: 'd', ownerAccountId: 'owner', access: 'owner',
            grants: [{ principal: { kind: 'account', accountId: 'invited' }, accessLevel: 'edit', createdByAccountId: 'owner', createdAt: 1, display: { name: null } }],
            participants: [{ participant: { kind: 'session', sessionId: 'joined' }, answerPolicy: 'when_addressed', createdAt: 1 },
                { participant: { kind: 'model', participantSlotId: 'slot' }, launch: selected.launch,
                    sessionId: 'owned-session', answerPolicy: 'when_addressed', createdAt: 1 }],
        });
        const candidates = buildDiscussionInviteCandidates({ scope, roster,
            people: [person('owner'), person('invited'), person('new-person'), person('new-person')],
            sessions: [...['joined', 'owned-session', 'new-agent', 'new-agent'].map(sessionId => ({
                address: { serverId: scope.serverId, sessionId }, label: sessionId, titleReadable: true, access: createSessionAccessFixture() })),
                { address: { serverId: scope.serverId, sessionId: 'read-only' }, label: 'Read only', titleReadable: true, access: createSessionAccessFixture('view') },
                { address: { serverId: scope.serverId, sessionId: 'unobserved' }, label: null, titleReadable: false, access: null }],
            modelOptions: [],
        });
        expect(candidates.map(candidate => candidate.kind)).toEqual(['account', 'session']);
        expect(candidates[0]).toMatchObject({ participant: { kind: 'account', accountId: 'new-person' }, availability: { kind: 'allowed' } });
        expect(candidates[1]).toMatchObject({ selection: { kind: 'session', session: { serverId: 'home-a', sessionId: 'new-agent' } }, availability: { kind: 'existing_session' } });
    });

    it('preserves U4 setup/readiness and only offers executable choices from the captured Home', () => {
        const option = model();
        const candidates = buildDiscussionInviteCandidates({ scope, people: [],
            sessions: [{ address: { serverId: 'home-b', sessionId: 'same-id' }, label: 'Other Home', titleReadable: true, access: createSessionAccessFixture() },
                { address: { serverId: scope.serverId, sessionId: 'same-id' }, label: 'This Home', titleReadable: true, access: createSessionAccessFixture() }],
            modelOptions: [option, option, model('home-b')],
        });
        expect(candidates.map(candidate => candidate.kind)).toEqual(['session', 'model']);
        const selected = candidates.find(candidate => candidate.kind === 'model');
        expect(selected?.availability).toBe(option.readiness);
        expect(selected?.readiness).toBe(option.readiness);
        expect(selected?.repair).toBe(option.repair);
        expect(selected?.selection).toBe(option.value);
        expect(option.readiness.status).toBe('unknown');
        expect(new Set(candidates.map(candidate => candidate.key)).size).toBe(2);
    });
});
