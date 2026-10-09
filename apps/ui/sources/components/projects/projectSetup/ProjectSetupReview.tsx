import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { describeProjectCommandSource } from './projectScriptPresentation';
import {
  listReviewedSetupCommands,
  readProjectSetupReviewPresentation,
  type ProjectSetupReviewPresentation,
} from './projectSetupEffectPresentation';

export type ProjectSetupScope = 'thisTime' | 'untilChanged';

type EffectLine = Readonly<{
  key: string;
  label: string;
  value: string;
  note?: string;
  mono: boolean;
  /** Safe producer identity for U5's personal/shared binding presentation. */
  binding?: ProjectSetupReviewPresentation['bindings'][number];
}>;

/** The exact declared setup effect, in run order (lab `s-scripts` SETUP: Tools, Step N, Values). */
export function listProjectSetupEffect(
  manifest: ProjectManifestV1,
  reviewedEffect?: unknown,
): readonly EffectLine[] {
  const lines: EffectLine[] = [];
  const environment = manifest.environment;
  if (environment && environment.kind !== 'host') {
    const tool =
      environment.kind === 'toolchain'
        ? environment.tool
        : environment.adapter.localId;
    lines.push({
      key: 'tools',
      label: t('projects.scripts.setup.tools'),
      value: tool,
      mono: true,
      ...(environment.configPath ? { note: environment.configPath } : {}),
    });
  }
  // The producer's resolved effect (B9 `reviewedEffect`) wins over the declared anatomy when present:
  // exact executable + args per step, never secret values.
  const resolved = listReviewedSetupCommands(reviewedEffect);
  if (resolved) {
    resolved.forEach((command, index) => {
      lines.push({ key: `step:${index}`, label: t('projects.scripts.setup.step', { n: index + 1 }), value: command, mono: true });
    });
  } else (manifest.workspace?.setup ?? []).forEach((source, index) => {
    lines.push({
      key: `step:${index}`,
      label: t('projects.scripts.setup.step', { n: index + 1 }),
      value: describeProjectCommandSource(source).reference,
      mono: true,
    });
  });
  const presentation = readProjectSetupReviewPresentation(reviewedEffect);
  if (presentation) {
    for (const binding of presentation.bindings) {
      lines.push({
        key: `binding:${binding.name}`,
        label: binding.name,
        value: binding.displayName ?? binding.name,
        note: binding.revision === undefined ? binding.ref : `${binding.ref} · r${binding.revision}`,
        mono: false,
        binding,
      });
    }
    return lines;
  }
  const names = (manifest.environmentVariables ?? []).map(
    (variable) => variable.name,
  );
  if (names.length > 0) {
    lines.push({
      key: 'values',
      label: t('projects.scripts.setup.values'),
      value: names.join(' · '),
      note: t('projects.scripts.setup.valuesNote'),
      mono: false,
    });
  }
  return lines;
}

/**
 * Where the reviewed file came from, as the producer observed it (lab `s-scripts` SETUP: "at a41c9e2
 * on v0.3"). The repository's commit is context, never proof the file is committed: a modified,
 * untracked or unknown file says so.
 */
function describeSetupProvenance(presentation: ProjectSetupReviewPresentation | null): string | null {
  const provenance = presentation?.provenance;
  if (!provenance || provenance.kind === 'unavailable') return null;
  if (provenance.kind === 'nonRepository') return ` · ${t('projects.scripts.setup.provenanceNotRepository')}`;
  const commit = provenance.headCommit?.slice(0, 7);
  const at = commit
    ? provenance.branch
      ? t('projects.scripts.setup.provenanceAtBranch', { commit, branch: provenance.branch })
      : t('projects.scripts.setup.provenanceAt', { commit })
    : null;
  const state = provenance.fileState === 'modified'
    ? t('projects.scripts.setup.provenanceModified')
    : provenance.fileState === 'untracked'
      ? t('projects.scripts.setup.provenanceUntracked')
      : provenance.fileState === 'absent'
        ? t('projects.scripts.setup.provenanceAbsent')
        : t('projects.scripts.setup.provenanceUnknown');
  return [at ? ` ${at}` : '', ` · ${state}`].join('');
}

/**
 * The setup review (plan 20s3, D18) that the Setup row opens into: what runs and as whom, where it
 * came from, the trust scope, then Not now / Run setup. Only a person reviewing here can approve.
 */
