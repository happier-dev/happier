import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  HappierRadioMark,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import type { MachineRetentionPolicyV1 } from '@happier-dev/protocol/account/settings/machineRetentionDefaultsV1';
import type { RetentionV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { Switch } from '@/components/ui/forms/Switch';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
  buildRetentionChoices,
  buildRetentionKindChoices,
  describeDefaultPolicy,
  describeFiniteRetention,
  retentionChoiceId,
  retentionStops,
  type RetentionEffect,
} from './managedRetentionPresentation';

export type ManagedMachineKeepControlProps = Readonly<{
  /** The effective policy: an explicit choice, or the inherited default it shows. */
  policy: MachineRetentionPolicyV1;
  /** The next policy up the chain; unavailable parent facts leave Reset disabled. */
  defaultPolicy?: MachineRetentionPolicyV1;
  /** True while nothing is chosen here, so the default applies and there is nothing to reset. */
  inherited: boolean;
  /** The category the default comes from ("Cloud billed while stopped"), named on an inherited choice. */
  categoryLabel?: string;
  /**
   * `field`: a When unused select and the wake switch as page rows (Machine defaults, phone pages).
   * `choices`: three quiet radios with the consequence beneath (the configurator receipt, a machine's
   * Keep it section).
   */
  presentation: 'field' | 'choices';
  /** The effects this provider can carry out; an unsupported one is never offered. */
  effects?: readonly RetentionEffect[];
  /** What the selected choice does, in the provider's billing words; `field` shows one line for the category. */
  consequence: (retention: RetentionV1) => string;
  /** False when the provider cannot start the same machine again, so wake is not offered. */
  canWake?: boolean;
  /** The declared native resource cannot stop and keep the same allocation. */
  finiteOnly?: boolean;
  /** Exact complete option identities; selection writes its returned native launch, never an inferred field. */
  nativeDuration?: Readonly<{
    value: string | null;
    choices: readonly Readonly<{ id: string; title: string; unavailableReason?: string }>[];
    onChange: (id: string) => void;
    /** The contribution-declared native input, relocated here without a second selector. */
    editor?: React.ReactNode;
  }>;
  /** Producer-returned native expiry disclosure. Omission stays explicitly unavailable. */
  nativeExpiry?: string;
  /** Shows the "Keep it" label above the choices (the receipt); a section already titled Keep it hides it. */
  showLabel?: boolean;
  onChange: (policy: MachineRetentionPolicyV1) => void;
  onReset: () => void;
  disabled?: boolean;
  testID: string;
}>;

/**
 * The one Keep it / wake control (plans 51/52): Machine defaults, the configurator receipt, a preset
 * and a created machine all draw it. It never resolves policy; the caller passes the effective value
 * and the default it would reset to.
 */
export const ManagedMachineKeepControl = React.memo(
  function ManagedMachineKeepControl(props: ManagedMachineKeepControlProps) {
    if (props.finiteOnly) return <KeepFinite {...props} />;
    const wakeShown =
      props.canWake !== false && retentionStops(props.policy.retention);
    const setRetention = (retention: RetentionV1) =>
      props.onChange({
        retention,
        // D21 pairs a Stop rule with wake; staying on Stop keeps the person's wake choice, and a
        // rule that never stops carries no wake.
        wakeOnAcceptedMessage:
          retentionStops(retention) &&
          (retentionStops(props.policy.retention)
            ? props.policy.wakeOnAcceptedMessage
            : true),
      });
    const setWake = (wake: boolean) =>
      props.onChange({
        retention: props.policy.retention,
        wakeOnAcceptedMessage: wake,
      });
    return props.presentation === 'field' ? (
      <KeepField
        {...props}
        wakeShown={wakeShown}
        setRetention={setRetention}
        setWake={setWake}
      />
    ) : (
      <KeepChoices
        {...props}
        wakeShown={wakeShown}
        setRetention={setRetention}
        setWake={setWake}
      />
    );
  },
);

