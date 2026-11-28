import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { MachineSecurityInspectResultV1 } from '@happier-dev/protocol/machines/security/machineSecurityInspectV1';

import type { MachineSecurityRepairControls } from '@/components/machines/security/MachineSecuritySection';
import { describeMachineSetupReason } from '@/components/machines/setup/machineSetupReasonText';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { BareSectionContent } from '@/components/ui/lists/BareSectionContent';
import { Item } from '@/components/ui/lists/Item';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';

type Result = MachineSecurityInspectResultV1;
type Row = Result['rows'][number];
type Band = Extract<Result['grade'], { kind: 'graded' }>['band'];

/** What the Security read has settled to; every grade, state and repair comes from the Machine's projection. */
export type MachineSecurityGradeView =
  | Readonly<{ kind: 'reading' }>
  | Readonly<{ kind: 'offline' }>
  | Readonly<{ kind: 'failed'; message: string; onRetry: () => void }>
  | Readonly<{ kind: 'ready'; result: Result }>;

/** Fix controls come from the section that owns each repair's review (`MachineSecuritySection`). */
export type MachineSecurityFixControls = MachineSecurityRepairControls;

/** The view for the tab's one Security read (`useMachineSecurityObservation`). */
export function machineSecurityGradeView(security: Readonly<{
  status: 'reading' | 'offline' | 'failed' | 'ready' | 'unsupported';
  projection: Result | null;
  failure: unknown;
  refresh: () => Promise<void> | void;
}>): MachineSecurityGradeView {
  if (security.status === 'ready' && security.projection) return { kind: 'ready', result: security.projection };
  if (security.status === 'offline') return { kind: 'offline' };
  if (security.status === 'failed') {
    return { kind: 'failed', message: resolveActionExecutionErrorMessage(security.failure, t('common.requestFailed')),
      onRetry: () => { void security.refresh(); } };
  }
  return { kind: 'reading' };
}

const SECTION_ORDER = ['fail', 'unread', 'pass'] as const;

/**
 * Machine → Security's lead (plan U1c, lab servers-ia round 3 Q10): the grade card, then To fix, Not checked and
 * Passed. Grade, row states and repairs are the daemon projection's (`machines.security.inspect`); this only words
 * and places them. A Fix opens the repair's existing review through the section that owns it.
 */
export function MachineSecurityGradeSummary(
  props: Readonly<{
    view: MachineSecurityGradeView;
    machineName: string;
    fix: MachineSecurityFixControls;
  }>,
): React.ReactElement {
  const { view } = props;
  if (view.kind !== 'ready') {
    return (
      <GradeCard
        testID="machine-security-grade"
        state={view}
        machineName={props.machineName}
      />
    );
  }
  const visible = view.result.rows.filter(
    (row) => row.state !== 'inapplicable',
  );
  return (
    <>
      <GradeCard
        testID="machine-security-grade"
        state={view}
        machineName={props.machineName}
        rows={visible}
      />
      {SECTION_ORDER.map((state) => {
        const rows = visible.filter((row) => row.state === state);
        if (rows.length === 0) return null;
        return (
          <ItemGroup
            key={state}
            testID={`machine-security-grade-${state}`}
            title={t(SECTION_TITLE[state])}
            titleAccessory={<SectionCount count={rows.length} />}
          >
            {rows.map((row) => (
              <CheckRow key={row.check} row={row} fix={props.fix} />
            ))}
          </ItemGroup>
        );
      })}
    </>
  );
}

const SECTION_TITLE = {
  fail: 'machineDetailPage.security.grade.toFixTitle',
  unread: 'machineDetailPage.security.grade.notCheckedTitle',
  pass: 'machineDetailPage.security.grade.passedTitle',
} as const;

function SectionCount(props: Readonly<{ count: number }>) {
  const { theme } = useUnistyles();
  return (
    <Text
      variant="heading"
      style={[styles.tabular, { color: theme.colors.text.secondary }]}
    >
      {String(props.count)}
    </Text>
  );
}

