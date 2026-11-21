import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import {
  projectSharedSetupChangeRowsV1,
  type ProjectSharedSetupChangeRowV1,
} from '@happier-dev/protocol/projects/projectSetupChangeV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { Modal } from '@/modal';
import type { CustomModalChromeCardConfig, CustomModalInjectedProps } from '@/modal/types';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { readProjectSetupLayers } from './projectSetupLayers';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import {
  listProjectSetupEffect,
  ProjectSetupEffectLines,
  DEFAULT_PROJECT_SETUP_SCOPE,
  ProjectSetupScopeChoice,
  type ProjectSetupScope,
} from './ProjectSetupReview';
import type {
  ProjectSharedSetupUpdateDecision,
  ProjectSharedSetupUpdateDecisionResult,
  ProjectSharedSetupUpdateRequest,
} from './projectSetupConsentDecision';
import { useProjectSharedSetupReview } from './useProjectSharedSetupReview';
import { useProjectSetupRow } from './useProjectSetupRow';
import type { ProjectSharedSetupReviewSnapshot } from './projectSharedSetupReview';

type Decide = (
  request: ProjectSharedSetupUpdateRequest,
  decision: ProjectSharedSetupUpdateDecision,
) => Promise<ProjectSharedSetupUpdateDecisionResult | null>;

export type ProjectSharedSetupUpdateInput = Readonly<{
  workspace: WorkspaceAddressV1;
  binding: ServerCredentialAccountScopeBinding;
  sourceId: string;
  sourceName: string | null;
  machineName: string;
  decide: Decide;
  /** A shared setup the Project has but this checkout has not taken yet: the same review, for first use. */
  pending?: boolean;
}>;

/**
 * The sheet's title band: "Setup changed" once the review shows changes (lab L6 updateSheet). Before
 * that the sheet does not know yet, so it names what it checks. The subtitle keeps a slot for who
 * changed it and when, which the accepted-revision owner does not expose yet (owed to TS-IMPL-A).
 */
function sharedSetupUpdateChrome(sourceName: string | null, changed: boolean, pending = false): CustomModalChromeCardConfig {
  const name = sourceName ?? t('projects.scripts.layers.sharedUnnamed');
  return {
    kind: 'card',
    material: 'solid',
    // First use names the offer, not a change to a copy the person never took (lab L6 "Use a shared setup").
    title: pending ? t('projects.scripts.sharedUpdate.titlePending')
      : changed ? t('projects.scripts.sharedUpdate.titleChanged') : t('projects.scripts.sharedUpdate.title'),
    subtitle: changed && !pending ? [name, t('projects.scripts.sharedUpdate.usingReviewed')].join(' · ') : name,
    subtitleLines: 1,
    testID: 'project-shared-setup-update',
    scrollHost: 'bounded',
    dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.86, size: 'lg' },
    phonePresentation: 'sheet',
  };
}

/** The change rows of a ready, changed review; empty for every other state. */
export function readProjectSharedSetupUpdateRows(snapshot: ProjectSharedSetupReviewSnapshot | null) {
  const change = snapshot?.kind === 'ready' ? snapshot.change : null;
  return change?.kind === 'changed' ? projectSharedSetupChangeRowsV1(change.before, change.after) : [];
}

/** "Check for changes" on a shared setup (lab L6 updateSheet): the review is read only when the person asks. */
export function openProjectSharedSetupUpdate(
  input: ProjectSharedSetupUpdateInput,
) {
  Modal.show({
    component: ProjectSharedSetupUpdateModal,
    props: input,
    chrome: sharedSetupUpdateChrome(input.sourceName, false, input.pending),
  });
}

function ProjectSharedSetupUpdateModal(
  props: CustomModalInjectedProps & ProjectSharedSetupUpdateInput,
) {
  const row = useProjectSetupRow(props.workspace);
  return row ? (
    <ProjectSharedSetupUpdateBody {...props} row={row} />
  ) : (
    <View style={styles.body}>
      <AttentionBanner
        testID="project-shared-setup-update.unavailable"
        tone="warning"
        title={t('projects.scripts.sharedUpdate.unavailable')}
      />
    </View>
  );
}

