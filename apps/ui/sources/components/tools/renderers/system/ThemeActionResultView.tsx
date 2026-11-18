import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Collection, type CollectionAnatomy, useHappierCollection } from '@happier-dev/plugin-ui';

import { ThemeMiniaturePreview } from '@/components/settings/appearance/ThemeModePreview';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import {
  SelectionTiles,
  type SelectionTile,
} from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { ThemeDevicePickerPopover } from '@/components/settings/appearance/themeProfiles/ThemeDevicePickerPopover';
import { Text } from '@/components/ui/text/Text';
import { useDeviceType } from '@/utils/platform/responsive';
import { joinList } from '@/utils/text/joinList';
import { t } from '@/text';
import { Typography } from '@/constants/Typography';

import { StructuredToolCard } from '../core/StructuredToolCard';
import type {
  ThemeActionResultViewProps,
  ThemeResultOperation,
  ThemeResultPhase,
} from './themeActionResultViewTypes';

/**
 * The agent theme card (lab B1–B4, E2, E4 with the approved review deltas): the theme itself as its own
 * miniature, one truthful status line, and the verbs its state allows. The app around it is already wearing
 * the theme (the shared try-on paints it with the existing horizon), so the card names what and where; it
 * never claims a save or an apply that has not happened (finding 2), and it says each fact once (finding 15).
 * Presentation only: every verb is the model's callback.
 */