function KeepFinite(props: ManagedMachineKeepControlProps) {
  const [open, setOpen] = React.useState(false);
  const duration = props.nativeDuration;
  return <>
    {duration?.editor ? <SectionContentRow testID={`${props.testID}:retention`}>
      <Text style={styles.quiet}>{t('managedRetention.ends')}</Text>
      {duration.editor}
    </SectionContentRow> : duration?.choices.length ? <DropdownMenu open={open} onOpenChange={setOpen} variant="selectable" search={false}
      selectedId={duration.value} showCategoryTitles={false} matchTriggerWidth connectToTrigger rowKind="item"
      itemTrigger={{ title: t('managedRetention.ends'), showSelectedSubtitle: false,
        itemProps: { testID: `${props.testID}:retention`, disabled: props.disabled } }}
      items={duration.choices.map(choice => ({ id: choice.id, title: choice.title, disabled: choice.unavailableReason !== undefined }))}
      onSelect={id => {
        setOpen(false);
        if (!props.disabled && duration.choices.some(choice => choice.id === id && !choice.unavailableReason)) duration.onChange(id);
      }} /> : <Item testID={`${props.testID}:retention`} title={t('managedRetention.ends')}
        subtitle={props.nativeExpiry ?? t('managedMachines.options.unavailable')} mode="info" showChevron={false} />}
    <SectionContentRow testID={`${props.testID}:consequence`}>
      <Text style={styles.consequence}>{describeFiniteRetention(props.policy.retention)}</Text>
      {duration?.choices.length ? <Text style={styles.quiet}>{props.nativeExpiry ?? t('managedMachines.options.unavailable')}</Text> : null}
      {!props.inherited ? <ResetLink testID={`${props.testID}:reset`} onPress={props.onReset}
        disabled={props.disabled || !props.defaultPolicy} /> : null}
    </SectionContentRow>
  </>;
}

type InnerProps = ManagedMachineKeepControlProps &
  Readonly<{
    wakeShown: boolean;
    setRetention: (retention: RetentionV1) => void;
    setWake: (wake: boolean) => void;
  }>;

function KeepField(props: InnerProps) {
  const [open, setOpen] = React.useState(false);
  const choices = React.useMemo(
    () =>
      buildRetentionChoices({
        current: props.policy.retention,
        effects: props.effects,
      }),
    [props.effects, props.policy.retention],
  );
  return (
    <>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        variant="selectable"
        search={false}
        selectedId={retentionChoiceId(props.policy.retention)}
        showCategoryTitles={false}
        matchTriggerWidth
        connectToTrigger
        rowKind="item"
        itemTrigger={{
          title: t('managedRetention.whenUnused'),
          showSelectedSubtitle: false,
          itemProps: {
            testID: `${props.testID}:retention`,
            accessoryLayout: 'adaptive',
            disabled: props.disabled,
          },
        }}
        items={choices.map((choice) => ({
          id: choice.id,
          title: choice.title,
        }))}
        onSelect={(id) => {
          setOpen(false);
          const choice = choices.find((candidate) => candidate.id === id);
          if (choice) props.setRetention(choice.retention);
        }}
      />
      {props.wakeShown ? (
        <Item
          testID={`${props.testID}:wake`}
          title={t('managedRetention.wake')}
          showChevron={false}
          disabled={props.disabled}
          rightElement={
            <Switch
              testID={`${props.testID}:wake:switch`}
              accessibilityLabel={t('managedRetention.wake')}
              value={props.policy.wakeOnAcceptedMessage}
              disabled={props.disabled}
              onValueChange={props.setWake}
            />
          }
          onPress={
            props.disabled
              ? undefined
              : () => props.setWake(!props.policy.wakeOnAcceptedMessage)
          }
        />
      ) : null}
      <SectionContentRow testID={`${props.testID}:consequence`}>
        <Text style={styles.consequence}>
          {props.consequence(props.policy.retention)}
        </Text>
        {props.inherited ? null : (
          <View style={styles.footer}>
            <ResetLink
              testID={`${props.testID}:reset`}
              onPress={props.onReset}
              disabled={props.disabled || !props.defaultPolicy}
            />
            {props.defaultPolicy ? <Text style={styles.quiet} numberOfLines={1}>
              {t('managedRetention.defaultIs', {
                value: describeDefaultPolicy(props.defaultPolicy),
              })}
            </Text> : null}
          </View>
        )}
      </SectionContentRow>
    </>
  );
}