function ProjectSharedSetupUpdateBody(
  props: CustomModalInjectedProps &
    ProjectSharedSetupUpdateInput &
    Readonly<{
      row: Readonly<{
        projectRef: ProjectSharedSetupUpdateRequest['projectRef'];
        expectedRevision: ProjectSharedSetupUpdateRequest['expectedRevision'];
      }>;
    }>,
) {
  const review = useProjectSharedSetupReview(props.workspace, props.binding, {
    projectRef: props.row.projectRef,
    expectedRevision: props.row.expectedRevision,
    sourceId: props.sourceId,
  });
  const controller = review.controller;
  // Opening the sheet is the demand; nothing reads the upstream setup before it.
  React.useEffect(() => {
    void controller?.refresh();
  }, [controller]);
  const [scope, setScope] = React.useState<ProjectSetupScope>(
    DEFAULT_PROJECT_SETUP_SCOPE,
  );
  const [busy, setBusy] =
    React.useState<ProjectSharedSetupUpdateDecision | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const snapshot = review.snapshot;
  const request = snapshot?.kind === 'ready' ? snapshot.request : null;
  const rows = React.useMemo(() => readProjectSharedSetupUpdateRows(snapshot), [snapshot]);
  const changed = snapshot?.kind === 'ready' && snapshot.change.kind === 'changed';
  useModalCardChrome(props.setChrome, React.useMemo(() => sharedSetupUpdateChrome(props.sourceName, changed, props.pending),
    [props.sourceName, changed, props.pending]));
  const { decide, onClose } = props;
  const choose = React.useCallback(
    async (decision: ProjectSharedSetupUpdateDecision) => {
      if (!request) return;
      setBusy(decision);
      setFailure(null);
      const result = await decide(request, decision);
      setBusy(null);
      if (!result) return;
      if (result.kind === 'unavailable') {
        setFailure(result.code);
        return;
      }
      onClose();
    },
    [decide, onClose, request],
  );
  return (
    <ProjectSharedSetupUpdateView
      snapshot={review.snapshot}
      rows={rows}
      sourceName={props.sourceName}
      machineName={props.machineName}
      pending={props.pending}
      scope={scope}
      onScopeChange={setScope}
      busy={busy}
      failure={failure}
      onRetry={() => { void controller?.refresh(); }}
      onDecide={(decision) => { void choose(decision); }}
      onClose={onClose}
    />
  );
}

