import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
  ManagedMachineKeepControl,
  type ManagedMachineKeepControlProps,
} from './ManagedMachineKeepControl';
import {
  formatPriceSource,
  formatPriceUnit,
  formatProviderAmount,
  type ManagedReceiptCost,
  type ManagedReceiptFact,
} from './managedMachineDisplay';

export type ManagedReceiptAction = Readonly<{
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
}>;

/** The one summary of a machine's choices (plan 51): configurator, preset and created machine. */
export type ManagedReceiptModel = Readonly<{
  /** "Your new machine", "Made from Build box · revision 3 · Oct 4", "Each one is made like this · revision 4". */
  caption: string;
  mark: React.ReactNode;
  name: string;
  spec: string;
  onRename?: () => void;
  facts: readonly ManagedReceiptFact[];
  cost: ManagedReceiptCost;
  keep?: Omit<
    ManagedMachineKeepControlProps,
    'presentation' | 'testID' | 'showLabel'
  >;
  saveAsPreset?: Readonly<{
    value: boolean;
    onChange: (next: boolean) => void;
  }>;
  /** Configurator: the one primary action and its billing footnote. */
  primary?: ManagedReceiptAction & Readonly<{ footnote?: string }>;
  /** Created machine: quiet power actions at the foot, where the consequence is stated. */
  secondary?: readonly (ManagedReceiptAction &
    Readonly<{ tone?: 'bordered' | 'text' }>)[];
}>;

/**
 * The receipt: identity, the facts that were chosen, what it costs (a provider price with when it was
 * checked, a share of this computer, or "billed directly"), Keep it, and the action. One component for
 * every place a machine's choices are summarized; read-only callers simply omit the editable parts.
 */
export const MachineConfigurationReceipt = React.memo(
  function MachineConfigurationReceipt(
    props: Readonly<{
      model: ManagedReceiptModel;
      testID: string;
    }>,
  ) {
      const { model } = props;
    return (
      <ItemGroup accessibilityLabel={model.caption}>
        <SectionContentRow>
          <Text style={styles.caption}>{model.caption}</Text>
          <View style={styles.identity}>
            <View style={styles.mark}>{model.mark}</View>
            <View style={styles.identityText}>
              <View style={styles.nameRow}>
                <Text style={styles.name} numberOfLines={1}>
                  {model.name}
                </Text>
                {model.onRename ? (
                  <IconButton
                    testID={`${props.testID}:rename`}
                    iconName="pencil"
                    accessibilityLabel={t('managedMachines.receipt.rename')}
                    variant="plain"
                      onPress={model.onRename}
                  />
                ) : null}
              </View>
              <Text style={styles.spec} numberOfLines={2}>
                {model.spec}
              </Text>
            </View>
          </View>
        </SectionContentRow>
        {model.facts.map((fact) => (
          <Item
            key={fact.id}
            testID={`${props.testID}:fact:${fact.id}`}
            title={fact.label}
            density="compact"
            mode="info"
            showChevron={false}
            rightElement={
              <View style={styles.factValue}>
                {fact.leading ?? null}
                <Text style={styles.factText} numberOfLines={2}>
                  {fact.value}
                </Text>
              </View>
            }
          />
        ))}
        <SectionContentRow testID={`${props.testID}:cost`}>
          <ReceiptCost cost={model.cost} />
        </SectionContentRow>
        {model.keep ? (
          <SectionContentRow>
            <ManagedMachineKeepControl
              {...model.keep}
              presentation="choices"
              showLabel
              testID={`${props.testID}:keep`}
            />
          </SectionContentRow>
        ) : null}
        {model.saveAsPreset ? (
          <Item
            testID={`${props.testID}:save`}
            title={t('managedMachines.receipt.saveAsPreset')}
            subtitle={t('managedMachines.receipt.saveAsPresetHelp')}
            showChevron={false}
            rightElement={
              <Switch
                accessibilityLabel={t('managedMachines.receipt.saveAsPreset')}
                value={model.saveAsPreset.value}
                onValueChange={model.saveAsPreset.onChange}
              />
            }
            onPress={() =>
              model.saveAsPreset?.onChange(!model.saveAsPreset.value)
            }
          />
        ) : null}
        {model.primary ? (
          <SectionContentRow>
            <RoundButton
              testID={model.primary.testID ?? `${props.testID}:primary`}
              title={model.primary.label}
              disabled={model.primary.disabled}
              loading={model.primary.loading}
              onPress={model.primary.onPress}
            />
            {model.primary.footnote ? (
              <Text style={styles.footnote}>{model.primary.footnote}</Text>
            ) : null}
          </SectionContentRow>
        ) : null}
        {model.secondary && model.secondary.length > 0 ? (
          <SectionContentRow>
            <View style={styles.secondary}>
              {model.secondary.map((action) => (
                <RoundButton
                  key={action.label}
                  testID={action.testID}
                  size="normal"
                  display={action.tone === 'text' ? 'inverted' : 'secondary'}
                  title={action.label}
                  leading={action.icon}
                  disabled={action.disabled}
                  loading={action.loading}
                  onPress={action.onPress}
                />
              ))}
            </View>
          </SectionContentRow>
        ) : null}
      </ItemGroup>
    );
  },
);