export const ProjectSetupReview = React.memo(function ProjectSetupReview(
  props: Readonly<{
    testID: string;
    manifest: ProjectManifestV1;
    machineName: string;
    /** A teammate's shared Machine: name the OS user it runs as (D6/D24). */
    sharedRunAs: string | null;
    pending: boolean;
    onRun: (scope: ProjectSetupScope) => void;
    /** Safe resolved effect from the D18 review, when the producer supplied it. */
    reviewedEffect?: unknown;
    /** A scope the review already carries (an earlier request); the person can still change it. */
    initialScope?: ProjectSetupScope;
    onNotNow: () => void;
    onViewFile: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const [scope, setScope] = React.useState<ProjectSetupScope>(props.initialScope ?? 'untilChanged');
  const effect = React.useMemo(
    () => listProjectSetupEffect(props.manifest, props.reviewedEffect),
    [props.manifest, props.reviewedEffect],
  );
  const provenance = React.useMemo(
    () => describeSetupProvenance(readProjectSetupReviewPresentation(props.reviewedEffect)),
    [props.reviewedEffect],
  );
  const tabs = React.useMemo(
    () => [
      { id: 'thisTime' as const, label: t('projects.scripts.setup.thisTime') },
      {
        id: 'untilChanged' as const,
        label: t('projects.scripts.setup.untilChanged'),
      },
    ],
    [],
  );
  return (
    <View testID={props.testID} style={styles.review}>
      <Text style={[styles.body, { color: theme.colors.text.secondary }]}>
        {t('projects.scripts.setup.lead', { machine: props.machineName })}
      </Text>
      <View
        style={[
          styles.effect,
          {
            borderColor: theme.colors.border.subtle,
            backgroundColor: theme.colors.surface.base,
          },
        ]}
      >
        {effect.map((line, index) => (
          <View
            key={line.key}
            testID={`${props.testID}.effect:${line.key}`}
            style={[
              styles.effectRow,
              index > 0
                ? {
                    borderTopColor: theme.colors.border.subtle,
                    borderTopWidth: StyleSheet.hairlineWidth,
                  }
                : null,
            ]}
          >
            <Text
              style={[
                styles.effectLabel,
                { color: theme.colors.text.tertiary },
              ]}
            >
              {line.label}
            </Text>
            <Text
              style={[
                styles.effectValue,
                { color: theme.colors.text.secondary },
              ]}
            >
              <Text
                style={[
                  line.mono ? styles.mono : styles.body,
                  { color: theme.colors.text.primary },
                ]}
              >
                {line.value}
              </Text>
              {line.note ? `  ${line.note}` : ''}
            </Text>
          </View>
        ))}
      </View>
      <View style={styles.provenance}>
        <Icon name="file-text" size={14} color={theme.colors.text.tertiary} />
        <Text
          style={[
            styles.meta,
            styles.grow,
            { color: theme.colors.text.tertiary },
          ]}
        >
          {t('projects.scripts.setup.from')}{' '}
          <Text
            style={[
              styles.meta,
              styles.mono,
              { color: theme.colors.text.tertiary },
            ]}
          >
            .happier/project.json
          </Text>
          {provenance ? (
            <Text testID={`${props.testID}.provenance`} style={[styles.meta, { color: theme.colors.text.tertiary }]}>
              {provenance}
            </Text>
          ) : null}
        </Text>
        <RoundButton
          size="small"
          display="secondary"
          title={t('projects.scripts.setup.viewFile')}
          testID={`${props.testID}.viewFile`}
          onPress={props.onViewFile}
        />
      </View>
      {props.sharedRunAs ? (
        <View
          testID={`${props.testID}.shared`}
          style={[
            styles.shared,
            { backgroundColor: theme.colors.surface.elevated },
          ]}
        >
          <Icon
            name="user-plus"
            size={16}
            color={theme.colors.text.secondary}
          />
          <Text
            style={[
              styles.body,
              styles.grow,
              { color: theme.colors.text.secondary },
            ]}
          >
            {t('projects.scripts.setup.sharedScope', {
              osUser: props.sharedRunAs,
              machine: props.machineName,
            })}
          </Text>
        </View>
      ) : null}
      <View style={styles.scope}>
        <SegmentedTabBar
          role="radiogroup"
          accessibilityLabel={t('projects.scripts.setup.approve')}
          tabs={tabs}
          activeTabId={scope}
          onSelectTab={setScope}
          segmentSizing="content"
          testIDPrefix={`${props.testID}.scope`}
        />
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.body, { color: theme.colors.text.secondary }]}
        >
          {scope === 'thisTime'
            ? t('projects.scripts.setup.consequenceThisTime')
            : t('projects.scripts.setup.consequenceUntilChanged')}
        </Text>
      </View>
      <View style={styles.actions}>
        <RoundButton
          size="small"
          display="secondary"
          title={t('projects.scripts.setup.notNow')}
          testID={`${props.testID}.notNow`}
          onPress={props.onNotNow}
        />
        <RoundButton
          size="small"
          title={
            props.sharedRunAs
              ? t('projects.scripts.setup.runOn', {
                  machine: props.machineName,
                })
              : t('projects.scripts.setup.run')
          }
          testID={`${props.testID}.run`}
          loading={props.pending}
          disabled={props.pending}
          onPress={() => props.onRun(scope)}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  review: { gap: 14, paddingHorizontal: 16, paddingBottom: 16 },
  body: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
  },
  meta: { ...Typography.default(), ...happierPageTextMetrics('meta') },
  mono: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription') },
  grow: { flex: 1, minWidth: 0 },
  effect: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    overflow: 'hidden',
  },
  effectRow: {
    flexDirection: 'row',
    gap: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  effectLabel: {
    ...Typography.default(),
    ...happierPageTextMetrics('meta'),
    width: 56,
  },
  effectValue: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
    flex: 1,
    minWidth: 0,
  },
  provenance: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shared: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 10,
  },
  scope: { gap: 8, alignItems: 'flex-start' },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    flexWrap: 'wrap',
  },
}));
