import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HomeCustomizeBanner } from '@/components/hub/header/HomeCustomizeBanner';
import { EmptySlot } from '@/components/ui/empty/EmptySlot';
import { t } from '@/text';

import {
  CHANGES,
  FOLLOW_CHANGES,
  GroupSpecimen,
  SERVICES,
  SERVICES_2,
} from './groupSpecimens';
import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

const NOOP = (): void => {};

/**
 * Home while it is being customized, at static props (lab `widget-groups` wgmenu E): the bar under
 * the greeting, every group with its own bar and child grips, a hole's slot filling the room beside
 * its neighbour, and the one new-row target ending the page. Real components, no live Home.
 */
export const CUSTOMIZE_SPECIMEN_FRAMES: WidgetSpecimenFrames = {
  WGCUSTOMIZE: ({ phone }) => (
    <View style={stylesheet.page}>
      <HomeCustomizeBanner
        phone={phone}
        sectionsOpen={false}
        addOpen={false}
        onToggleSections={NOOP}
        onToggleAdd={NOOP}
        onDone={NOOP}
      />
      <View style={phone ? stylesheet.stack : stylesheet.row}>
        <View style={stylesheet.cell}>
          <GroupSpecimen
            id="untitled"
            phone={phone}
            customizing
            bar
            items={[SERVICES, FOLLOW_CHANGES]}
            options={{ width: 'half' }}
          />
        </View>
        <View style={stylesheet.cell}>
          <GroupSpecimen
            id="week"
            phone={phone}
            customizing
            bar
            items={[CHANGES, SERVICES_2]}
            options={{ title: 'This week', width: 'half' }}
          />
        </View>
      </View>
      {/* A full group whose last widget sits alone: Customize keeps its half beside an empty slot. */}
      <GroupSpecimen
        id="website"
        phone={phone}
        customizing
        bar
        items={[SERVICES, SERVICES_2, FOLLOW_CHANGES]}
        options={{ title: 'website' }}
      />
      <EmptySlot
        testID="new-row"
        icon="plus"
        label={t('homeIndex.newRow')}
        minHeight={88}
      />
    </View>
  ),
};

const stylesheet = StyleSheet.create(() => ({
  page: { gap: 16 },
  // Home's card rows stretch: two half groups in one row share its height.
  row: { flexDirection: 'row', alignItems: 'stretch', gap: 12 },
  stack: { gap: 12 },
  cell: { flex: 1, minWidth: 0 },
}));
