import 'fake-indexeddb/auto';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealSavedSecretResourceRecipientEnvelopeV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createAccountEncryptionCurrentnessFixtureForCredentials } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createServedHomeAccountToken, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { teamGroupDisplayNameKey, useScopedTeamGroupNameProjectionDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { teamGroupNameBinding } from '@/sync/ops/teams/teamGroupLabels';

import { useOpenedPrivateLabels } from './useOpenedPrivateLabels';

await initializeRealAppRuntimeForTests();
const accountContext = await import('@/sync/ops/actions/actionAccountContext');

async function serveLabelHomes() {
    const homes = await Promise.all(['first', 'second'].map(async (key, index) => {
        const accountId = `${key}-label-viewer`;
        const credentials = {
            token: createServedHomeAccountToken(accountId),
            secret: encodeBase64(new Uint8Array(32).fill(index + 21), 'base64url'),
        };
        const encryption = await createEncryptionFromAuthCredentials(credentials);
        return { key, accountId, credentials, encryption, accountMode: 'e2ee' as const,
            encryptionCurrentness: () => createAccountEncryptionCurrentnessFixtureForCredentials(credentials),
            serverUrl: `https://${key}-label-home.test`,
        };
    }));
    const fixture = await serveAccountHomes({ homes, route: () => undefined });
    const capture = accountContext.captureLazyActionAccountContext;
    const captures = vi.spyOn(accountContext, 'captureLazyActionAccountContext');
    const resolutions = vi.fn();
    const disposals = vi.fn();
    // Instrument real Account lifetimes without substituting key resolution or custody decisions.
    captures.mockImplementation(async (...args) => {
        const account = await capture(...args);
        const { resolveAccountEncryption, dispose } = account;
        vi.spyOn(account, 'resolveAccountEncryption').mockImplementation(signal => {
            resolutions(account.serverId);
            return resolveAccountEncryption(signal);
        });
        vi.spyOn(account, 'dispose').mockImplementation(() => {
            disposals(account.serverId);
            dispose();
        });
        return account;
    });
    const groupsFor = (key: string, ids: readonly string[]) => {
        const home = homes.find(home => home.key === key)!;
        const scope = { serverId: fixture.homes[key]!.id, accountId: home.accountId };
        return ids.map((id) => {
            const dataKey = new Uint8Array(32).fill(17);
            const randomBytes = (length: number) => new Uint8Array(length).fill(23);
            const recipientEnvelope = sealSavedSecretResourceRecipientEnvelopeV1({ resourceDataKey: dataKey,
                recipientContentPublicKey: home.encryption.contentDataKey, randomBytes });
            const { content } = sealPrivateLabelV1({ mode: 'e2ee', binding: teamGroupNameBinding(id),
                value: id, dataKey, recipients: [{ accountId: home.accountId, envelope: recipientEnvelope }], randomBytes });
            return { id, scope, name: { kind: 'available' as const, label: { content, recipientEnvelope } } };
        });
    };
    return { fixture, captures, resolutions, disposals, groupsFor };
}

describe('private label collection Account cost', () => {
    afterEach(() => {
        standardCleanup();
        vi.restoreAllMocks();
    });

    it.each(['encrypted', 'plain'] as const)('opens five %s labels with the required Account work', async (mode) => {
        const { fixture, captures, resolutions, disposals, groupsFor } = await serveLabelHomes();
        try {
            const ids = ['one', 'two', 'three', 'four', 'five'];
            const groups = groupsFor('second', ids);
            const hook = await renderHook(() => useOpenedPrivateLabels({ scope: groups[0]!.scope,
                requests: groups.map(({ id, name }) => ({ key: id, binding: teamGroupNameBinding(id),
                    label: mode === 'encrypted' ? name.label : { content: { t: 'plain', v: id }, recipientEnvelope: null },
                    readPolicy: { kind: 'team-resource' },
                })),
            }));
            await vi.waitFor(() => expect(hook.getCurrent()).toEqual(Object.fromEntries(ids.map(id => [id, id]))));
            const expected = mode === 'encrypted' ? 1 : 0;
            expect.soft(captures).toHaveBeenCalledTimes(expected);
            expect.soft(resolutions).toHaveBeenCalledTimes(expected);
            expect.soft(disposals).toHaveBeenCalledTimes(expected);
        } finally {
            await fixture.dispose();
        }
    });

    it('opens each Home once and withdraws only the retired Home, including its retained names', async () => {
        const { fixture, captures, resolutions, disposals, groupsFor } = await serveLabelHomes();
        try {
            const first = groupsFor('first', ['one', 'two']);
            const second = groupsFor('second', ['one', 'two']);
            const groups = [...first, ...second];
            const keyOf = (group: typeof groups[number]) => teamGroupDisplayNameKey(group.scope, group.id);
            const hook = await renderHook(({ rows }) => useScopedTeamGroupNameProjectionDisplayNames(rows), {
                initialProps: { rows: groups },
            });
            await vi.waitFor(() => expect([...hook.getCurrent()]).toEqual(groups.map(group => [keyOf(group), group.id])));
            const homeIds = [first[0]!.scope.serverId, second[0]!.scope.serverId].sort();
            expect.soft(captures.mock.calls.map(([serverId]) => serverId).sort()).toEqual(homeIds);
            expect.soft(resolutions.mock.calls.map(([serverId]) => serverId).sort()).toEqual(homeIds);
            expect.soft(disposals.mock.calls.map(([serverId]) => serverId).sort()).toEqual(homeIds);

            await fixture.switchAccount('second', 'replacement-viewer');
            const [added] = groupsFor('second', ['three']);
            await hook.rerender({ rows: [...groups, added!] });
            await vi.waitFor(() => expect([...hook.getCurrent()]).toEqual([
                ...first.map(group => [keyOf(group), group.id]),
                ...second.map(group => [keyOf(group), null]),
                [keyOf(added!), null],
            ]));
            expect(captures.mock.calls.slice(-1).map(([serverId]) => serverId)).toEqual([second[0]!.scope.serverId]);
        } finally {
            await fixture.dispose();
        }
    });
});