function KeepChoices(props: InnerProps) {
  const { theme } = useUnistyles();
  const radioTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
  const choices = React.useMemo(
    () =>
      buildRetentionKindChoices({
        current: props.policy.retention,
        effects: props.effects,
      }),
    [props.effects, props.policy.retention],
  );
  const selectedId = retentionChoiceId(props.policy.retention);
  const refs = React.useRef<Array<Readonly<{ focus: () => void }> | null>>([]);
  const move = (from: number, delta: number) => {
    const next = (from + delta + choices.length) % choices.length;
    props.setRetention(choices[next]!.retention);
    refs.current[next]?.focus();
  };
  return (
    <View testID={props.testID} style={styles.choices}>
      <View style={[styles.head, props.showLabel ? null : styles.headEnd]}>
        {props.showLabel ? (
          <Text style={styles.quiet}>{t('managedRetention.keepIt')}</Text>
        ) : null}
        {props.inherited ? (
          props.categoryLabel ? (
            <Text style={styles.quiet} numberOfLines={1}>
              {t('managedRetention.defaultCategory', {
                category: props.categoryLabel,
              })}
            </Text>
          ) : null
        ) : (
          <ResetLink
            testID={`${props.testID}:reset`}
            onPress={props.onReset}
            disabled={props.disabled || !props.defaultPolicy}
            underline
          />
        )}
      </View>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={t('managedRetention.keepIt')}
        aria-label={t('managedRetention.keepIt')}
      >
        {choices.map((choice, index) => {
          const selected = choice.id === selectedId;
          return (
            <HappierPressable
              key={choice.id}
              testID={`${props.testID}:choice:${choice.id}`}
              controlRef={(instance) => {
                refs.current[index] = instance;
              }}
              accessibilityRole="radio"
              accessibilityLabel={choice.title}
              checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={props.disabled}
              onPress={() => props.setRetention(choice.retention)}
              onKeyDown={(key) => {
                if (key === 'ArrowDown' || key === 'ArrowRight') {
                  move(index, 1);
                  return true;
                }
                if (key === 'ArrowUp' || key === 'ArrowLeft') {
                  move(index, -1);
                  return true;
                }
                return false;
              }}
              style={styles.choice}
            >
              <HappierRadioMark
                selected={selected}
                disabled={props.disabled}
                theme={radioTheme}
              />
              <Text style={styles.choiceText}>{choice.title}</Text>
            </HappierPressable>
          );
        })}
      </View>
      {/* The consequence keeps its height so the actions below never move as the choice changes. */}
      <Text
        testID={`${props.testID}:consequence`}
        style={[styles.consequence, styles.reserved]}
        accessibilityLiveRegion="polite"
      >
        {props.consequence(props.policy.retention)}
      </Text>
      {props.wakeShown ? (
        <View style={styles.wake}>
          <View style={styles.wakeText}>
            <Text style={styles.choiceText}>{t('managedRetention.wake')}</Text>
            <Text style={styles.quiet}>{t('managedRetention.wakeHelp')}</Text>
          </View>
          <Switch
            testID={`${props.testID}:wake:switch`}
            accessibilityLabel={t('managedRetention.wake')}
            value={props.policy.wakeOnAcceptedMessage}
            disabled={props.disabled}
            onValueChange={props.setWake}
          />
        </View>
      ) : null}
    </View>
  );
}

function ResetLink(
  props: Readonly<{
    testID: string;
    onPress: () => void;
    disabled?: boolean;
    underline?: boolean;
  }>,
) {
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={8}
    >
      <Text style={[styles.reset, props.underline ? styles.underline : null]}>
        {t('managedRetention.resetToDefault')}
      </Text>
    </HappierPressable>
  );
}

const rowDescription = happierPageTextMetrics('rowDescription');

const styles = StyleSheet.create((theme) => ({
  consequence: {
    ...Typography.default(),
    ...rowDescription,
    color: theme.colors.text.secondary,
  },
  reserved: {
    // Two description lines: the longest consequence at the receipt's width.
    minHeight: rowDescription.lineHeight * 2,
    marginTop: 6,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
  },
  quiet: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.tertiary,
    flexShrink: 1,
  },
  reset: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('meta'),
    color: theme.colors.text.primary,
  },
  underline: {
    textDecorationLine: 'underline',
    textDecorationColor: theme.colors.border.default,
  },
  choices: {
    width: '100%',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  headEnd: {
    justifyContent: 'flex-end',
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 5,
  },
  choiceText: {
    ...Typography.default(),
    ...rowDescription,
    color: theme.colors.text.primary,
  },
  wake: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  wakeText: {
    flex: 1,
    minWidth: 0,
  },
}));
