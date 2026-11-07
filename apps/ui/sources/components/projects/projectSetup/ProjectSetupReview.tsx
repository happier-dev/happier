import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { GROUPED_SURFACE_RADIUS_PX, PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { resolveThemeCardChromeStyle } from '@/components/ui/surfaces/themeRaisedEdge';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import type { ProjectSetupDecision } from './projectSetupConsentDecision';

import { describeProjectCommandSource } from './projectScriptPresentation';
import {
  listReviewedSetupCommands,
  readProjectSetupReviewPresentation,
  type ProjectSetupReviewPresentation,
} from './projectSetupEffectPresentation';

export type ProjectSetupScope = ProjectSetupDecision;

/** The one-time choice is the default everywhere a setup review is decided; remembering is opt-in. */
export const DEFAULT_PROJECT_SETUP_SCOPE: ProjectSetupScope = 'thisTime';

export function projectSetupRunLabel(machineName: string, sharedRunAs: string | null): string {
  return sharedRunAs ? t('projects.scripts.setup.runOn', { machine: machineName }) : t('projects.scripts.setup.run');
}

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
  const toolchain = manifest.toolchain;
  if (toolchain && toolchain.kind !== 'host') {
    const tool =
      toolchain.kind === 'toolchain'
        ? toolchain.tool
        : toolchain.adapter.localId;
    lines.push({
      key: 'tools',
      label: t('projects.scripts.setup.tools'),
      value: tool,
      mono: true,
      ...(toolchain.configPath ? { note: toolchain.configPath } : {}),
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
        note: [binding.ref, binding.revision === undefined ? null : `r${binding.revision}`,
          t(binding.source === 'personal' ? 'secretsSettings.keepPersonal' : 'secretsSettings.keepShared')].filter(Boolean).join(' · '),
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
 * untracked or unknown file says so, until the producer reports the reviewed bytes as committed.
 */
function describeSetupProvenance(presentation: ProjectSetupReviewPresentation | null): string | null {
  const provenance = presentation?.provenance;
  if (!provenance || provenance.kind === 'unavailable') return null;
  if (provenance.kind === 'nonRepository') return ` · ${t('projects.scripts.setup.provenanceNotRepository')}`;
  // The producer proved the reviewed bytes exist at that commit: the context is the whole statement.
  const committed = provenance.committed?.commit.slice(0, 7);
  const commit = committed ?? provenance.headCommit?.slice(0, 7);
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
  return [at ? ` ${at}` : '', committed ? '' : ` · ${state}`].join('');
}

/** A review of a reviewed effect alone (approval page and card, Session ask): no manifest is read. */
const REVIEWED_EFFECT_ONLY_MANIFEST: ProjectManifestV1 = { version: 1 };

/** Safe review anatomy shared by the page, Session and approvals; the producer projection is the sole parser. */
export const ProjectSetupReviewFacts = React.memo(function ProjectSetupReviewFacts(
  props: Readonly<{
    testID: string;
    /** Omitted when the review is the producer's reviewed effect alone (approvals, Session ask). */
    manifest?: ProjectManifestV1;
    machineName: string;
    /** A teammate's shared Machine: name the OS user it runs as (D6/D24). */
    sharedRunAs: string | null;
    sharedTrustDetail?: string | null;
    /** Safe resolved effect from the D18 review, when the producer supplied it. */
    reviewedEffect?: unknown;
    /** The effect rows on a sheet of their own (the pushed page); on a card they sit on the card. */
    framed?: boolean;
    onViewFile?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const effect = React.useMemo(
    () => listProjectSetupEffect(props.manifest ?? REVIEWED_EFFECT_ONLY_MANIFEST, props.reviewedEffect),
    [props.manifest, props.reviewedEffect],
  );
  const provenance = React.useMemo(
    () => describeSetupProvenance(readProjectSetupReviewPresentation(props.reviewedEffect)),
    [props.reviewedEffect],
  );
  return (
    <View style={styles.facts}>
      <View style={props.framed ? styles.effectSheet : styles.effect}>
        {effect.map((line, index) => (
          <View
            key={line.key}
            testID={`${props.testID}.effect:${line.key}`}
            style={[styles.effectRow, props.framed ? styles.effectSheetRow : null, props.framed && index > 0 ? styles.effectSheetDivider : null]}
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
        {props.onViewFile ? <RoundButton
          size="small"
          display="inverted"
          title={t('projects.scripts.setup.viewFile')}
          testID={`${props.testID}.viewFile`}
          onPress={props.onViewFile}
        /> : null}
      </View>
      {props.sharedRunAs || props.sharedTrustDetail ? (
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
            {props.sharedRunAs ? t('projects.scripts.setup.sharedScope', {
              osUser: props.sharedRunAs,
              machine: props.machineName,
            }) : null}
            {' '}{props.sharedTrustDetail ?? t('machines.terminals.sharedOsDetail', { machine: props.machineName })}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

/** One setup decision control, with the consequence of the current choice (lab `s-scripts` SETUP). */
export const ProjectSetupScopeChoice = React.memo(function ProjectSetupScopeChoice(
  props: Readonly<{ testID: string; scope: ProjectSetupScope; onChange: (scope: ProjectSetupScope) => void }>,
) {
  const { theme } = useUnistyles();
  // A phone has the room for the three choices to share the width; a wide host keeps them compact.
  const phone = useDeviceType() === 'phone';
  const tabs = React.useMemo(() => [
    { id: 'thisTime' as const, label: t('projects.scripts.setup.thisTime') },
    { id: 'untilChanged' as const, label: t('projects.scripts.setup.untilChanged') },
    { id: 'skip' as const, label: t('common.skip') },
  ], []);
  return (
    <View style={[styles.scope, phone ? styles.scopePhone : null]}>
      <SegmentedTabBar
        role="radiogroup"
        accessibilityLabel={t('projects.scripts.setup.approve')}
        tabs={tabs}
        activeTabId={props.scope}
        onSelectTab={props.onChange}
        segmentSizing={phone ? 'equal' : 'content'}
        testIDPrefix={`${props.testID}.scope`}
      />
      <Text
        accessibilityLiveRegion="polite"
        style={[styles.body, { color: theme.colors.text.secondary }]}
      >
        {props.scope === 'thisTime'
          ? t('projects.scripts.setup.consequenceThisTime')
          : props.scope === 'untilChanged' ? t('projects.scripts.setup.consequenceUntilChanged')
          : t('projects.scripts.setup.consequenceSkip')}
      </Text>
    </View>
  );
});

type ProjectSetupReviewBodyProps = Readonly<{
  testID: string;
  manifest: ProjectManifestV1;
  machineName: string;
  sharedRunAs: string | null;
  sharedTrustDetail?: string | null;
  reviewedEffect?: unknown;
  framed?: boolean;
  scope: ProjectSetupScope;
  onScopeChange: (scope: ProjectSetupScope) => void;
  onViewFile: () => void;
}>;

/** What the review says and asks: the lead, the exact effect, where it came from, and the consent choice. */
export const ProjectSetupReviewBody = React.memo(function ProjectSetupReviewBody(props: ProjectSetupReviewBodyProps) {
  const { theme } = useUnistyles();
  return (
    <>
      <Text style={[styles.body, { color: theme.colors.text.secondary }]}>
        {t('projects.scripts.setup.lead', { machine: props.machineName })}
      </Text>
      <ProjectSetupReviewFacts {...props} />
      <ProjectSetupScopeChoice testID={props.testID} scope={props.scope} onChange={props.onScopeChange} />
    </>
  );
});

/**
 * Not now and Run setup. On a card they sit right-aligned under the review; on a pushed page they fill
 * the pinned footer, Run on top (`fill`).
 */
export const ProjectSetupReviewActions = React.memo(function ProjectSetupReviewActions(
  props: Readonly<{
    testID: string;
    scope: ProjectSetupScope;
    machineName: string;
    sharedRunAs: string | null;
    pending: boolean;
    onRun: (scope: ProjectSetupScope) => void;
    onNotNow: () => void;
    fill?: boolean;
  }>,
) {
  const size = props.fill ? 'normal' : 'small';
  const notNow = (
    <RoundButton
      size={size}
      display="inverted"
      title={t('projects.scripts.setup.notNow')}
      testID={`${props.testID}.notNow`}
      onPress={props.onNotNow}
    />
  );
  const run = (
    <RoundButton
      size={size}
      title={props.scope === 'skip' ? t('common.skip') : projectSetupRunLabel(props.machineName, props.sharedRunAs)}
      testID={`${props.testID}.run`}
      loading={props.pending}
      disabled={props.pending}
      onPress={() => props.onRun(props.scope)}
    />
  );
  return props.fill ? (
    <View style={styles.actionsFill}>{run}{notNow}</View>
  ) : (
    <View style={styles.actions}>{notNow}{run}</View>
  );
});

/** The card's review: the body and its actions under one row (desktop, rails and widgets). */
export const ProjectSetupReview = React.memo(function ProjectSetupReview(
  props: Readonly<{
    testID: string;
    manifest: ProjectManifestV1;
    machineName: string;
    sharedRunAs: string | null;
    sharedTrustDetail?: string | null;
    pending: boolean;
    onRun: (scope: ProjectSetupScope) => void;
    reviewedEffect?: unknown;
    /** The chosen scope belongs to the review's owner, so the card and the phone page share it. */
    scope: ProjectSetupScope;
    onScopeChange: (scope: ProjectSetupScope) => void;
    onNotNow: () => void;
    onViewFile: () => void;
  }>,
) {
  const phone = useDeviceType() === 'phone';
  return (
    <View testID={props.testID} style={[styles.review, phone ? styles.reviewPhone : null]}>
      <ProjectSetupReviewBody {...props} />
      <ProjectSetupReviewActions {...props} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  facts: { gap: 14 },
  // The body starts at the row's title column: row inset + leading column + gap (lab SETUP).
  review: {
    gap: 14,
    paddingLeft: PAGE_LIST_METRICS.rowPaddingHorizontalPx + PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx,
    paddingRight: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
    paddingBottom: 16,
  },
  // Phones give the review the whole row: the title column would only narrow the text.
  reviewPhone: { paddingLeft: PAGE_LIST_METRICS.rowPaddingHorizontalPx },
  body: {
    ...Typography.default(),
    ...happierPageTextMetrics('rowDescription'),
  },
  meta: { ...Typography.default(), ...happierPageTextMetrics('meta') },
  mono: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription') },
  grow: { flex: 1, minWidth: 0 },
  // Content only: the parent owns any surface, so the steps read like the Where/Files/As rows.
  effect: { gap: 4 },
  effectRow: { flexDirection: 'row', gap: 12 },
  // The pushed page's effect: the shared card, one row per line (lab SETUPp).
  effectSheet: {
    backgroundColor: theme.colors.edge.cardFill,
    borderRadius: GROUPED_SURFACE_RADIUS_PX,
    ...resolveThemeCardChromeStyle(theme),
  },
  effectSheetRow: { paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx, paddingVertical: theme.space.s12 },
  effectSheetDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border.subtle },
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
  scopePhone: { alignItems: 'stretch' },
  // The pinned footer: Run fills the width, Not now sits quietly under it.
  actionsFill: { alignItems: 'stretch', gap: 8 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    flexWrap: 'wrap',
  },
}));
