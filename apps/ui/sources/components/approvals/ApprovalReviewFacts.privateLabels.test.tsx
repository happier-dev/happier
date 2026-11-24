import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { teamGroupLabelBinding } from '@happier-dev/protocol/teams/groupLabel';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(standardCleanup);

const targetId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
const teamId = 'research-team';
const accountId = 'label-author';
const name = 'Evening builders';
const description = 'Hosts available after six';

const cases = (['machines.pools.create', 'machines.pools.update', 'teams.groups.create'] as const).flatMap(actionId =>
    (['key', 'no key', 'plain'] as const).map(access => ({ actionId, access })));

it.each(cases)('reads pending $actionId private labels with $access', async ({ actionId, access }) => {
    const token = createAccountTokenForTests(accountId);
    const credentials = { token, secret: encodeBase64(new Uint8Array(32).fill(7), 'base64url') };
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://private-label-review.test', accountId,
        credentials: access === 'key' ? credentials : { token },
        accountEncryptionMode: access === 'plain' ? 'plain' : 'e2ee' });
    const encryption = access === 'plain' ? null : await createEncryptionFromAuthCredentials(credentials);
    const dataKey = new Uint8Array(32).fill(27);
    const envelope = encryption && {
        encryptedDataKey: encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64'),
        recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey),
    };
    function seal(field: 'name' | 'description', value: string) {
        const binding = actionId === 'teams.groups.create' ? teamGroupLabelBinding(targetId, field)
            : { entity: 'machine_pool' as const, id: targetId, field };
        return envelope ? sealPrivateLabelV1({ mode: 'e2ee', binding, value, dataKey,
            recipients: [{ accountId, envelope }], randomBytes: length => new Uint8Array(length).fill(19) })
            : sealPrivateLabelV1({ mode: 'plain', binding, value });
    }
    const sealedName = seal('name', name);
    const sealedDescription = seal('description', description);
    const spec = getActionSpec(actionId);
    if (actionId === 'machines.pools.update') {
        // The update omits its audience. The existing authorized Pool read supplies the retained Team.
        harness.answer(serverId, 'POST /v1/machines/pools/get', {
            body: { pool: { id: targetId, name: { kind: 'unavailable' }, description: null, audience: { kind: 'team', teamId },
                revision: 1, createdAt: 1, updatedAt: 1, members: [] }, availability: { state: 'unknown' } },
        });
    }
    const targets = actionId === 'teams.groups.create'
        ? { v: 1, teamId, groupId: targetId, requestKey: 'create-evening-group' }
        : { poolId: targetId, members: [], ...(actionId === 'machines.pools.update' ? { expectedRevision: 1 } : {}) };
    const actionArgs = spec.inputSchema.parse({ ...targets, name: sealedName, description: sealedDescription });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="private-label-review" />);
    try {
        await vi.waitFor(() => {
            const nameTitle = actionId === 'teams.groups.create' ? 'Group name ' : 'Name ';
            expect(screen.getTextContent()).toContain(nameTitle + (access === 'no key' ? t('common.unavailable') : name));
            expect(screen.getTextContent()).toContain('Description ' + (access === 'no key' ? t('common.unavailable') : description));
        });
        expect(screen.getTextContent()).not.toContain(targetId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        const technical = screen.getTextContent();
        expect(technical).toContain(targetId);
        expect(technical).not.toMatch(/"(?:content|recipients|recipientEnvelope)"/);
        for (const label of [sealedName, sealedDescription]) {
            if (label.content.t === 'encrypted') expect(technical).not.toContain(label.content.c);
        }
        if (envelope) expect(technical).not.toContain(envelope.encryptedDataKey);
        if (access === 'no key') {
            expect(technical).not.toContain(name);
            expect(technical).not.toContain(description);
        }
    } finally { await screen.unmount(); }
});