function ReceiptCost(props: Readonly<{ cost: ManagedReceiptCost }>) {
  const { theme } = useUnistyles();
  const { cost } = props;
  if (cost.kind === 'unpriced') {
    return (
      <Text style={styles.quietLine}>
        {t('managedMachines.price.unavailable', { provider: cost.provider })}
      </Text>
    );
  }
  if (cost.kind === 'price') {
    return (
      <View style={styles.cost}>
        {cost.prices.map((price, index) => (
          <View key={index} style={styles.cost}>
            {price.label !== undefined ? (
              <Text style={styles.quietLine}>{typeof price.label === 'string' ? price.label : price.label.fallback}</Text>
            ) : null}
            <View style={styles.bigRow}>
              <Text style={index === 0 ? styles.big : styles.quietLine}>{formatProviderAmount(price)}</Text>
              <Text style={index === 0 ? styles.bigUnit : styles.quietLine}>{formatPriceUnit(price.unit)}</Text>
            </View>
            <View style={styles.source}>
              <Icon name="clock" size={13} color={theme.colors.text.tertiary} />
              <Text style={styles.sourceText}>{formatPriceSource(price)}</Text>
            </View>
          </View>
        ))}
        {cost.billedTo ? (
          <Text style={styles.quietLine}>{cost.billedTo}</Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.cost}>
      <View style={styles.bigRow}>
        <Text style={styles.big}>{t('managedMachines.price.noBill')}</Text>
        <Text style={styles.bigUnit}>
          {t('managedMachines.price.runsOn', { computer: cost.computer })}
        </Text>
      </View>
      {cost.meters.map((meter) => (
        <View
          key={meter.id}
          style={styles.meter}
          accessibilityLabel={`${meter.label}, ${meter.value}`}
        >
          <View style={styles.meterLabels}>
            <Text style={styles.meterLabel}>{meter.label}</Text>
            <Text style={styles.meterValue}>{meter.value}</Text>
          </View>
          <MeterBar tone="warning" fillFraction={meter.fraction} height={5} />
        </View>
      ))}
      {cost.note ? (
        <View style={styles.source}>
          <Icon name="info" size={13} color={theme.colors.text.tertiary} />
          <Text style={styles.sourceText}>{cost.note}</Text>
        </View>
      ) : null}
    </View>
  );
}

const meta = happierPageTextMetrics('meta');
const rowDescription = happierPageTextMetrics('rowDescription');

const styles = StyleSheet.create((theme) => ({
  caption: {
    ...Typography.default(),
    ...meta,
    color: theme.colors.text.tertiary,
    marginBottom: 8,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  mark: {
    width: 28,
    alignItems: 'center',
  },
  identityText: {
    flex: 1,
    minWidth: 0,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  name: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('sectionTitle'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  spec: {
    ...Typography.default(),
    ...Typography.tabular(),
    ...rowDescription,
    color: theme.colors.text.secondary,
  },
  factValue: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
    justifyContent: 'flex-end',
  },
  factText: {
    ...Typography.default('medium'),
    ...rowDescription,
    color: theme.colors.text.primary,
    textAlign: 'right',
    flexShrink: 1,
  },
  cost: {
    gap: 6,
  },
  bigRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    flexWrap: 'wrap',
  },
  big: {
    ...Typography.default('bold'),
    ...Typography.tabular(),
    ...happierPageTextMetrics('heroTitle'),
    color: theme.colors.text.primary,
  },
  bigUnit: {
    ...Typography.default(),
    ...happierPageTextMetrics('pageDescription'),
    color: theme.colors.text.secondary,
  },
  quietLine: {
    ...Typography.default(),
    ...rowDescription,
    color: theme.colors.text.secondary,
  },
  source: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  sourceText: {
    ...Typography.default(),
    ...meta,
    color: theme.colors.text.tertiary,
    flex: 1,
  },
  meter: {
    gap: 4,
  },
  meterLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  meterLabel: {
    ...Typography.default(),
    ...meta,
    color: theme.colors.text.secondary,
  },
  meterValue: {
    ...Typography.default('medium'),
    ...Typography.tabular(),
    ...meta,
    color: theme.colors.text.primary,
  },
  footnote: {
    ...Typography.default(),
    ...meta,
    color: theme.colors.text.tertiary,
    textAlign: 'center',
    marginTop: 10,
  },
  secondary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
}));