function GradeCard(
  props: Readonly<{
    testID: string;
    machineName: string;
    state: MachineSecurityGradeView;
    rows?: readonly Row[];
  }>,
) {
  const { theme } = useUnistyles();
  const { state } = props;
  if (state.kind === 'reading') {
    return (
      <SurfaceStateCard
        testID={`${props.testID}.reading`}
        kind="loading"
        size="line"
        title={t('common.loading')}
      />
    );
  }
  if (state.kind === 'failed') {
    return (
      <SurfaceStateCard
        testID={`${props.testID}.failed`}
        kind="error"
        size="line"
        title={t('machineDetailPage.security.grade.failedTitle')}
        reason={state.message}
        action={{ label: t('common.retry'), onPress: state.onRetry }}
      />
    );
  }
  const rows = props.rows ?? [];
  const failing = rows.filter((row) => row.state === 'fail');
  const passed = rows.filter((row) => row.state === 'pass').length;
  const unread = rows.filter((row) => row.state === 'unread').length;
  const grade = state.kind === 'ready' ? state.result.grade : null;
  const band: Band | null = grade?.kind === 'graded' ? grade.band : null;
  const tone =
    band === 'F'
      ? theme.colors.state.danger
      : band && band !== 'A'
        ? theme.colors.state.warning
        : null;
  const [title, body] =
    state.kind === 'offline'
      ? [
          t('machineDetailPage.security.grade.offline', {
            machine: props.machineName,
          }),
          t('machineDetailPage.security.grade.offlineBody'),
        ]
      : grade?.kind === 'incomplete'
        ? [
            t('machineDetailPage.security.grade.incomplete'),
            t('machineDetailPage.security.grade.incompleteBody', {
              lower: grade.lowerBand,
              upper: grade.upperBand,
            }),
          ]
        : grade?.kind === 'no_applicable_evidence'
          ? [
              t('machineDetailPage.security.grade.noEvidence'),
              t('machineDetailPage.security.grade.noEvidenceBody', {
                machine: props.machineName,
              }),
            ]
          : failing.length > 0
            ? [
                t('machineDetailPage.security.grade.toFix', {
                  count: failing.length,
                }),
                describeCheck(failing[0]!).title,
              ]
            : [t('machineDetailPage.security.grade.nothingToFix'), null];
  const counts = [
    passed > 0
      ? t('machineDetailPage.security.grade.passed', { count: passed })
      : null,
    failing.length > 0
      ? t('machineDetailPage.security.grade.toFixCount', {
          count: failing.length,
        })
      : null,
    unread > 0
      ? t('machineDetailPage.security.grade.notChecked', { count: unread })
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const letter = band ?? '?';
  const label = band
    ? t('machineDetailPage.security.grade.gradeLabel', { band })
    : grade?.kind === 'incomplete'
      ? t('machineDetailPage.security.grade.gradeRangeLabel', {
          lower: grade.lowerBand,
          upper: grade.upperBand,
        })
      : t('machineDetailPage.security.grade.gradeUnknownLabel');
  return (
    <ItemGroup testID={props.testID} header="none">
      <BareSectionContent>
        <View style={styles.card}>
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={label}
            testID={`${props.testID}.tile`}
            style={[
              styles.tile,
              tone
                ? { backgroundColor: tone.background, borderColor: tone.border }
                : { borderColor: theme.colors.border.default },
            ]}
          >
            <Text
              variant="display"
              emphasis="semiBold"
              style={{
                color: tone
                  ? tone.textForeground
                  : band
                    ? theme.colors.text.primary
                    : theme.colors.text.tertiary,
              }}
            >
              {letter}
            </Text>
          </View>
          <View style={styles.cardText}>
            <Text
              variant="heading"
              emphasis="semiBold"
              style={{ color: theme.colors.text.primary }}
              testID={`${props.testID}.title`}
            >
              {title}
            </Text>
            {body ? (
              <Text
                variant="body"
                style={{ color: theme.colors.text.secondary }}
              >
                {body}
              </Text>
            ) : null}
            {rows.length > 0 ? <EvidenceBar rows={rows} /> : null}
            {counts ? (
              <Text
                variant="meta"
                style={[styles.tabular, { color: theme.colors.text.secondary }]}
              >
                {counts}
              </Text>
            ) : null}
          </View>
        </View>
      </BareSectionContent>
    </ItemGroup>
  );
}

/** One segment per applicable check: amber needs you, neutral passed, an outline not read. Words say the same beside it. */
function EvidenceBar(props: Readonly<{ rows: readonly Row[] }>) {
  const { theme } = useUnistyles();
  return (
    <View
      style={styles.bar}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {props.rows.map((row) => (
        <View
          key={row.check}
          style={[
            styles.segment,
            row.state === 'fail'
              ? { backgroundColor: theme.colors.state.warning.foreground }
              : row.state === 'pass'
                ? { backgroundColor: theme.colors.border.default }
                : {
                    borderWidth: 1,
                    borderStyle: 'dashed',
                    borderColor: theme.colors.border.default,
                  },
          ]}
        />
      ))}
    </View>
  );
}

function CheckRow(
  props: Readonly<{ row: Row; fix: MachineSecurityFixControls }>,
) {
  const { theme } = useUnistyles();
  const { row, fix } = props;
  const copy = describeCheck(row);
  const repair = row.state === 'fail' ? row.repair : undefined;
  const glyph =
    row.state === 'fail' ? (
      <StatusDot
        color={theme.colors.state.warning.foreground}
        accessibilityLabel={t('machineDetailPage.security.grade.toFixTitle')}
      />
    ) : row.state === 'pass' ? (
      <Icon
        name="check"
        size={ICON_SIZE.md}
        color={theme.colors.text.secondary}
      />
    ) : (
      <Icon
        name="question"
        size={ICON_SIZE.md}
        color={theme.colors.text.tertiary}
      />
    );
  return (
    <Item
      testID={`machine-security-grade-row-${row.check}`}
      mode="info"
      icon={glyph}
      title={copy.title}
      {...(copy.detail ? { subtitle: copy.detail } : {})}
      accessoryLayout="adaptive"
      rightElement={
        repair && fix.canFix ? (
          <RoundButton
            testID={`machine-security-grade-fix-${row.check}`}
            size="small"
            display="secondary"
            title={t(
              repair.actionId === 'machines.setup.plan'
                ? 'machineDetailPage.security.grade.reviewUpdates'
                : 'machineDetailPage.security.restart',
            )}
            disabled={fix.busy}
            onPress={() => fix.onFix(repair)}
          />
        ) : undefined
      }
    />
  );
}

const CHECK_KEYS = {
  sshRootCredential:
    'machineDetailPage.security.grade.checks.sshRootCredential',
  sshPassword: 'machineDetailPage.security.grade.checks.sshPassword',
  privateExposure: 'machineDetailPage.security.grade.checks.privateExposure',
  firewall: 'machineDetailPage.security.grade.checks.firewall',
  isolation: 'machineDetailPage.security.grade.checks.isolation',
  osUpdates: 'machineDetailPage.security.grade.checks.osUpdates',
  rebootRequired: 'machineDetailPage.security.grade.checks.rebootRequired',
} as const;

/** Words for one row from its check, state and evidence; an unread row says why with Setup's own reason copy. */
export function describeCheck(
  row: Row,
): Readonly<{ title: string; detail: string | null }> {
  const key = CHECK_KEYS[row.check];
  const reason = row.reason ? describeMachineSetupReason(row.reason) : null;
  if (row.state === 'unread')
    return {
      title: t(`${key}.unread`),
      detail: reason ?? t('machineDetailPage.security.grade.notCheckedReason'),
    };
  if (row.check === 'osUpdates' && row.state === 'fail') {
    const security = row.evidence?.pendingSecurity ?? 0;
    const all = row.evidence?.pendingAll ?? null;
    if (security > 0) {
      return {
        title: t('machineDetailPage.security.securityWaiting', {
          count: security,
        }),
        detail:
          all !== null && all > security
            ? t('machineDetailPage.security.inAll', { count: all })
            : null,
      };
    }
    if (all !== null && all > 0)
      return {
        title: t('machineDetailPage.security.updatesWaiting', { count: all }),
        detail: null,
      };
  }
  return {
    title: t(row.state === 'fail' ? `${key}.fail` : `${key}.pass`),
    detail: null,
  };
}

const styles = StyleSheet.create((theme) => ({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s20,
    paddingVertical: theme.space.s20,
    paddingHorizontal: PAGE_LIST_METRICS.cardPaddingPx,
  },
  tile: {
    width: theme.space.s48 + theme.space.s16,
    height: theme.space.s48 + theme.space.s16,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: { flex: 1, minWidth: 0, gap: theme.space.s4 },
  bar: {
    flexDirection: 'row',
    gap: theme.space.s4,
    paddingTop: theme.space.s8,
    paddingBottom: theme.space.s4,
  },
  segment: {
    width: theme.space.s24,
    height: theme.space.s6,
    borderRadius: theme.space.s6 / 2,
  },
  tabular: { fontVariant: ['tabular-nums'] },
}));
