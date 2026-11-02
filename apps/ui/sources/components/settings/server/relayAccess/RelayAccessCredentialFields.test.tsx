import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { relayAccessProviderDescriptorsById } from '@happier-dev/cli-common/relayAccess/catalog';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ConnectedAccountPurposeTargetChooser } from '@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser';
import { storage } from '@/sync/domains/state/storageStore';
import { t } from '@/text';

import { RelayAccessCredentialFields } from './RelayAccessCredentialFields';

const initialStorageState = storage.getState();
const cloudflare = relayAccessProviderDescriptorsById.cloudflareNamed!;
const account = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: '35f1d8ec-633c-4bda-9e0d-7055ac95b8af' };
const actionScope = { serverId: 'server-a', accountId: 'account-a' };

afterEach(() => {
    storage.setState(initialStorageState, true);
    standardCleanup();
});

async function render(accountScope: typeof actionScope | null, onChange = vi.fn()) {
    storage.setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
    const screen = await renderScreen(<RelayAccessCredentialFields descriptor={cloudflare} value={[]}
        onChange={onChange} accountScope={accountScope} testIDPrefix="relay" />);
    return { chooser: () => screen.findByType(ConnectedAccountPurposeTargetChooser as never), onChange };
}

describe('RelayAccessCredentialFields', () => {
    it('chooses each declared purpose as one exact connected account reference', async () => {
        const { chooser, onChange } = await render(actionScope);
        expect(chooser().props).toMatchObject({ accountsOnly: true, disabled: false, declaration: { purpose: 'tunnel.manage', required: true } });

        await act(async () => { chooser().props.onChange({ kind: 'account', account }, null); });
        expect(onChange).toHaveBeenLastCalledWith([
            { purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account } },
        ]);

        await act(async () => { chooser().props.onChange(null, null); });
        expect(onChange).toHaveBeenLastCalledWith([]);
    });

    it('offers no choice when the access action runs as another Account than the active one', async () => {
        const { chooser } = await render({ serverId: 'server-b', accountId: 'account-b' });
        expect(chooser().props).toMatchObject({
            disabled: true,
            disabledReason: t('connectedServices.purposeTargets.signInToChoose'),
        });
    });
});
