import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

installSettingsViewCommonModuleMocks();
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resolveServerCredentialAccountScope, captureServerCredentialAccountScopeLifetime } =
    await import('@/sync/domains/scope/serverCredentialAccountScope');
const { SoftwareInputFields } = await import('./StoreSoftwareInputs');
const { Modal } = await import('@/modal');
const { SavedSecretPickerModal } = await import('@/components/ui/forms/valueRefs/SavedSecretPickerModal');
const { storage } = await import('@/sync/domains/state/storage');
afterEach(async () => { await standardCleanup(); await harness.reset(); });

it('opens recipe Saved Secrets in the captured Home while another Home is active', async () => {
    await harness.reset();
    const serverId = await harness.addHome({ name: 'Recipe Home', serverUrl: 'https://recipe-secrets.example.test',
        accountId: 'recipe-owner', serverIdentityId: 'recipe-home' });
    const otherServerId = await harness.addHome({ name: 'Other Home', serverUrl: 'https://other-secrets.example.test',
        accountId: 'other-owner', serverIdentityId: 'other-home', currentAccount: true });
    storage.setState({ profileScope: { serverId: otherServerId, accountId: 'other-owner' } });
    const resolved = await resolveServerCredentialAccountScope(serverId);
    if (resolved.kind !== 'bound') throw new Error(`Recipe Home is ${resolved.kind}`);
    const accountLifetime = captureServerCredentialAccountScopeLifetime(resolved);
    const screen = await renderScreen(<SoftwareInputFields fields={[{ path: 'key', title: 'Key', widget: 'select',
        inputType: { hostType: 'savedSecretReference' }, required: true, visible: true, disabled: false }]}
        draft={{}} onPatch={vi.fn()} testID="recipe-inputs" pickerContext={{ serverId, accountLifetime }} />);
    const trigger = screen.findAllByType('Pressable').find(node => String(node.props.accessibilityLabel ?? '').startsWith('Key:'));
    expect(trigger).toBeDefined();
    await act(async () => { void trigger!.props.onPress(); });
    await flushHookEffects({ cycles: 2 });
    const request = vi.mocked(Modal.show).mock.calls.find(([value]) => value.component === SavedSecretPickerModal)?.[0];
    expect(request?.props).toMatchObject({ scope: { serverId, accountId: 'recipe-owner' } });
    await screen.unmount();
});
