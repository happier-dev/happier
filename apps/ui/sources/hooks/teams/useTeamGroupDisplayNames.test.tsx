import tweetnacl from 'tweetnacl';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { sealSavedSecretResourceRecipientEnvelopeV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup, teamGroupFixture } from '@/dev/testkit';
import { createPrivateLabelClient } from '@/sync/ops/privateLabels/privateLabelClient';
import { teamGroupNameBinding } from '@/sync/ops/teams/teamGroupLabels';
import { useTeamGroupDisplayNames } from './useTeamGroupDisplayNames';

// Resolve the real Account capture graph before the lifecycle case starts.
await import('@/sync/ops/actions/actionAccountContext');

const dataKey = new Uint8Array(32).fill(17);
const randomBytes = (length: number) => new Uint8Array(length).fill(23);
const recipientEnvelope = sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: dataKey,
    recipientContentPublicKey: tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(19)).publicKey,
    randomBytes,
});
const sealedLabel = sealPrivateLabelV1({ mode: 'e2ee', binding: teamGroupNameBinding('group-retired'),
    value: 'Private Group', dataKey, recipients: [{ accountId: 'viewer', envelope: recipientEnvelope }], randomBytes,
});
const encryptedLabel = { content: sealedLabel.content, recipientEnvelope };

describe('useTeamGroupDisplayNames', () => {
    afterEach(standardCleanup);

    it('keeps every loaded Group structural row when a recipient envelope is unavailable', async () => {
        const groups = [
            teamGroupFixture({ id: 'group-unavailable', name: { kind: 'available', label: {
                ...encryptedLabel, recipientEnvelope: null,
            } } }),
            teamGroupFixture({ id: 'group-visible', name: 'Visible Group' }),
        ];
        const hook = await renderHook(() => useTeamGroupDisplayNames({
            scope: { serverId: 'server-1', accountId: 'account-1' }, groups,
        }));

        await vi.waitFor(() => expect([...hook.getCurrent()]).toEqual([
            ['group-unavailable', null], ['group-visible', 'Visible Group'],
        ]));
    });

    it('opens a plain Team Group label without requiring viewer Account encryption material', async () => {
        const groups = [teamGroupFixture({ id: 'group-visible', name: 'Visible Group' })];
        const hook = await renderHook(() => useTeamGroupDisplayNames({
            scope: { serverId: 'absent-viewer-home', accountId: 'e2ee-viewer' }, groups,
        }));

        await vi.waitFor(() => expect([...hook.getCurrent()]).toEqual([['group-visible', 'Visible Group']]));
    });

    it('does not publish sibling names after losing the Home lifecycle', async () => {
        const scope = { serverId: 'missing-group-label-home', accountId: 'viewer' };
        // Prove this is the real lifecycle refusal before exercising the hook's batch withdrawal.
        await expect(createPrivateLabelClient(scope).open({ binding: teamGroupNameBinding('group-retired'),
            label: encryptedLabel, readPolicy: { kind: 'team-resource' },
        })).rejects.toThrow('action_home_not_found');
        const first = [teamGroupFixture({ id: 'group-visible', name: 'First Group' })];
        const second = [
            teamGroupFixture({ id: 'group-retired', name: { kind: 'available', label: encryptedLabel } }),
            teamGroupFixture({ id: 'group-visible', name: 'Second Group' }),
        ];
        const hook = await renderHook(({ groups }) => useTeamGroupDisplayNames({ scope, groups }), {
            initialProps: { groups: first },
        });
        await vi.waitFor(() => expect([...hook.getCurrent()]).toEqual([['group-visible', 'First Group']]));
        await hook.rerender({ groups: second });
        await flushHookEffects();
        await vi.waitFor(() => expect([...hook.getCurrent()]).toEqual([
            ['group-retired', null], ['group-visible', null],
        ]));
    });
});
