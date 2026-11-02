import * as React from 'react';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RowStatusLine } from '@/components/ui/status/RowStatusLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Modal } from '@/modal';
import {
  COMPUTER_PROVIDER_DISPLAY_NAMES,
  type ComputerProviderSettingsRow,
} from '@/sync/domains/computer/computerProviderSettings';
import {
  useComputerProviderSettings,
  type ComputerProviderSettingsMutation,
} from '@/sync/domains/computer/useComputerProviderSettings';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useSetting } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import type {
  ComputerProviderIdV1,
  ComputerUseSettingsV1,
} from '@happier-dev/protocol/computer/v1';

import {
  resolveComputerProviderRowState,
  type ComputerProviderStatusKind,
} from './computerProviderRowState';

function describeProvider(provider: ComputerProviderIdV1): string {
  return provider === 'cua'
    ? t('computerUse.providers.cuaDescription')
    : t('computerUse.providers.agentDesktopDescription');
}

function statusText(kind: ComputerProviderStatusKind): string | null {
  return kind === 'none' ? null : t(`computerUse.providers.status.${kind}`);
}

/**
 * Computer control (Machine page): which providers agents may use to see and control this machine's
 * screen, each installed when turned on, and the one they use by default. The provider resolver on
 * the machine owns admission; this page only presents and changes the Account's preference.
 */
export function MachineComputerUseSection(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    online: boolean;
  }>,
) {
  const activeAccountScope = useActiveServerAccountScope();
  const sameAccount =
    activeAccountScope !== null &&
    areServerProfileIdentifiersEquivalent(
      activeAccountScope.serverId,
      props.serverId,
    );
  const accountBindings = useServerCredentialAccountScopeBindings([
    props.serverId,
  ]);
  const accountLifetime = accountBindings.values().next().value ?? null;
  const computerUseByMachineId = useSetting('computerUseByMachineId');
  const settings = useComputerProviderSettings({
    machineId: props.machineId,
    serverId: props.serverId,
    accountLifetime,
    computerUseByMachineId: sameAccount ? computerUseByMachineId : null,
    enabled: props.online,
  });
  const { preferences, providers, mutation } = settings;

  // An install failure stays on its row with a retry; a failed save has no row to stand on, so it is said once.
  React.useEffect(() => {
    if (mutation.phase === 'failed' && !mutation.provider) {
      Modal.alert(t('computerUse.providers.saveFailed'), mutation.error);
    }
  }, [mutation]);
  const { setProviderEnabled, installProvider, setDefaultProvider } = settings;
  const onToggle = React.useCallback(
    (row: ComputerProviderSettingsRow, next: boolean) => {
      void setProviderEnabled(row.provider, next);
    },
    [setProviderEnabled],
  );
  const onRepair = React.useCallback(
    (row: ComputerProviderSettingsRow) => {
      void (row.enabled
        ? installProvider(row.provider)
        : setProviderEnabled(row.provider, true));
    },
    [installProvider, setProviderEnabled],
  );
  const onChooseDefault = React.useCallback(
    (provider: ComputerProviderIdV1) => {
      void setDefaultProvider(provider);
    },
    [setDefaultProvider],
  );

  return (
    <MachineComputerUseSectionView
      machineName={props.machineName}
      online={props.online}
      preferences={preferences}
      unavailable={accountLifetime !== null && !sameAccount}
      providers={providers}
      mutation={mutation}
      onToggle={onToggle}
      onRepair={onRepair}
      onChooseDefault={onChooseDefault}
    />
  );
}

export type MachineComputerUseSectionViewProps = Readonly<{
  machineName: string;
  online: boolean;
  /** Null while the Account's preferences are not readable here. */
  preferences: ComputerUseSettingsV1 | null;
  /** The preferences belong to an Account this page cannot read (not merely still loading). */
  unavailable: boolean;
  providers: readonly ComputerProviderSettingsRow[];
  mutation: ComputerProviderSettingsMutation;
  onToggle: (row: ComputerProviderSettingsRow, next: boolean) => void;
  onRepair: (row: ComputerProviderSettingsRow) => void;
  onChooseDefault: (provider: ComputerProviderIdV1) => void;
}>;

/** The page body itself, from the provider rows and the current change. */
export function MachineComputerUseSectionView(
  props: MachineComputerUseSectionViewProps,
) {
  usePreferredLanguage();
  const { providers, mutation, preferences } = props;

  if (!preferences) {
    return (
      <ItemGroup surface="none">
        {props.unavailable ? (
          <SurfaceStateCard
            testID="machine-computer-use-unavailable"
            kind="unavailable"
            title={t('computerUse.providers.loadFailedTitle')}
          />
        ) : (
          <SurfaceStateCard
            testID="machine-computer-use-loading"
            kind="loading"
            title={t('common.loading')}
          />
        )}
      </ItemGroup>
    );
  }

  return (
    <ItemGroup
      testID="machine-computer-use-providers"
      title={t('computerUse.providers.sectionTitle')}
      description={
        props.online
          ? t('computerUse.providers.sectionDescription')
          : t('computerUse.providers.offlineDescription', {
              machine: props.machineName,
            })
      }
    >
      {providers.map((row) => {
        const state = resolveComputerProviderRowState({
          row,
          mutation,
          online: props.online,
        });
        const name = COMPUTER_PROVIDER_DISPLAY_NAMES[row.provider];
        const text = statusText(state.status.kind);
        const testID = `machine-computer-use-provider-${row.provider}`;
        const action = state.action
          ? {
              label: t(ACTION_LABEL_KEYS[state.action]),
              onPress: () =>
                state.action === 'makeDefault'
                  ? props.onChooseDefault(row.provider)
                  : props.onRepair(row),
              testID: `${testID}.${state.action}`,
            }
          : null;
        return (
          <Item
            key={row.provider}
            testID={testID}
            title={name}
            subtitle={describeProvider(row.provider)}
            // The status line can end with its own link, so it sits outside the row's switch press.
            bottomElement={
              text ? (
                <RowStatusLine
                  testID={`${testID}.status`}
                  text={text}
                  tone={state.status.tone}
                  busy={state.status.busy}
                  action={action}
                />
              ) : undefined
            }
            bottomElementInset="text"
            bottomElementOutsidePressable
            detail={state.toggle ? undefined : t('computerUse.providers.defaultTitle')}
            detailTestID={`${testID}.default`}
            rightElement={
              state.toggle ? (
                <Switch
                  testID={`${testID}.switch`}
                  value={state.toggle.value}
                  disabled={state.toggle.disabled}
                  accessibilityLabel={name}
                  onValueChange={(next) => props.onToggle(row, next)}
                />
              ) : undefined
            }
            showChevron={false}
          />
        );
      })}
    </ItemGroup>
  );
}

const ACTION_LABEL_KEYS = {
  install: 'computerUse.providers.install',
  retry: 'computerUse.providers.retry',
  makeDefault: 'computerUse.providers.makeDefault',
} as const;
