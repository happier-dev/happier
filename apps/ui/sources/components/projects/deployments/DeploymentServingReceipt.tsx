import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { DeploymentStepV1 } from '@happier-dev/deployment-protocol/v1';

import { FactStrip, type FactStripFact } from '@/components/ui/lists/FactStrip';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { DeploymentStepStrip } from './DeploymentStepStrip';
import {
  deploymentDurationMs,
  deploymentReceiptAtMs,
  deploymentRevisionLabel,
  deploymentSourceLabel,
} from './deploymentPresentation';
import type { useDeploymentReceipt } from './useDeploymentReads';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

export type DeploymentServingReceiptValue = NonNullable<
  ReturnType<typeof useDeploymentReceipt>['snapshot']['value']
>;

/**
 * Serving now (lab `envOv` hero, owner 22:35Z): every part labelled. The address with when it went live, then the
 * serving version's cells (Version, Commit, Pull request, Deployed), then the last deploy's steps when it is the
 * one that serves. One card inset all round and equal rules between the parts. Each cell shows only facts the
 * receipt recorded; a cell the receipt has nothing for drops out.
 */
export const DeploymentServingReceipt = React.memo(
  function DeploymentServingReceipt(
    props: Readonly<{
      receipt: DeploymentServingReceiptValue;
      /** A newer deploy failed and this one still serves (lab `envFail`): its own word, and no step strip. */
      still: boolean;
      address: Readonly<{
        text: string;
        attention: React.ReactNode;
        actions: React.ReactNode;
      }> | null;
      byYou: boolean;
      phone: boolean;
      onOpenReceipt: () => void;
    }>,
  ) {
    const { receipt } = props;
    const header = receipt.deployment;
    const settledAt = deploymentReceiptAtMs(header);
    const facts = servingCells(receipt, props.byYou, settledAt);
    const steps: readonly DeploymentStepV1[] = props.still
      ? []
      : receipt.content.steps;
    return (
      <View
        style={styles.card}
        testID="project-deployments.environment.serving.card"
      >
        <View style={styles.top}>
          <View style={styles.topText}>
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
                {props.address.attention ?? (
                  <Text variant="meta" style={styles.secondary}>
                    {t('projects.deployments.overviewStatus.liveSince', {
                      when: formatAsOfTime(settledAt),
                    })}
                  </Text>
                )}
              </>
            ) : null}
          </View>
          {props.address && !props.phone ? props.address.actions : null}
        </View>
        {props.address && props.phone ? (
          <View style={styles.phoneActions}>{props.address.actions}</View>
        ) : null}
        <HappierPressable
          accessibilityRole="button"
          accessibilityLabel={t(
            'projects.deployments.overviewStatus.openReceipt',
          )}
          testID="project-deployments.environment.serving.receipt"
          onPress={props.onOpenReceipt}
          style={styles.part}
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
        {steps.length > 0 ? (
          <View style={styles.part}>
            <Text variant="meta" style={styles.label}>
              {t('projects.deployments.overviewStatus.lastDeploySteps', {
                count: steps.length,
              })}
            </Text>
            <View style={styles.strip}>
              <DeploymentStepStrip
                variant={props.phone ? 'compact' : 'full'}
                captioned
                steps={steps}
                testID="project-deployments.environment.serving.steps"
              />
            </View>
          </View>
        ) : null}
      </View>
    );
  },
);

function servingCells(
  receipt: DeploymentServingReceiptValue,
  byYou: boolean,
  settledAt: number,
): FactStripFact[] {
  const { content, deployment, facts } = receipt;
  const revision = deploymentSourceLabel(content);
  const kept = facts.retainedRollbackTarget;
  const cells: FactStripFact[] = [];
  if (revision)
    cells.push({
      key: 'version',
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
  if (content.commitSubject)
    cells.push({
      key: 'commit',
      wide: true,
      label: t('projects.deployments.overviewStatus.cellCommit'),
      value: content.commitSubject,
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
  // Equal space before and after every rule (lab: one inset all round, 12 between parts).
  part: {
    marginTop: theme.space.s12,
    paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  strip: { marginTop: theme.space.s6 },
}));