/** What the update sheet shows for one review state; the specimen mounts it with fixture reviews. */
export function ProjectSharedSetupUpdateView(props: Readonly<{
  snapshot: ProjectSharedSetupReviewSnapshot | null;
  rows: readonly ProjectSharedSetupChangeRowV1[];
  sourceName: string | null;
  machineName: string;
  pending?: boolean;
  scope: ProjectSetupScope;
  onScopeChange: (scope: ProjectSetupScope) => void;
  busy: ProjectSharedSetupUpdateDecision | null;
  failure: string | null;
  onRetry: () => void;
  onDecide: (decision: ProjectSharedSetupUpdateDecision) => void;
  onClose: () => void;
}>) {
  const { theme } = useUnistyles();
  const { snapshot, scope, busy, failure, rows } = props;
  const change = snapshot?.kind === 'ready' ? snapshot.change : null;
  const request = snapshot?.kind === 'ready' ? snapshot.request : null;
  const name = props.sourceName ?? t('projects.scripts.layers.sharedUnnamed');
  // What will run once the person takes the update, each line naming its layer (lab "After the change").
  const after = change?.kind === 'changed' ? change.after : null;
  const afterLines = React.useMemo(() => after ? listProjectSetupEffect(after.effectiveManifest ?? EMPTY_MANIFEST, undefined,
    { layerOf: readProjectSetupLayers(after, props.sourceName).layerOf, services: true }) : [], [after, props.sourceName]);

  let content: React.ReactNode;
  if (!snapshot || snapshot.kind === 'initial') {
    content = (
      <ItemGroup surface="none">
        <Item
          mode="info"
          testID="project-shared-setup-update.checking"
          showChevron={false}
          title={t('projects.scripts.sharedUpdate.checking', { name })}
        />
      </ItemGroup>
    );
  } else if (
    snapshot.kind === 'unavailable' ||
    change?.kind === 'upstreamUnavailable'
  ) {
    content = (
      <AttentionBanner
        testID="project-shared-setup-update.unreadable"
        tone="warning"
        title={t('projects.scripts.sharedUpdate.unreadable')}
        description={props.pending ? undefined : t('projects.scripts.sharedUpdate.keepsReviewed')}
        action={{
          label: t('common.retry'),
          onPress: props.onRetry,
        }}
      />
    );
  } else if (change?.kind === 'current') {
    content = (
      <ItemGroup surface="none">
        <Item
          mode="info"
          testID="project-shared-setup-update.current"
          showChevron={false}
          title={t('projects.scripts.sharedUpdate.current', { name })}
        />
      </ItemGroup>
    );
  } else {
    content = (
      <>
        {rows.length > 0 ? (
          <ItemGroup
            title={props.pending ? t('projects.scripts.sharedUpdate.pendingAdds') : t('projects.scripts.sharedUpdate.whatChanged')}
            testID="project-shared-setup-update.changes"
          >
            {rows.map((entry, index) => (
              <ChangeRow
                key={`${entry.entry}:${entry.key}`}
                entry={entry}
                showDivider={index < rows.length - 1}
              />
            ))}
          </ItemGroup>
        ) : null}
        <ItemGroup
          surface="none"
          title={props.pending ? t('projects.scripts.sharedUpdate.pendingRuns') : t('projects.scripts.sharedUpdate.after')}
          description={t('projects.scripts.sharedUpdate.afterDescription', { machine: props.machineName })}
          testID="project-shared-setup-update.after"
        >
          <ProjectSetupEffectLines testID="project-shared-setup-update.after" lines={afterLines} framed />
        </ItemGroup>
        {failure ? (
          <AttentionBanner
            testID="project-shared-setup-update.failure"
            tone="danger"
            title={t('projects.scripts.sharedUpdate.failed')}
            details={[failure]}
          />
        ) : null}
        {/* The choice stands on the sections' edge, so the group owns its inset. */}
        <ItemGroup surface="none" testID="project-shared-setup-update.choice">
          <ProjectSetupScopeChoice
            testID="project-shared-setup-update"
            scope={scope}
            onChange={props.onScopeChange}
            allowSkip={false}
          />
        </ItemGroup>
      </>
    );
  }
  const decidable = request !== null;
  return (
    <View style={styles.body}>
      {/* The lab draws the sheet's sections with page anatomy (as Share setup): description above, hairline rows. */}
      <ListPresentationProvider value="page">{content}</ListPresentationProvider>
      {/* Lab L6-updateSheet: what nothing-runs-yet means sits beside the decision it qualifies. */}
      <View style={styles.footer}>
      {decidable ? (
        <View style={styles.note}>
          <Icon name="lock" size={14} color={theme.colors.text.tertiary} />
          <Text variant="meta" style={[styles.noteText, { color: theme.colors.text.secondary }]}>
            {props.pending ? t('projects.scripts.sharedUpdate.nothingRunsPending') : t('projects.scripts.sharedUpdate.nothingRuns')}
          </Text>
        </View>
      ) : null}
      <View style={styles.actions}>
        <RoundButton
          size="normal"
          display="secondary"
          testID="project-shared-setup-update.keep"
          title={
            !decidable ? t('common.close')
              : props.pending ? t('projects.scripts.sharedUpdate.notNow') : t('projects.scripts.sharedUpdate.keep')
          }
          disabled={busy !== null}
          onPress={() => {
            if (decidable) props.onDecide('keep');
            else props.onClose();
          }}
        />
        {decidable ? (
          <RoundButton
            size="normal"
            testID="project-shared-setup-update.use"
            title={props.pending ? t('projects.scripts.sharedUpdate.usePending') : t('projects.scripts.sharedUpdate.use')}
            loading={busy !== null && busy !== 'keep'}
            disabled={busy !== null}
            onPress={() => {
              props.onDecide(scope === 'skip' ? 'thisTime' : scope);
            }}
          />
        ) : null}
      </View>
      </View>
    </View>
  );
}

