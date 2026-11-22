import { describe, expect, it, vi } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { deriveDiscussionFollowInputLocalIdV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

import { readAutonomousExchangeSourceRoot, readReceiverAutonomousExchangeRootInTx } from './readAutonomousExchangeSourceRoot';

describe('autonomous exchange source root', () => {
    it.each([
        { name: 'protected CLI original', accountId: 'actor', sessionId: 'source', bound: true, follow: false, found: true },
        { name: 'foreign Account target', accountId: 'foreign', sessionId: 'source', bound: true, follow: false, found: false },
        { name: 'foreign Session target', accountId: 'actor', sessionId: 'other', bound: true, follow: false, found: false },
        { name: 'missing target', accountId: 'actor', sessionId: 'source', bound: false, follow: false, found: false },
        { name: 'Follow carrier without inherited root', accountId: 'actor', sessionId: 'source', bound: true, follow: true, found: false },
    ])('resolves an accepted Machine-admitted original without source hydration: $name', async ({ accountId, sessionId, bound, follow, found }) => {
        // Database boundary: a settled original already carries its exact target receipt.
        const findUnique = vi.fn();
        const tx = { discussionMessage: { findUnique } } as unknown as Tx;
        const result = await readAutonomousExchangeSourceRoot({ tx,
            sourceSessionId: 'source', actorAccountId: 'actor', expectedTurnId: 'accepted-turn',
            sourceInputs: [{ localId: 'cli-original', acceptedTurnId: 'accepted-turn', targetExecutionRunId: null, turnStartWitnessId: null,
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine',
                    ...(follow ? { followRelations: [{ relation: 'follower' }] } : {}),
                    ...(bound ? { admittedTarget: { homeId: 'home', accountId, sessionId,
                        machineId: 'machine', installationId: 'installation' } } : {}) },
                autonomousExchangeRootSessionId: null, autonomousExchangeRootLocalId: null }],
        });
        expect(result).toEqual(found ? { status: 'found', root: { sessionId: 'source', localId: 'cli-original' } }
            : { status: 'unavailable' });
        expect(findUnique).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'person', producerV1: null, throughSeq: 2, accountId: 'actor', direct: true, found: true, reads: 1 },
        { name: 'ambient watcher', producerV1: null, throughSeq: 2, accountId: 'actor', direct: false, found: false, reads: 1 },
        { name: 'agent without inherited root', producerV1: { v: 1, kind: 'agent', sessionId: 'other' }, throughSeq: 2, accountId: 'actor', direct: true, found: false, reads: 1 },
        { name: 'workflow without inherited root', producerV1: { v: 1, kind: 'workflow' }, throughSeq: 2, accountId: 'actor', direct: true, found: false, reads: 1 },
        { name: 'different question cutoff', producerV1: null, throughSeq: 3, accountId: 'actor', direct: true, found: false, reads: 1 },
        { name: 'foreign receipt target', producerV1: null, throughSeq: 2, accountId: 'foreign', direct: true, found: false, reads: 0 },
    ])('resolves only a committed person Discussion original as a new root: $name', async ({ producerV1, throughSeq, accountId, direct, found, reads }) => {
        const addressing = { discussionId: 'discussion', messageId: 'question', throughSeq,
            participantSessionId: 'source' };
        const localId = deriveDiscussionFollowInputLocalIdV1(addressing);
        // Database boundary: only the exact committed question supplies authorship.
        const findUnique = vi.fn().mockResolvedValue({ discussionId: 'discussion', seq: 2, producerV1,
            addressingV1: { throughSeq: 2, participantSessionIds: ['source'],
                ...(direct ? {} : { watcherSessionIds: ['source'] }) } });
        const tx = { discussionMessage: { findUnique } } as unknown as Tx;
        const result = await readAutonomousExchangeSourceRoot({ tx, sourceSessionId: 'source', actorAccountId: 'actor', expectedTurnId: 'turn',
            sourceInputs: [{ localId, acceptedTurnId: 'turn', targetExecutionRunId: null, turnStartWitnessId: null,
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', discussionAddressing: addressing,
                    admittedTarget: { homeId: 'home', accountId, sessionId: 'source', machineId: 'machine', installationId: 'installation' } },
                autonomousExchangeRootSessionId: null, autonomousExchangeRootLocalId: null }] });
        expect(result).toEqual(found ? { status: 'found', root: { sessionId: 'source', localId } } : { status: 'unavailable' });
        expect(findUnique.mock.calls.length).toBeLessThanOrEqual(reads);
        if (found) expect(findUnique).toHaveBeenCalledOnce();
    });

    it('carries an inherited Discussion root without rereading its original question', async () => {
        const findUnique = vi.fn();
        const tx = { discussionMessage: { findUnique } } as unknown as Tx;
        const addressing = { discussionId: 'discussion', messageId: 'agent-question', throughSeq: 3,
            participantSessionId: 'source' };
        expect(await readAutonomousExchangeSourceRoot({ tx, sourceSessionId: 'source', actorAccountId: 'actor', expectedTurnId: 'turn',
            sourceInputs: [{ localId: deriveDiscussionFollowInputLocalIdV1(addressing), acceptedTurnId: 'turn', targetExecutionRunId: null, turnStartWitnessId: null,
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', discussionAddressing: addressing },
                autonomousExchangeRootSessionId: 'original-session', autonomousExchangeRootLocalId: 'original-input' }] }))
            .toEqual({ status: 'found', root: { sessionId: 'original-session', localId: 'original-input' } });
        expect(findUnique).not.toHaveBeenCalled();
    });

    it('never treats an Execution Run input as a Session Turn cause when their turn IDs collide', async () => {
        const tx = { discussionMessage: { findUnique: vi.fn() } } as unknown as Tx;
        expect(await readAutonomousExchangeSourceRoot({ tx,
            sourceSessionId: 'source', actorAccountId: 'actor', expectedTurnId: 'shared-turn-id',
            sourceInputs: [{ localId: 'run-input', acceptedTurnId: 'shared-turn-id',
                targetExecutionRunId: 'run-id', turnStartWitnessId: 'shared-turn-id', inputAdmissionReceipt: { v: 1,
                    issuer: 'authenticatedAccount', actorAccountId: 'actor', sessionRelationship: 'owner' },
                autonomousExchangeRootSessionId: null, autonomousExchangeRootLocalId: null }],
        })).toEqual({ status: 'unavailable' });
    });

    it.each([true, false])('selects only the receiver person root for Run wake, not a later inherited agent root (person: %s)', async hasPerson => {
        // Database boundary: the latest user-role row is an agent continuation,
        // followed by the older protected person input (or no person input).
        const findFirst = vi.fn().mockResolvedValueOnce({ seq: 2, localId: 'agent-input',
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
            autonomousExchangeRootSessionId: 'another-session', autonomousExchangeRootLocalId: 'foreign-root' })
            .mockResolvedValueOnce(hasPerson ? { seq: 1, localId: 'person-input',
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'receiver-account', sessionRelationship: 'owner' },
                autonomousExchangeRootSessionId: null, autonomousExchangeRootLocalId: null } : null);
        const tx = { sessionMessage: { findFirst } } as unknown as Tx;
        expect(await readReceiverAutonomousExchangeRootInTx(tx, { accountId: 'receiver-account', sessionId: 'receiver-session',
            selection: 'latest_person' })).toEqual(hasPerson ? { sessionId: 'receiver-session', localId: 'person-input' } : null);
    });
});
