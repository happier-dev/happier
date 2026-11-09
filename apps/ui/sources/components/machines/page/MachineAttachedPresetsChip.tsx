import * as React from 'react';
import type { MachineSetupObservationV1 } from '@happier-dev/protocol/machines/setup/machineSetupObservationV1';

import { machineSetupSourceName } from '@/components/machines/setup/machineSetupSourceName';
import { useMachinePresets } from '@/components/settings/machines/managed/useMachinePresets';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

/** How many attached presets the chip names before counting the rest (lab `q/machine`: two names, then +n). */
const NAMED_PRESETS = 2;

/** Two names, then how many more. */
export function machineAttachedPresetsLabel(names: readonly string[]): string {
  const shown = names.slice(0, NAMED_PRESETS).join(' \u00b7 ');
  const rest = names.length - NAMED_PRESETS;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/**
 * The header's "set up from" chip: the daemon's published attachment list, named from the Account's current
 * catalog (never a snapshot), opening Setup. It stays absent until those names are known, so nothing arrives
 * and then renames itself.
 */
export function MachineAttachedPresetsChip(
  props: Readonly<{
    serverId: string;
    attached: NonNullable<MachineSetupObservationV1['attachedPresets']>;
    onPress: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const serverIds = React.useMemo(() => [props.serverId], [props.serverId]);
  const catalog = useMachinePresets(serverIds).presetsByServerId[props.serverId];
  if (!catalog) return null;
  const names = props.attached.map((source) => machineSetupSourceName(source, catalog));
  return (
    <RoundButton
      testID="machine-detail-attached-presets"
      size="small"
      display="secondary"
      title={machineAttachedPresetsLabel(names)}
      accessibilityLabel={`${t('machinePresets.setup.tab.presets')}: ${names.join(', ')}`}
      leading={<Icon name="stack" size={14} color={theme.colors.text.secondary} />}
      onPress={props.onPress}
    />
  );
}
