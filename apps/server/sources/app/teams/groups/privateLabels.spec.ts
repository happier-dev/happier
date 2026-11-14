import { describe, expect, it } from 'vitest';

import { signAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import {
    parsePrivateLabelStoredV1,
    serializePrivateLabelStoredV1,
} from '@happier-dev/protocol/crypto/privateLabelV1';
import tweetnacl from 'tweetnacl';

import type { ResourceRecipientAccountRow } from '@/app/encryption/savedSecretRecipientEnvelopeCensus';
import type { Tx } from '@/storage/inTx';

import {
    prepareTeamGroupNameForAutomatedWriteInTx,
    prepareTeamGroupNameForDirectoryInitialWriteInTx,
    projectTeamGroupNameForRecipient,
} from './privateLabels';

function recipient(id: string): ResourceRecipientAccountRow {
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    return {
        id,
        name: id,
        firstName: null,
        lastName: null,
        username: null,
        avatar: null,
        publicKey: Buffer.from(signing.publicKey).toString('hex'),
        encryptionMode: 'e2ee',
        contentPublicKey: new Uint8Array(content.publicKey),
        contentPublicKeySig: signAccountContentKeyBindingV1({
            accountSigningSecretKey: signing.secretKey,
            contentPublicKey: content.publicKey,
        }),
    };
}

function writeTx(params: Readonly<{
    author: ResourceRecipientAccountRow;
    member: ResourceRecipientAccountRow;
    includeAuthorInTeam: () => boolean;
}>): Tx {
    return {
        account: {
            findUnique: async () => ({ encryptionMode: 'e2ee' }),
            findMany: async () => [params.author, params.member],
        },
        teamMembership: {
            findMany: async () => [
                ...(params.includeAuthorInTeam() ? [{ accountId: params.author.id, role: 'member' }] : []),
                { accountId: params.member.id, role: 'member' },
            ],
        },
    } as unknown as Tx;
}

describe('Team Group private labels', () => {
    it('projects current envelopes and preserves raw historic names until normal save', () => {
        const stored = serializePrivateLabelStoredV1({
            content: { t: 'plain', v: 'Platform' },
            recipients: [],
        });

        expect(projectTeamGroupNameForRecipient({
            serialized: stored,
            recipientAccountId: 'account-1',
        })).toEqual({
            kind: 'available',
            label: { content: { t: 'plain', v: 'Platform' }, recipientEnvelope: null },
        });
        expect(projectTeamGroupNameForRecipient({
            serialized: 'Legacy plaintext must not escape',
            recipientAccountId: 'account-1',
        })).toEqual({ kind: 'available', label: { content: { t: 'plain', v: 'Legacy plaintext must not escape' }, recipientEnvelope: null, legacyPlaintext: true } });
    });

    it('reseals a directory rename to the current Team after the initial human author leaves', async () => {
        const author = recipient('author');
        const remainingMember = recipient('remaining-member');
        let authorIsStillAMember = true;
        const tx = writeTx({
            author,
            member: remainingMember,
            includeAuthorInTeam: () => authorIsStillAMember,
        });

        const initial = await prepareTeamGroupNameForDirectoryInitialWriteInTx({
            tx,
            authorAccountId: author.id,
            teamId: 'team-1',
            groupId: 'group-1',
            value: 'Initial directory name',
        });
        expect(initial).toMatchObject({ kind: 'ready' });
        if (initial.kind !== 'ready') return;
        expect(initial.serialized).not.toContain('Initial directory name');

        authorIsStillAMember = false;
        const renamed = await prepareTeamGroupNameForAutomatedWriteInTx({
            tx,
            teamId: 'team-1',
            groupId: 'group-1',
            currentSerialized: initial.serialized,
            nextValue: 'Renamed by directory',
        });
        expect(renamed).toMatchObject({ kind: 'ready' });
        if (renamed.kind !== 'ready') return;

        const parsed = parsePrivateLabelStoredV1(renamed.serialized);
        expect(parsed).toMatchObject({ kind: 'current', stored: { content: { t: 'encrypted' } } });
        if (parsed.kind !== 'current') return;
        expect(parsed.stored.recipients.map((row) => row.accountId)).toEqual([remainingMember.id]);
        expect(renamed.serialized).not.toContain('Renamed by directory');
        expect(projectTeamGroupNameForRecipient({
            serialized: renamed.serialized,
            recipientAccountId: author.id,
        })).toMatchObject({ kind: 'available', label: { recipientEnvelope: null } });
    });

    it('never downgrades an automated E2EE directory rename when a current Team recipient cannot receive a key', async () => {
        const author = recipient('author');
        const readyMember = recipient('ready-member');
        const initial = await prepareTeamGroupNameForDirectoryInitialWriteInTx({
            tx: writeTx({ author, member: readyMember, includeAuthorInTeam: () => true }),
            authorAccountId: author.id,
            teamId: 'team-1',
            groupId: 'group-1',
            value: 'Initial directory name',
        });
        expect(initial).toMatchObject({ kind: 'ready' });
        if (initial.kind !== 'ready') return;

        const memberAwaitingKey: ResourceRecipientAccountRow = {
            ...readyMember,
            contentPublicKey: null,
            contentPublicKeySig: null,
        };
        const renamed = await prepareTeamGroupNameForAutomatedWriteInTx({
            tx: writeTx({ author, member: memberAwaitingKey, includeAuthorInTeam: () => false }),
            teamId: 'team-1',
            groupId: 'group-1',
            currentSerialized: initial.serialized,
            nextValue: 'Provider-only rename must remain sealed',
        });

        // The source text has no server-readable fallback: it must wait for the
        // existing keyholding writer rather than persist a plain downgrade.
        expect(renamed).toEqual({ kind: 'recipient_unavailable' });
    });
});
