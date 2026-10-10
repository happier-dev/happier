import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The bar that says Home is being customized (lab `widget-groups` wgmenu E): what state the page is
 * in and what dragging does, then the three things that are not on a card — the section list, Add
 * widget and the one primary action, Done. On a phone the hint leaves and the actions wrap beneath.
 */
export const HomeCustomizeBanner = React.memo(function HomeCustomizeBanner(
  props: Readonly<{
    phone: boolean;
    sectionsOpen: boolean;
    addOpen: boolean;
    onToggleSections: () => void;
    onToggleAdd: () => void;
    onDone: () => void;
    sectionsAnchorRef?: React.RefObject<View | null>;
    addAnchorRef?: React.RefObject<View | null>;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View testID="home-hub.customizing" style={styles.bar}>
      <View style={styles.words}>
        <Icon
          name="sliders-horizontal"
          size={ICON_SIZE.sm}
          color={theme.colors.text.primary}
        />
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {t('homeIndex.customizing')}
        </Text>
        {props.phone ? null : (
          <Text style={styles.hint} numberOfLines={1}>
            {t('homeIndex.customizingHint')}
          </Text>
        )}
      </View>
      <View style={styles.actions}>
        <View ref={props.sectionsAnchorRef} collapsable={false}>
          <SectionActionButton
            testID="home-hub.customizing.sections"
            title={t('homeIndex.sections')}
            icon="list-bullets"
            expanded={props.sectionsOpen}
            onPress={props.onToggleSections}
          />
        </View>
        <View ref={props.addAnchorRef} collapsable={false}>
          <RoundButton
            testID="home-hub.customizing.add"
            size="small"
            display="secondary"
            title={t('homeIndex.addWidget')}
            leading={
              <Icon
                name="plus"
                size={ICON_SIZE.xs}
                color={theme.colors.text.primary}
              />
            }
            expanded={props.addOpen}
            onPress={props.onToggleAdd}
          />
        </View>
        <RoundButton
          testID="home-hub.customizing.done"
          size="small"
          title={t('common.done')}
          onPress={props.onDone}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // The one tinted surface on the page while customizing: it says what state Home is in.
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: theme.borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.state.active.border,
    backgroundColor: theme.colors.state.active.background,
  },
  words: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexGrow: 1,
    flexShrink: 1,
    // Takes the room the actions leave; the hint truncates before the actions wrap.
    flexBasis: 0,
    minWidth: 160,
  },
  title: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowTitle'),
    color: theme.colors.text.primary,
    flexShrink: 0,
  },
  hint: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 0,
  },
}));
