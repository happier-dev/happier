import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentStepV1 } from '@happier-dev/deployments/contracts/v1';

import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { DeploymentStepStrip, deploymentStepCaption } from './DeploymentStepStrip';
import Reanimated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { motionTokens, resolveInPlaceMorphTiming } from '@/components/ui/motion/motionTokens';
import { WorkStatusGlyph } from '@/components/work/status/WorkStatusGlyph';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import {
  deploymentDurationMs,
  deploymentReceiptAtMs,
  deploymentRevisionLabel,
  deploymentStepWorkStatus,
} from './deploymentPresentation';
import type { useDeploymentReceipt } from './useDeploymentReads';
import { GROUPED_SURFACE_RADIUS_PX, PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

type DeploymentServingReceiptValue = Exclude<
  ReturnType<typeof useDeploymentReceipt>['snapshot']['value'], null | { content: null }
>;

/** A way forward the deploy card offers for the deploy it carries (its receipt, Deploy when finished, the cause's fix). */
export type DeploymentCardAction = Readonly<{ label: string; onPress: () => void; testID: string }>;

/**
 * The deploy the card carries while it runs or after it failed (lab siaR3 Q8): History's title for it ("Deploying
 * 7f3e2b1"), its cause or commit, its steps from the pushed attempt, and the live log band of its receipt.
 */
export type DeploymentCardRun = Readonly<{
  kind: 'running' | 'failed';
  title: string;
  lead: string | null;
  startedAtMs: number | null;
  steps: readonly DeploymentStepV1[];
  /** The live log band; the card hands it the full-bleed placement, which it takes only when it has a log to show. */
  band: (placement: StyleProp<ViewStyle>) => React.ReactNode;
  action: DeploymentCardAction;
  secondaryAction?: DeploymentCardAction | null;
}>;

/**
 * The Environment's deploy card, the card that becomes the app (lab `envOv` hero, owner 22:35Z; lab siaR3 Q8, owner
 * 11-28), for every deploy target. Settled, it is Serving now: every part labelled, the address with when it went
 * live, the serving version's cells (Version, Commit, Pull request, Deployed), then one receipt line for how it was
 * built. While a deploy runs the cells fold away and the deploy's step tracks and live log band open in their place;
 * when it serves, the log folds back into the receipt line and the address takes the title. A failed deploy keeps the
 * card, its tracks stopped at the failed step, the log's last lines and the cause's way forward in place. One card,
 * one place: nothing is inserted beside it and nothing jumps. Each cell shows only facts the receipt recorded.
 */
export const DeploymentServingReceipt = React.memo(
  function DeploymentServingReceipt(
    props: Readonly<{
      /** Null while the serving receipt still reads: the same card with its cells pending, so it is never inserted later. */
      receipt: DeploymentServingReceiptValue | null;
      /** A newer deploy failed and this one still serves (lab `envFail`): its own word. */
      still: boolean;
      address: Readonly<{
        text: string;
        attention: React.ReactNode;
        actions: React.ReactNode;
      }> | null;
      byYou: boolean;
      phone: boolean;
      onOpenReceipt: () => void;
      /** The deploy running now, or the latest one that failed; null when the card only serves. */
      run?: DeploymentCardRun | null;
      /** The deploy target's name when a platform built it ("Railway"), for the receipt line. */
      platformTitle?: string | null;
    }>,
  ) {
    const { receipt } = props;
    const run = props.run ?? null;
    const timing = resolveInPlaceMorphTiming(useReducedMotionPreference());
    // Only a change of state moves anything: what the card shows at its first paint simply shows.
    const phase = run ? run.kind : 'serving';
    const firstPhase = React.useRef(phase);
    const moved = React.useRef(false);
    if (phase !== firstPhase.current) moved.current = true;
    const entering = moved.current
      ? FadeIn.duration(timing.contentFadeMs).delay(timing.contentDelayMs) : undefined;
    const exiting = moved.current ? FadeOut.duration(timing.coveredFadeMs) : undefined;
    const settledAt = receipt ? deploymentReceiptAtMs(receipt.deployment) : null;
    const facts = receipt && settledAt !== null ? servingCells(receipt, props.byYou, settledAt) : pendingServingCells();
    const built = !run && !props.still && receipt ? receiptLine(receipt, props.platformTitle ?? null) : null;
    // With nothing serving, the deploy is the card's title (lab siaR3 q8a/q8c); while something serves, its address is.
    const runLeads = run !== null && !props.address;
    return (
      <View
        style={styles.card}
        testID="project-deployments.environment.serving.card"
      >
        <View style={styles.top}>
          {/* What leads the card changes in place with one cross-fade: the deploy while it is the news, then the
              address it went live at (lab siaR3 Q8: the address takes the title). */}
          <WordCrossFade wordKey={runLeads ? `${run.kind}:${run.title}` : `serving:${props.address?.text ?? ''}`}
            durationMs={motionTokens.durationMs.base} style={styles.topText}>
            {runLeads ? <RunTitle run={run} variant="heading" /> : (
              <>
                <Text variant="meta" style={styles.label}>
                  {props.still
                    ? t('projects.deployments.overviewStatus.stillServing')
                    : t('projects.deployments.servingNow')}
                </Text>
                {props.address ? (
                  <>
                    <Text
                      variant="heading" style={styles.primary}
                      numberOfLines={1}
                      testID="project-deployments.environment.live"
                    >
                      {props.address.text}
                    </Text>
                    {props.address.attention ?? (settledAt === null ? null :
                      <Text variant="meta" style={styles.secondary}>
                        {t('projects.deployments.overviewStatus.liveSince', {
                          when: formatAsOfTime(settledAt),
                        })}
                      </Text>
                    )}
                  </>
                ) : null}
              </>
            )}
          </WordCrossFade>
          {runLeads && !props.phone ? <RunActions run={run} /> : null}
          {props.address && !props.phone ? props.address.actions : null}
        </View>
        {props.address && props.phone ? (
          <View style={styles.phoneActions}>{props.address.actions}</View>
        ) : runLeads && props.phone ? (
          <View style={styles.phoneActions}><RunActions run={run} /></View>
        ) : null}
        {run ? (
          <Reanimated.View key="run" entering={entering} exiting={exiting} testID="project-deployments.environment.run"
            accessibilityLiveRegion="polite">
            {runLeads ? null : (
              <View style={styles.runLine}>
                <RunTitle run={run} variant="label" />
                {props.phone ? null : <RunActions run={run} />}
              </View>
            )}
            {!runLeads && props.phone ? <View style={styles.phoneActions}><RunActions run={run} /></View> : null}
            {run.steps.length > 0 ? (
              <View style={styles.tracks}>
                <DeploymentStepStrip variant="full" narrow={props.phone} steps={run.steps}
                  testID="project-deployments.environment.run.steps" />
              </View>
            ) : null}
            {run.band(styles.band)}
          </Reanimated.View>
        ) : (
          <Reanimated.View key="serving" entering={entering} exiting={exiting}>
            <HappierPressable
              accessibilityRole="button"
              accessibilityLabel={t(
                'projects.deployments.overviewStatus.openReceipt',
              )}
              testID="project-deployments.environment.serving.receipt"
              disabled={!receipt}
              onPress={props.onOpenReceipt}
              // Without an address (a database) the facts are what serves: they follow the label directly, never a rule
              // under an empty heading (PAGE-ACCEPT-176 R3-D9).
              style={props.address ? styles.part : styles.firstPart}
            >
              <FactStrip
                testID="project-deployments.environment.serving.cells"
                layout="columns"
                narrow={props.phone}
                // A phone leads with the commit, whole width, then two cells to a row (lab `envOvp`).
                facts={
                  props.phone
                    ? [
                        ...facts.filter((fact) => fact.wide),
                        ...facts.filter((fact) => !fact.wide),
                      ]
                    : facts
                }
              />
            </HappierPressable>
            {built ? (
              // The log folded into one line (lab siaR3 `r3-rcpt`): what the deploy did, how it was built, and its log.
              <View style={styles.receiptLine} testID="project-deployments.environment.serving.built">
                {built.glyph ? <WorkStatusGlyph status={built.glyph} testIDSuffix="deployment-serving-built" /> : null}
                <Text variant="meta" numberOfLines={1} style={styles.receiptText}>{`${built.text} ·`}</Text>
                <TextLinkButton testID="project-deployments.environment.serving.log" tone="quiet" size="meta"
                  label={t('projects.deployments.deployLog')} onPress={props.onOpenReceipt} />
              </View>
            ) : null}
          </Reanimated.View>
        )}
      </View>
    );
  },
);

/** The deploy's title, then its cause or commit; elapsed time ticks only while it runs and is shown. */
function RunTitle(props: Readonly<{ run: DeploymentCardRun; variant: 'heading' | 'label' }>) {
  const { run } = props;
  const failed = run.kind === 'failed';
  return (
    <View style={styles.runTitle}>
      <Text variant={props.variant} emphasis={props.variant === 'label' ? 'semiBold' : undefined} numberOfLines={1}
        style={failed ? styles.failed : styles.primary} testID="project-deployments.environment.run.title">
        {run.title}
      </Text>
      {run.lead || (run.kind === 'running' && run.startedAtMs !== null) ? (
        <Text variant="meta" numberOfLines={2} style={styles.secondary}>
          {run.lead}
          {run.kind === 'running' && run.startedAtMs !== null ? (
            <RunElapsed startedAtMs={run.startedAtMs} separated={run.lead !== null} />
          ) : null}
        </Text>
      ) : null}
    </View>
  );
}

/** The time the running deploy has taken, in tabular figures so it never shifts as it counts. */
function RunElapsed(props: Readonly<{ startedAtMs: number; separated: boolean }>) {
  const seconds = useElapsedTime(props.startedAtMs);
  return (
    <Text variant="meta" style={styles.elapsed} testID="project-deployments.environment.run.elapsed">
      {`${props.separated ? ' · ' : ''}${formatElapsedDuration(seconds * 1000)}`}
    </Text>
  );
}

function RunActions(props: Readonly<{ run: DeploymentCardRun }>) {
  const { action, secondaryAction } = props.run;
  return (
    <View style={styles.runActions}>
      {secondaryAction ? (
        <RoundButton testID={secondaryAction.testID} size="small" display="secondary"
          title={secondaryAction.label} onPress={secondaryAction.onPress} />
      ) : null}
      <RoundButton testID={action.testID} size="small"
        // The cause's own fix leads; opening the receipt never competes with the page's Deploy.
        {...(props.run.kind === 'failed' && secondaryAction ? {} : { display: 'secondary' as const })}
        title={action.label} onPress={action.onPress} />
    </View>
  );
}

/**
 * The receipt line under the serving cells: whether every step passed, then what the target built (the services a
 * machine built images for, or the platform that built it). Nothing when the receipt recorded neither.
 */
function receiptLine(receipt: DeploymentServingReceiptValue, platformTitle: string | null) {
  const steps = receipt.content.steps;
  const caption = deploymentStepCaption(steps);
  const builtServices = receipt.content.images.filter((image) => image.registryReference === undefined)
    .map((image) => image.service);
  const parts = [
    caption,
    builtServices.length > 0
      ? t('projects.deployments.overviewStatus.builtServices', { services: [...new Set(builtServices)].join(', ') })
      : platformTitle ? t('projects.deployments.overviewStatus.builtOn', { platform: platformTitle }) : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  const passed = steps.length > 0 && steps.every((step) => step.state === 'succeeded');
  return {
    text: parts.join(' · '),
    glyph: passed ? deploymentStepWorkStatus(steps[steps.length - 1]!) : null,
  };
}

/** The cells every serving receipt has (Version, Deployed), pending as the facts strip's pending cells are. */
function pendingServingCells(): FactStripFact[] {
  return [
    { key: 'version', testID: 'project-deployments.environment.serving.cells.version',
      label: t('projects.deployments.overviewStatus.cellVersion'), value: '—' },
    { key: 'deployed', testID: 'project-deployments.environment.serving.cells.deployed',
      label: t('projects.deployments.overviewStatus.cellDeployed'), value: '—' },
  ];
}

function servingCells(
  receipt: DeploymentServingReceiptValue,
  byYou: boolean,
  settledAt: number,
): FactStripFact[] {
  const { content, deployment, facts } = receipt;
  const revision = facts.source ? deploymentRevisionLabel(facts.source) : null;
  const kept = facts.retainedRollbackTarget;
  const cells: FactStripFact[] = [];
  if (revision)
    cells.push({
      key: 'version',
      testID: 'project-deployments.environment.serving.cells.version',
      label: t('projects.deployments.overviewStatus.cellVersion'),
      value: revision,
      ...(kept
        ? {
            detail: t('projects.deployments.overviewStatus.keptVersion', {
              version: deploymentRevisionLabel(kept.revision),
            }),
          }
        : {}),
    });
  if (facts.commitSubject)
    cells.push({
      key: 'commit',
      wide: true,
      label: t('projects.deployments.overviewStatus.cellCommit'),
      value: facts.commitSubject,
      ...(byYou ? { detail: t('projects.deployments.byYou') } : {}),
    });
  const pullRequest =
    content.sourceIntent?.kind === 'repository'
      ? content.sourceIntent.pullRequestHead?.number
      : undefined;
  if (pullRequest !== undefined)
    cells.push({
      key: 'pullRequest',
      label: t('projects.deployments.overviewStatus.cellPullRequest'),
      value: `#${pullRequest}`,
    });
  const duration = deploymentDurationMs(deployment);
  cells.push({
    key: 'deployed',
    testID: 'project-deployments.environment.serving.cells.deployed',
    label: t('projects.deployments.overviewStatus.cellDeployed'),
    value: formatRelativeTime(settledAt),
    ...(duration !== null
      ? {
          detail: t('projects.deployments.took', {
            duration: formatElapsedDuration(duration),
          }),
        }
      : {}),
  });
  return cells;
}

const styles = StyleSheet.create((theme) => ({
  // Serving now is one card with one padding all round (pfc-redesign r4 dEnvOv REFINE 2, owner 22:35Z).
  card: { padding: PAGE_LIST_METRICS.cardPaddingPx, minWidth: 0 },
  top: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s16 },
  topText: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  phoneActions: { marginTop: theme.space.s8, flexDirection: 'row' },
  label: { color: theme.colors.text.tertiary },
  primary: { color: theme.colors.text.primary },
  secondary: { color: theme.colors.text.secondary },
  failed: { color: theme.colors.state.danger.textForeground },
  elapsed: { color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'] },
  // Equal space before and after every rule (lab: one inset all round, 12 between parts).
  part: {
    marginTop: theme.space.s12,
    paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  firstPart: { marginTop: theme.space.s8 },
  runLine: {
    flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.s16,
    marginTop: theme.space.s12, paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.subtle,
  },
  runTitle: { flex: 1, minWidth: 0, gap: theme.space.s2 },
  runActions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  tracks: { marginTop: theme.space.s16 },
  // The log is the card's floor (lab siaR3 `r3-log`): edge to edge under the tracks, to the card's bottom corners.
  band: {
    marginTop: theme.space.s16,
    marginHorizontal: -PAGE_LIST_METRICS.cardPaddingPx,
    marginBottom: -PAGE_LIST_METRICS.cardPaddingPx,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
    // Its bottom corners follow the sheet's, so the band never paints square corners over the rounded card.
    borderBottomLeftRadius: GROUPED_SURFACE_RADIUS_PX,
    borderBottomRightRadius: GROUPED_SURFACE_RADIUS_PX,
    overflow: 'hidden',
  },
  receiptLine: {
    flexDirection: 'row', alignItems: 'center', gap: theme.space.s6,
    marginTop: theme.space.s12, paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.subtle,
  },
  receiptText: { color: theme.colors.text.secondary, flexShrink: 1 },
}));
