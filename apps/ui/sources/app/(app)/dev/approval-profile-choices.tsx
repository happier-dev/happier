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
/** Team, Group and project defaults: inherited (shows what applies), a named profile, and None. */
const DEFAULT_STATES = [
  { key: 'inherited', value: undefined },
  { key: 'chosen', value: 'release-week' },
  { key: 'none', value: null },
] as const;
const DEFAULT_CHOICES = {
  inherit: { title: 'Use the default · Reviewed writes', subtitle: 'Payments', detail: 'Reviewed writes' },
  none: { title: 'None', subtitle: 'New sessions start without a profile.' },
};

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
        title="Defaults field"
        description="Team, Group and project defaults: inherited, chosen, None."
      >
        {DEFAULT_STATES.map((state) => (
          <ApprovalProfileSelect
            key={state.key}
            mode="default"
            testID={`dev-profile-default-${state.key}`}
            value={state.value}
            source={SOURCE}
            defaultChoices={DEFAULT_CHOICES}
            description="Members keep their own approval profile until they choose this one."
            layout="adaptive"
            onChange={ignore}
          />
        ))}
      </ItemGroup>
      {/* The composer's chip row sits on no section sheet, so its missing-profile line takes no row inset there. */}
      <View>
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
      </View>
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
