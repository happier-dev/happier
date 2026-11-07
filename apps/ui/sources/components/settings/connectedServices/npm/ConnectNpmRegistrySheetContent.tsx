import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Icon } from '@/components/ui/icons/Icon';
import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import type { ConnectSheetContentProps, ConnectSheetNpmRegistryRequest } from '../setup/ConnectedServiceSetupModal';
import { useConnectSheetHeading } from '../setup/useConnectSheetHeading';
import { NpmRegistryProfilesSection } from './NpmRegistryProfilesSection';

export function ConnectNpmRegistrySheetContent(props: ConnectSheetContentProps & Readonly<{ request: ConnectSheetNpmRegistryRequest }>) {
  const { theme } = useUnistyles();
  const ownSelection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins, {
    enabled: props.request.targetSelection === undefined,
  });
  const selection = props.request.targetSelection ?? ownSelection;
  const machineChip = React.useMemo(() => (
    <MachineAdministrationTargetSelector selection={selection} presentation="chip"
      disabled={props.request.targetSelection !== undefined} testIDPrefix="connect-sheet:npm-target" />
  ), [selection, props.request.targetSelection]);
  useConnectSheetHeading(props, {
    title: t('settingsPlugins.registriesTitle'),
    subtitle: '',
    leading: <Icon name="package" size={18} color={theme.colors.text.secondary} />,
    leadingKey: 'npm-registry-profile',
    actions: machineChip,
  });
  return <View style={{ paddingHorizontal: theme.space.s16, paddingTop: theme.space.s4, paddingBottom: theme.space.s16 }} testID="connect-sheet:npm-registry-profile">
    {props.setChrome ? null : machineChip}
    <NpmRegistryProfilesSection daemonOperationsAvailable={selection.canExecute} targetSelection={selection}
      currentProfileId={props.request.current} projectDir={props.request.projectDir} onProfileResult={props.onResult}
      onOperationError={props.request.onOperationError ? (code) => {
        props.onResult({ kind: 'dismissed' });
        props.request.onOperationError?.(code);
      } : undefined}
      titled={false} />
  </View>;
}

