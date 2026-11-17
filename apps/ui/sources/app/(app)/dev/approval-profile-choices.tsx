import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ApprovalProfileSelect } from '@/components/approvals/ApprovalProfileSelect';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';

/**
 * Dev-only: the one approval-profile choice in the states a Session reaches, drawn by the real
 * ApprovalProfileSelect with static data (no RPCs). Session Info's row and the composer chip each show: following
 * the Machine's profile, a chosen profile, and a reference whose profile was deleted or stored in a retired shape
 * (the profile owner reports it missing, so it reads as deleted with a warning).
 */
const PROFILES = [
  { id: 'reviewed-writes', name: 'Reviewed writes' },
  { id: 'release-week', name: 'Release week' },
] as const;
const SOURCE = { profiles: PROFILES, ready: true, unavailable: false };
const MACHINE_DEFAULT = { profile: PROFILES[0] };
const STATES = [
  { key: 'machine', value: null },
  { key: 'chosen', value: 'release-week' },
  { key: 'missing', value: 'legacy-require-all' },
] as const;

const ignore = () => {};

export default function ApprovalProfileChoicesDevScreen() {
  return (
    <ItemList>
      <ItemGroup
        title="Session Info row"
        description="Following the Machine, chosen, deleted or legacy profile."
      >
        {STATES.map((state) => (
          <ApprovalProfileSelect
            key={state.key}
            mode="session"
            testID={`dev-profile-row-${state.key}`}
            value={state.value}
            source={SOURCE}
            machineDefault={MACHINE_DEFAULT}
            onChange={ignore}
            presentation="row"
            icon={<Icon name="shield-check" />}
          />
        ))}
      </ItemGroup>
      <ItemGroup
        title="Composer chip"
        description="The same three states in the composer."
      >
        <View style={styles.chips}>
          {STATES.map((state) => (
            <ApprovalProfileSelect
              key={state.key}
              mode="session"
              testID={`dev-profile-chip-${state.key}`}
              value={state.value}
              source={SOURCE}
              machineDefault={MACHINE_DEFAULT}
              onChange={ignore}
              presentation="chips"
            />
          ))}
        </View>
      </ItemGroup>
    </ItemList>
  );
}

const styles = StyleSheet.create((theme) => ({
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.space.s8,
    padding: theme.space.s12,
  },
}));