type ChangeOp = ProjectSharedSetupChangeRowV1['op'];
const OP_ICON: Record<ChangeOp, 'plus' | 'minus' | 'pencil-simple'> = {
  added: 'plus',
  removed: 'minus',
  changed: 'pencil-simple',
};

/** What runs, in words a command reader recognises: a literal command, or its native target. */
function commandText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.command === 'string') return record.command;
  if (record.kind === 'native' && typeof record.target === 'string')
    return record.target;
  return 'source' in record ? commandText(record.source) : null;
}

function changeTitle(entry: ProjectSharedSetupChangeRowV1): string {
  switch (entry.entry) {
    case 'step': {
      const n = Number(entry.key.split(':')[1] ?? 0) + 1;
      return entry.phase === 'setup'
        ? t('projects.scripts.setup.step', { n })
        : t('projects.scripts.sharedUpdate.teardownStep', { n });
    }
    case 'login':
      return t('projects.scripts.setup.tools');
    case 'input':
      return t('projects.scripts.sharedUpdate.inputs');
    case 'tool':
      return t('projects.scripts.sharedUpdate.devcontainer');
    case 'env':
      return t('projects.scripts.sharedUpdate.env', { name: entry.key });
    case 'ports':
      return t('projects.scripts.sharedUpdate.ports');
    case 'script':
      return t('projects.scripts.sharedUpdate.script', { name: entry.key });
    case 'service':
      return t('projects.scripts.sharedUpdate.service', { name: entry.key });
  }
}

/** The row's second line: the command (mono) when the entry runs one, else the change in words. */
function changeDetail(entry: ProjectSharedSetupChangeRowV1): Readonly<{ text: string; command: boolean }> {
  const before = entry.op === 'added' ? null : commandText(entry.before);
  const after = entry.op === 'removed' ? null : commandText(entry.after);
  if (entry.op === 'changed')
    return before && after && before !== after
      ? { text: `${before} → ${after}`, command: true }
      : { text: t('projects.scripts.sharedUpdate.changedDetail'), command: false };
  const command = entry.op === 'added' ? after : before;
  return command ? { text: command, command: true }
    : { text: t(entry.op === 'added' ? 'projects.scripts.sharedUpdate.addedDetail' : 'projects.scripts.sharedUpdate.removedDetail'), command: false };
}

const ChangeRow = React.memo(function ChangeRow(
  props: Readonly<{
    entry: ProjectSharedSetupChangeRowV1;
    showDivider: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const title = changeTitle(props.entry);
  const detail = changeDetail(props.entry);
  return (
    <Item
      testID={`project-shared-setup-update.change:${props.entry.entry}:${props.entry.key}`}
      // The +, − and ~ marks are glyphs; the row says added, removed or changed in words for screen readers.
      accessibilityLabel={`${t(`projects.scripts.sharedUpdate.op.${props.entry.op}`)}, ${title}, ${detail.text}`}
      icon={
        <Icon
          name={OP_ICON[props.entry.op]}
          size={16}
          color={theme.colors.text.secondary}
        />
      }
      title={title}
      subtitle={detail.text}
      subtitleStyle={detail.command ? styles.command : undefined}
      // A changed command shows both sides whole; the part that changed is usually at the end.
      subtitleLines={3}
      showChevron={false}
      showDivider={props.showDivider}
    />
  );
});

/** A review with no manifest left lists nothing; the effect owner reads a manifest. */
const EMPTY_MANIFEST = { version: 1 } as const;

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s16, paddingBottom: theme.space.s8 },
  // The footer stands on the sections' text edge, as Share setup's does.
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s12,
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
  },
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexGrow: 1, flexShrink: 1, flexBasis: 240 },
  command: { ...Typography.mono(), ...happierPageTextMetrics('rowDescription') },
  noteText: { flex: 1, minWidth: 0 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
}));