export const ThemeActionResultView = React.memo(function ThemeActionResultView(
  props: ThemeActionResultViewProps,
) {
  const phone = useDeviceType() === 'phone';
  const { theme: palette } = useUnistyles();
  const { theme, phase } = props;
  const modeWord =
    theme.mode === 'dark' ? t('themeCard.dark') : t('themeCard.light');
  const kicker = `${theme.created ? t('themeCard.newTheme') : t('themeCard.updatedTheme')} · ${modeWord}`;
  const status = statusLine(phase, props.here, theme.name);
  const options = props.options ?? [];
  const comparison = props.before ? props.before : null;

  return (
    <StructuredToolCard>
      <View testID={props.testID} style={styles.card}>
        {options.length > 1 ? <ThemeOptions {...props} /> : null}
        {comparison ? (
          <View
            style={[styles.comparison, phone ? styles.comparisonPhone : null]}
            testID={props.testID ? `${props.testID}:comparison` : undefined}
          >
            <ComparisonFace label={t('themeCard.before')}>
              <ThemeMiniaturePreview miniature={comparison} surfaceStyles={props.beforeSurfaceStyles} />
            </ComparisonFace>
            <View style={styles.comparisonArrow}>
              <Icon
                name="arrow-right"
                size={ICON_SIZE.xs}
                color={palette.colors.text.tertiary}
              />
            </View>
            <ComparisonFace label={t('themeCard.after')}>
              <ThemeMiniaturePreview miniature={theme.miniature} surfaceStyles={theme.surfaceStyles} />
            </ComparisonFace>
          </View>
        ) : null}
        <View style={[styles.body, phone ? styles.bodyPhone : null]}>
          {comparison || options.length > 1 ? null : (
            <View
              style={[styles.miniature, phone ? styles.miniaturePhone : null]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {/* A phone card shows the phone the theme will wear (lab B1P); wide cards show the window. */}
              <ThemeMiniaturePreview miniature={theme.miniature} form={phone ? 'phone' : 'window'} surfaceStyles={theme.surfaceStyles} />
            </View>
          )}
          <View style={styles.text}>
            <View
              style={[styles.identity, phone ? styles.identityPhone : null]}
            >
              <Text
                variant="label"
                emphasis="semiBold"
                numberOfLines={1}
                style={styles.name}
                accessibilityLabel={theme.name}
              >
                {theme.name}
              </Text>
              <Text variant="meta" numberOfLines={1} style={styles.kicker}>
                {kicker}
              </Text>
            </View>
            <WordCrossFade wordKey={phaseKey(phase)}>
              <StatusLine
                glyph={status.glyph}
                tone={status.tone}
                text={status.text}
                testID={props.testID ? `${props.testID}:status` : undefined}
              />
            </WordCrossFade>
            {phase.kind === 'failed' && phase.code ? (
              <Text variant="meta" selectable style={styles.failureCode} testID={props.testID ? `${props.testID}:code` : undefined}>{phase.code}</Text>
            ) : null}
            <Facts {...props} />
            {phone ? null : <Actions {...props} />}
          </View>
        </View>
        {phone ? <Actions {...props} /> : null}
      </View>
    </StructuredToolCard>
  );
});

function phaseKey(phase: ThemeResultPhase): string {
  return phase.kind === 'failed' ? `failed:${phase.operation}` : phase.kind;
}

type Status = Readonly<{
  text: string;
  glyph: IconName | null;
  tone: 'secondary' | 'danger';
}>;

/** One line per state; the mode is in the kicker, the device in `here`, so no line repeats another. */
function statusLine(
  phase: ThemeResultPhase,
  here: string,
  name: string,
): Status {
  switch (phase.kind) {
    case 'trying':
      return {
        text: t('themeCard.trying', { here }),
        glyph: 'eye',
        tone: 'secondary',
      };
    case 'replaced':
      return { text: t('themeCard.replaced'), glyph: null, tone: 'secondary' };
    case 'reverted':
      return {
        text: t('themeCard.reverted'),
        glyph: 'arrow-counter-clockwise',
        tone: 'secondary',
      };
    case 'kept':
      return {
        text: t('themeCard.kept', { here }),
        glyph: 'check',
        tone: 'secondary',
      };
    case 'applied':
      return {
        text: t('themeCard.applied', { here }),
        glyph: 'check',
        tone: 'secondary',
      };
    case 'undone':
      return {
        text: phase.restoredName
          ? t('themeCard.undoneTo', { name: phase.restoredName })
          : t('themeCard.undone'),
        glyph: 'arrow-counter-clockwise',
        tone: 'secondary',
      };
    case 'failed':
      return {
        text: failedLine(phase.operation, name),
        glyph: 'warning',
        tone: 'danger',
      };
  }
}

function failedLine(operation: ThemeResultOperation, name: string): string {
  switch (operation) {
    case 'keep':
      return t('themeCard.failedKeep', { name });
    case 'try':
    case 'apply':
      return t('themeCard.failedApply', { name });
    case 'undo':
      return t('themeCard.failedUndo');
    case 'redo':
      return t('themeCard.failedRedo');
  }
}

function StatusLine(
  props: Readonly<{
    text: string;
    glyph: IconName | null;
    tone: Status['tone'];
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const color =
    props.tone === 'danger'
      ? theme.colors.state.danger.textForeground
      : theme.colors.text.secondary;
  return (
    <View style={styles.statusRow} testID={props.testID}>
      {props.glyph ? <Icon name={props.glyph} size={ICON_SIZE.xs} color={color} /> : null}
      <Text variant="body" style={[styles.statusText, { color }]}>
        {props.text}
      </Text>
    </View>
  );
}

/** Reshape, coverage, hides and the device result: each only when the result carries it. */
function Facts(props: ThemeActionResultViewProps) {
  const { theme } = useUnistyles();
  const lines: React.ReactNode[] = [];
  const reshapes = props.reshapes ?? [];
  const coverage = props.coverage;
  if (reshapes.length > 0 || (coverage && coverage.webOnly > 0)) {
    lines.push(
      <View
        key="css"
        style={styles.factRow}
        testID={props.testID ? `${props.testID}:coverage` : undefined}
      >
        <Icon name="code" size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
        <Text variant="meta" style={styles.fact}>
          {[
            reshapes.length > 0
              ? t('themeCard.reshapes', { areas: joinList(reshapes) })
              : null,
            coverage && coverage.webOnly > 0
              ? t('themeCard.coverage', {
                  native: coverage.native,
                  total: coverage.total,
                })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          {coverage &&
          coverage.webOnly > 0 &&
          props.onRevealWebOnly &&
          !props.webOnlyRules ? (
            <Text variant="meta" style={styles.fact}>
              {' · '}
              <TextLinkButton
                label={t('themeCard.coverageWhich', {
                  count: coverage.webOnly,
                })}
                onPress={props.onRevealWebOnly}
                testID={props.testID ? `${props.testID}:which` : undefined}
              />
            </Text>
          ) : null}
        </Text>
      </View>,
    );
  }
  if (props.webOnlyRules && props.webOnlyRules.length > 0) {
    lines.push(
      <View key="webOnly" style={styles.webOnly}>
        <Text variant="meta" style={styles.fact}>
          {t('themeCard.webOnlyLead')}
        </Text>
        {props.webOnlyRules.map((rule) => (
          <Text key={rule} variant="meta" style={styles.webOnlyRule}>
            {rule}
          </Text>
        ))}
      </View>,
    );
  }
  const hides = props.hides ?? [];
  if (hides.length > 0) {
    lines.push(
      <View
        key="hides"
        style={styles.factRow}
        testID={props.testID ? `${props.testID}:hides` : undefined}
      >
        <Icon name="eye-slash" size={ICON_SIZE.xs} color={theme.colors.state.attention.textForeground} />
        <Text variant="meta" style={[styles.fact, styles.attention]}>
          {t('themeCard.hides', { areas: joinList(hides), here: props.here })}
        </Text>
      </View>,
    );
  }
  const distribution = props.distribution;
  if (distribution && distribution.applied.length > 0) {
    lines.push(
      <View
        key="applied"
        style={styles.factRow}
        testID={props.testID ? `${props.testID}:distribution` : undefined}
      >
        <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
        <Text variant="meta" style={styles.fact}>
          {t('themeCard.appliedOn', {
            devices: joinList(distribution.applied),
          })}
        </Text>
      </View>,
    );
  }
  if (distribution && distribution.failed.length > 0) {
    lines.push(
      <DeviceFailures key="failed" failures={distribution.failed}
        testID={props.testID ? `${props.testID}:failed-devices` : undefined} />,
    );
  }
  return lines.length > 0 ? <View style={styles.facts}>{lines}</View> : null;
}

type DeviceFailure = NonNullable<ThemeActionResultViewProps['distribution']>['failed'][number] & Readonly<{ key: string }>;
const failureKey = (failure: DeviceFailure) => failure.key;
const noOpen = () => {};
const passThroughScroller = (children: React.ReactNode) => children;
const failureLabel = (failure: DeviceFailure) => failure.reason === 'disconnected'
  ? t('themeCard.deviceDisconnected', { device: failure.label })
  : t('themeCard.deviceFailed', { device: failure.label });

function DeviceFailures(props: Readonly<{
  failures: NonNullable<ThemeActionResultViewProps['distribution']>['failed'];
  testID?: string;
}>) {
  const { theme } = useUnistyles();
  const rows = React.useMemo(() => props.failures.map((failure, index) => ({ ...failure, key: String(index) })), [props.failures]);
  const model = useHappierCollection({ items: rows, keyOf: failureKey, openKey: null, onOpenChange: noOpen });
  const anatomy = React.useMemo<CollectionAnatomy<DeviceFailure>>(() => ({
    glyph: () => <Icon name="warning" size={ICON_SIZE.xs} color={theme.colors.state.danger.textForeground} />,
    title: failureLabel,
    accessibilityLabel: failureLabel,
    columnTitles: { title: t('settingsAccount.devices') },
  }), [theme.colors.state.danger.textForeground]);
  return <CoreCollectionScope renderPageScroller={passThroughScroller}>
    <Collection model={model} anatomy={anatomy} presentation="list" detail="none" scroll="page"
      minListWidth={280} minDetailWidth={280} preferredListRatio={1}
      selection={{ isItemActivatable: () => false }} testID={props.testID}
      accessibilityLabel={t('settingsAccount.devices')} />
  </CoreCollectionScope>;
}

/** One primary at most (Keep while trying, Try again after a failure); the rest are quiet. */
function Actions(props: ThemeActionResultViewProps) {
  const { phase, busy } = props;
  const waiting = busy !== null;
  const buttons: React.ReactNode[] = [];
  const id = (suffix: string) =>
    props.testID ? `${props.testID}:${suffix}` : undefined;
  const quiet = (
    key: string,
    title: string,
    onPress: () => void,
    operation?: ThemeResultOperation,
  ) => (
    <RoundButton
      key={key}
      size="small"
      display="inverted"
      title={title}
      onPress={onPress}
      testID={id(key)}
      loading={operation !== undefined && busy === operation}
      disabled={waiting}
    />
  );
  switch (phase.kind) {
    case 'trying':
      buttons.push(
        <RoundButton
          key="keep"
          size="small"
          title={t('themeCard.keep')}
          onPress={props.onKeep}
          testID={id('keep')}
          loading={busy === 'keep'}
          disabled={waiting}
        />,
      );
      buttons.push(quiet('undo', t('themeCard.undo'), props.onUndo, 'undo'));
      break;
    case 'kept':
    case 'applied':
      if (props.onUseOtherDevices) {
        buttons.push(
          <View
            key="devices"
            ref={props.devicesAnchorRef as React.RefObject<View>}
            collapsable={false}
          >
            <RoundButton
              size="small"
              display="secondary"
              title={t('themeCard.useOtherDevices')}
              onPress={props.onUseOtherDevices}
              testID={id('devices')}
              disabled={waiting}
            />
          </View>,
        );
      }
      buttons.push(quiet('undo', t('themeCard.undo'), props.onUndo, 'undo'));
      break;
    case 'undone':
      buttons.push(quiet('redo', t('themeCard.redo'), props.onRedo, 'redo'));
      break;
    case 'replaced':
    case 'reverted':
      buttons.push(
        quiet('retry', t('themeCard.tryAgain'), props.onRetry, 'try'),
      );
      break;
    case 'failed':
      buttons.push(
        <RoundButton
          key="retry"
          size="small"
          title={t('themeCard.retry')}
          onPress={props.onRetry}
          testID={id('retry')}
          loading={busy === phase.operation}
          disabled={waiting}
        />,
      );
      if (phase.operation === 'keep')
        buttons.push(quiet('undo', t('themeCard.undo'), props.onUndo, 'undo'));
      break;
  }
  if (props.onEdit && phase.kind !== 'undone')
    buttons.push(quiet('edit', t('themeCard.edit'), props.onEdit));
  return (
    <View style={styles.actions}>
      {buttons}
      {props.devicePicker && props.devicesAnchorRef ? (
        <ThemeDevicePickerPopover
          anchorRef={props.devicesAnchorRef}
          onDismiss={props.onDismissDevices ?? noop}
          themeName={props.theme.name}
        >
          {props.devicePicker}
        </ThemeDevicePickerPopover>
      ) : null}
    </View>
  );
}

function noop() {}

function ThemeOptions(props: ThemeActionResultViewProps) {
  const phone = useDeviceType() === 'phone';
  const tiles = React.useMemo(
    (): SelectionTile<string>[] =>
      (props.options ?? []).map((option) => ({
        id: option.key,
        title: option.name,
        subtitle: option.description,
        preview: <ThemeMiniaturePreview miniature={option.miniature} />,
      })),
    [props.options],
  );
  return (
    <SelectionTiles
      variant="visual"
      scroll="page"
      tileSizing="fill"
      options={tiles}
      value={props.currentOptionKey ?? null}
      onChange={(next) => {
        if (next) props.onTryOption(next);
      }}
      maximumColumns={phone ? 2 : 4}
      accessibilityLabel={t('themeCard.options')}
      testIdPrefix={props.testID ? `${props.testID}:option` : undefined}
    />
  );
}

function ComparisonFace(
  props: Readonly<{ label: string; children: React.ReactNode }>,
) {
  return (
    <View style={styles.face}>
      <Text variant="micro" style={styles.faceLabel}>
        {props.label}
      </Text>
      <View
        style={styles.faceFrame}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {props.children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.space.s12,
  },
  body: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s16,
  },
  bodyPhone: {
    gap: theme.space.s12,
  },
  miniature: {
    width: 184,
    aspectRatio: 1.6,
    borderRadius: theme.borderRadius.sm,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.subtle,
  },
  miniaturePhone: {
    width: 104,
    aspectRatio: 1,
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s4,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: theme.space.s8,
  },
  identityPhone: {
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  name: {
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  kicker: {
    color: theme.colors.text.tertiary,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
  statusText: {
    flexShrink: 1,
  },
  facts: {
    gap: theme.space.s4,
  },
  factRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s6,
  },
  fact: {
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  attention: {
    color: theme.colors.state.attention.textForeground,
  },
  webOnly: {
    paddingLeft: theme.space.s20,
    gap: theme.space.s2,
  },
  failureCode: {
    color: theme.colors.text.tertiary,
    ...Typography.mono(),
  },
  webOnlyRule: {
    color: theme.colors.text.tertiary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s6,
    marginTop: theme.space.s8,
  },
  comparison: {
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: 520,
    gap: theme.space.s8,
  },
  comparisonPhone: {
    maxWidth: undefined,
  },
  comparisonArrow: {
    paddingTop: theme.space.s16,
  },
  face: {
    flex: 1,
    gap: theme.space.s6,
  },
  faceLabel: {
    color: theme.colors.text.tertiary,
  },
  faceFrame: {
    aspectRatio: 1.6,
    borderRadius: theme.borderRadius.sm,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.subtle,
  },
}));
