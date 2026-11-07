import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentIsolationEffectPlanV1 } from '@happier-dev/protocol/machines/agentIsolationV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/** A row's hint in the row's own words, then the paths it names as mono lines. */
function HintWithPaths(props: Readonly<{ hint: string; paths: readonly string[] }>) {
  return (
    <View>
      <Text style={styles.hint}>{props.hint}</Text>
      {props.paths.map((path) => (
        <Text key={path} style={styles.path}>{path}</Text>
      ))}
    </View>
  );
}

type AgentIsolationEffectPlan = AgentIsolationEffectPlanV1;

/** One effect of a reviewed isolation change, in the person's words. `paths` are the plan's own inventory. */
export type AgentIsolationEffect = Readonly<{
  key: 'policy' | 'after' | 'checkouts' | 'folders' | 'sessions' | 'docker' | 'admin';
  title: string;
  /** The row's short value (on/off) or its count. */
  value?: string;
  count?: number;
  hint?: string;
  paths?: readonly string[];
}>;

/**
 * What a reviewed separate-users change does, from the owner's plan alone: the switch, the state after,
 * checkouts and parent folders it touches, Sessions that restart, Docker and administrator steps. Every
 * review of this change (the held operation, the Security tab, Sharing's offer) says it from here.
 * Docker and the after-state are the readiness contract itself: an isolated agent user is only reported
 * effective once it cannot reach root sudo or the Docker socket.
 */
export function describeAgentIsolationEffects(
  enabled: boolean,
  plan: AgentIsolationEffectPlan,
): readonly AgentIsolationEffect[] {
  const r = 'inbox.actionOperations.isolationReview' as const;
  const effects: AgentIsolationEffect[] = [
    { key: 'policy', title: t(`${r}.policy`), value: enabled ? t(`${r}.turnOn`) : t(`${r}.turnOff`) },
    { key: 'after', title: t(`${r}.after`), hint: !enabled ? t(`${r}.afterOff`)
      : plan.memberProvisioning ? t(`${r}.afterOnMember`) : t(`${r}.afterOn`) },
  ];
  if (plan.roots.length > 0)
    effects.push({ key: 'checkouts', title: t(`${r}.checkouts`), count: plan.roots.length,
      hint: t(`${r}.checkoutsHint`), paths: plan.roots.map((root) => root.path) });
  if (plan.ancestorAcls.length > 0)
    effects.push({ key: 'folders', title: t(`${r}.folders`), count: plan.ancestorAcls.length,
      hint: t(`${r}.foldersHint`), paths: plan.ancestorAcls.map((acl) => acl.path) });
  if (plan.sessionsToReplace > 0)
    effects.push({ key: 'sessions', title: t(`${r}.sessions`), count: plan.sessionsToReplace, hint: t(`${r}.sessionsHint`) });
  if (enabled) effects.push({ key: 'docker', title: t(`${r}.docker`), hint: t(`${r}.dockerHint`) });
  if (plan.requiresAdmin)
    effects.push({ key: 'admin', title: t(`${r}.administrator`), hint: t(`${r}.administratorHint`) });
  return effects;
}

const EFFECT_TEST_IDS: Readonly<Record<AgentIsolationEffect['key'], string>> = {
  policy: 'action-operation-isolation-policy',
  after: 'action-operation-isolation-after',
  checkouts: 'action-operation-isolation-checkouts',
  folders: 'action-operation-isolation-folders',
  sessions: 'action-operation-isolation-sessions',
  docker: 'action-operation-isolation-docker',
  admin: 'action-operation-isolation-admin',
};

/** The reviewed effects as one section: each effect a row, the plan's references as technical facts. */
export function AgentIsolationEffectsGroup(
  props: Readonly<{
    enabled: boolean;
    plan: AgentIsolationEffectPlan;
    metadataVersion: number;
    /** A review opened in place names its Machine in the title; the operation detail names it in its Details row. */
    title?: string;
    testID?: string;
  }>,
) {
  // A titled review already says which way it turns; the switch row would repeat it.
  const effects = describeAgentIsolationEffects(props.enabled, props.plan)
    .filter((effect) => !props.title || effect.key !== 'policy');
  return (
    <ItemGroup
      testID={props.testID}
      title={props.title ?? t('inbox.actionOperations.isolationReview.title')}
      description={
        props.enabled
          ? t('inbox.actionOperations.isolationReview.descriptionOn')
          : t('inbox.actionOperations.isolationReview.descriptionOff')
      }
    >
      {effects.map((effect) => (
        <Item
          key={effect.key}
          testID={EFFECT_TEST_IDS[effect.key]}
          mode="info"
          title={effect.title}
          {...(effect.value ? { detail: effect.value } : {})}
          {...(effect.count !== undefined ? { titleMeta: String(effect.count) } : {})}
          {...(effect.hint
            ? effect.paths
              ? { subtitle: <HintWithPaths hint={effect.hint} paths={effect.paths} /> }
              : { subtitle: effect.hint, subtitleLines: 0 }
            : {})}
        />
      ))}
      <TechnicalDetailsDisclosure
        testID="action-operation-isolation-technical-details"
        title={t('approvals.technicalDetails')}
        lines={[
          {
            key: 'plan-digest',
            label: t('inbox.actionOperations.isolationReview.planDigest'),
            value: props.plan.planDigest,
          },
          {
            key: 'metadata-version',
            label: t('inbox.actionOperations.isolationReview.metadataVersion'),
            value: String(props.metadataVersion),
          },
        ]}
      />
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  hint: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
  path: { ...Typography.variant('meta'), ...Typography.mono(), color: theme.colors.text.secondary },
}));
