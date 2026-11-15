import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

installSettingsViewCommonModuleMocks({ storage: 'real' });

const { SavedSecretVaultFields, useSavedSecretVaultChoice } =
  await import('./SavedSecretVaultFields');
const { MachineAdministrationTargetSelector } =
  await import('@/components/settings/machines/MachineAdministrationTargetSelector');

afterEach(async () => {
  await standardCleanup();
});

function source(machineIds: readonly string[]) {
  return {
    key: 'happier.secret-source.onepassword/onepassword',
    title: '1Password',
    contribution: {
      pluginId: 'happier.secret-source.onepassword',
      localId: 'onepassword',
    },
    capabilities: { list: true as const },
    machineIds,
  };
}

function Vault(props: Readonly<{ machineIds: readonly string[] }>) {
  const choice = useSavedSecretVaultChoice({
    scope: null,
    source: source(props.machineIds),
  });
  return (
    <SavedSecretVaultFields
      choice={choice}
      provider="1Password"
      testID="vault"
    />
  );
}

describe('SavedSecretVaultFields', () => {
  it('asks which Machine to read from when the source is installed on several, before any vault read', async () => {
    const screen = await renderScreen(
      <Vault machineIds={['machine-a', 'machine-b']} />,
    );
    expect(
      screen.root.findAllByType(MachineAdministrationTargetSelector),
    ).toHaveLength(1);
    screen.changeTextByTestId('vault-account', 'my-team.1password.com');
    await flushHookEffects();
    expect(screen.findByTestId('vault-show')?.props.disabled).toBe(true);
  });

  it('reads a sole installation without asking', async () => {
    const screen = await renderScreen(<Vault machineIds={['machine-a']} />);
    expect(
      screen.root.findAllByType(MachineAdministrationTargetSelector),
    ).toHaveLength(0);
    screen.changeTextByTestId('vault-account', 'my-team.1password.com');
    await flushHookEffects();
    expect(screen.findByTestId('vault-show')?.props.disabled).toBe(false);
  });
});
