import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { StorageItemV1 } from '@happier-dev/protocol/storage/storageV1';
import type { WidgetSizeV1 } from '@happier-dev/protocol/widgets';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readResourceProposalApproval } from '@/components/approvals/resourceProposal/readResourceProposalApproval';
import { resolveResourceProposalLabels } from '@/components/approvals/resourceProposal/resourceProposalLabels';
import type { ResourceProposalRow } from '@/components/approvals/resourceProposal/resourceProposalPresentation';
import {
  useResourceProposalCheck,
  type ResourceProposalController,
} from '@/components/approvals/resourceProposal/useResourceProposalCheck';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';
import { useStorageCollect } from '@/components/machines/storage/StorageCollectToggle';
import { StorageItemRow, StorageVerdictPill } from '@/components/machines/storage/StorageItemRow';
import { describeStorageVerdict, storageReasonLabel, storageEvidenceLabel } from '@/components/machines/storage/storageReasonPresentation';
import { StorageVolumeRow } from '@/components/machines/storage/StorageVolumes';
import { selectStorageHeadlineVolume } from '@/components/machines/storage/storageViewModel';
import {
  VitalsSubLine,
  VitalsValue,
} from '@/components/machines/vitals/VitalsSheet';
import {
  formatMachineBytes,
  machineBytesParts,
} from '@/components/machines/vitals/machineVitalsPresentation';
import { useApprovalDecisionHandler } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useMachineStorageSummary } from '@/sync/domains/machines/storage/useMachineStorageSummary';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useArtifacts } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
  MachineWidgetSectionLabel,
  MachineWidgetState,
  MachineWidgetTwoColumns,
  useMachineWidgetFreshness,
  useMachineWidgetMachine,
  useMachineWidgetSize,
  useMachineWidgetTarget,
  useOpenMachinePage,
  type MachineWidgetBodyProps,
  type MachineWidgetTarget,
} from './machineWidgetKit';

const LIST_ROWS: Readonly<Record<WidgetSizeV1, number>> = {
  small: 0,
  wide: 3,
  medium: 3,
  full: 8,
  tall: 3,
  large: 8,
};
const SUGGESTIONS_TAB: MachinePageTabParams = {
  id: 'storage',
  page: 'suggestions',
};

export type MachineCleanupProposal = Readonly<{
  artifact: DecryptedArtifact;
  approval: ApprovalRequest;
}>;

/**
 * The cleanup an agent proposed for this machine and the person has not answered: the newest open
 * approval of `machines.storage.trash.move` placed on it (an approval request is the proposal, plan 60
 * §4.2). A proposal decided from this widget stays shown so its receipt (in Trash, Undo, Empty now)
 * can follow. Pure; it reads the canonical approval artifacts and decides nothing.
 */
export function selectMachineCleanupProposal(
  artifacts: readonly DecryptedArtifact[],
  target: MachineWidgetTarget,
  keepArtifactId: string | null,
  previous: MachineCleanupProposal | null = null,
): MachineCleanupProposal | null {
  let best: MachineCleanupProposal | null = null;
  for (const artifact of artifacts) {
    if (artifact.header?.kind !== 'approval_request.v1') continue;
    const kept = artifact.id === keepArtifactId;
    if (!kept && artifact.header?.approvalStatus !== 'open') continue;
    const sameRevision = previous !== null && artifact.id === previous.artifact.id
      && artifact.body === previous.artifact.body
      && artifact.headerVersion === previous.artifact.headerVersion
      && artifact.bodyVersion === previous.artifact.bodyVersion
      && sameStrictJsonValue(artifact.header, previous.artifact.header);
    const parsed = sameRevision ? { family: 'built_in' as const, request: previous.approval } : approvalArtifactBodyMatchesHeaderV1(
      artifact.header ?? {},
      typeof artifact.body === 'string' ? artifact.body : null,
    );
    if (
      parsed?.family !== 'built_in' ||
      (!kept && parsed.request.status !== 'open')
    )
      continue;
    const model = readResourceProposalApproval(parsed.request);
    if (model?.kind !== 'storage' || model.machineId !== target.machineId)
      continue;
    if (
      model.serverId &&
      !areServerProfileIdentifiersEquivalent(model.serverId, target.serverId)
    )
      continue;
    const proposal = artifact === previous?.artifact && sameRevision ? previous : { artifact, approval: parsed.request };
    if (kept) return proposal;
    if (!best || artifact.createdAt > best.artifact.createdAt)
      best = proposal;
  }
  return best;
}

/**
 * Suggestion (plan 60 EU-6, lab `rw` AG): a cleanup waiting for the person. Small, Medium, Wide and Full
 * only. It is the agent's proposal card read small — the same check-on-view and decision owners
 * (AGW-7/8) — so "Review" opens the proposal, "Not now" declines it as the card does, and Approve
 * appears only at Full, where every item is visible (AGW-18). Without a proposal it offers the
 * machine's own verified suggestions; nothing is removed from here.
 */
export function MachineSuggestionWidget(props: MachineWidgetBodyProps) {
  const target = useMachineWidgetTarget(props.input);
  if (!target)
    return (
      <MachineWidgetState
        kind="unavailable"
        title={t('machines.widgets.body.storage.noMachine')}
        testID={props.testID}
      />
    );
  return <MachineSuggestionWidgetBody target={target} testID={props.testID} />;
}

function MachineSuggestionWidgetBody(
  props: Readonly<{ target: MachineWidgetTarget; testID: string }>,
) {
  const artifacts = useArtifacts();
  const [decidedId, setDecidedId] = React.useState<string | null>(null);
  const selectProposal = React.useMemo(() => {
    let previous: MachineCleanupProposal | null = null;
    return (artifacts: readonly DecryptedArtifact[], target: MachineWidgetTarget, kept: string | null) => {
      previous = selectMachineCleanupProposal(artifacts, target, kept, previous);
      return previous;
    };
  }, []);
  const proposal = React.useMemo(
    () => selectProposal(artifacts, props.target, decidedId),
    [artifacts, decidedId, props.target, selectProposal],
  );
  if (!proposal)
    return (
      <MachineSuggestionFallback target={props.target} testID={props.testID} />
    );
  return (
    <MachineProposalSuggestion
      key={proposal.artifact.id}
      proposal={proposal}
      target={props.target}
      onDecided={setDecidedId}
      testID={props.testID}
    />
  );
}

function MachineProposalSuggestion(
  props: Readonly<{
    proposal: MachineCleanupProposal;
    target: MachineWidgetTarget;
    onDecided: (artifactId: string) => void;
    testID: string;
  }>,
) {
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(props.target);
  const router = useRouter();
  const { theme } = useUnistyles();
  const { approval, artifact } = props.proposal;
  const controller = useResourceProposalCheck(approval, props.target.serverId);
  const sessionId =
    approval.v === 2
      ? (approval.executionOriginV1.sessionId ??
        approval.createdBy.sessionId ??
        '')
      : (approval.createdBy.sessionId ?? '');
  const decide = useApprovalDecisionHandler(
    { id: artifact.id, header: artifact.header },
    approval,
    sessionId,
    props.target.serverId,
  );
  const [deciding, setDeciding] = React.useState(false);
  const stale = controller?.display.kind === 'ask' && controller.display.stale;
  useMachineWidgetFreshness(
    facts.online === false
      ? { kind: 'offline' }
      : stale && controller?.check.kind === 'ready'
        ? { kind: 'stale', at: controller.check.checkedAt }
        : { kind: 'live' },
    props.testID,
  );
  const openProposal = React.useCallback(() => {
    const href = `/inbox/approvals/${encodeURIComponent(artifact.id)}?serverId=${encodeURIComponent(props.target.serverId)}`;
    const result = runGuardedNavigation(() => router.push(href as never));
    if (result !== true)
      fireAndForget(result, { tag: 'MachineSuggestionWidget.review' });
  }, [artifact.id, props.target.serverId, router]);
  const run = React.useCallback(
    (decision: 'approve' | 'reject') => {
      if (!controller || deciding) return;
      setDeciding(true);
      props.onDecided(artifact.id);
      fireAndForget(
        decide(decision, controller.decisionOptions(decision)).finally(() =>
          setDeciding(false),
        ),
        { tag: `MachineSuggestionWidget.${decision}` },
      );
    },
    [artifact.id, controller, decide, deciding, props],
  );
  if (facts.online === null) return <MachineWidgetState kind="unavailable" title={t('common.unknown')} testID={props.testID} />;
  if (!controller)
    return (
      <MachineSuggestionFallback target={props.target} testID={props.testID} />
    );
  const display = controller.display;
  if (
    display.kind === 'trashed' ||
    display.kind === 'emptied' ||
    display.kind === 'executing' ||
    display.kind === 'restored' ||
    display.kind === 'declined' ||
    display.kind === 'failed'
  ) {
    return <ProposalReceipt controller={controller} testID={props.testID} />;
  }
  const present = controller.rows.filter(
    (row) => row.facts?.status === 'present' || row.facts === null,
  );
  const bytes = present.reduce((sum, row) => sum + (row.facts?.bytes ?? 0), 0);
  const checked =
    controller.check.kind === 'ready' ||
    (controller.check.kind === 'checking' &&
      controller.check.previous !== null);
  const changed = controller.rows.filter((row) => row.facts?.changed).length;
  const offline = facts.online === false;
  const hero = (
    <View testID={`${props.testID}.hero`} style={styles.hero}>
      <View style={styles.valueRow}>
        {checked ? (
          <VitalsValue
            value={machineBytesParts(bytes, 'storage').value}
            unit={t('machines.widgets.body.suggestion.canGo', {
              unit: machineBytesParts(bytes, 'storage').unit,
            })}
            {...(stale || offline ? { color: theme.colors.text.tertiary } : {})}
          />
        ) : (
          <VitalsValue value={t('machines.widgets.body.suggestion.checking')} />
        )}
      </View>
      <VitalsSubLine testID={`${props.testID}.from`}>
        {stale
          ? t('machines.widgets.body.suggestion.changed', {
              changed,
              count: controller.rows.length,
            })
          : offline
            ? t('machines.widgets.body.suggestion.offline', {
                machine: facts.name,
                when: formatRelativeTime(artifact.createdAt),
              })
            : t('machines.widgets.body.suggestion.from', {
                count: controller.rows.length,
                when: formatRelativeTime(artifact.createdAt),
              })}
      </VitalsSubLine>
    </View>
  );
  const actions = offline ? (
    <Text style={styles.caption}>
      {t('machines.widgets.body.suggestion.offlineNote', {
        machine: facts.name,
      })}
    </Text>
  ) : (
    <View style={styles.actions}>
      {stale ? (
        <RoundButton
          testID={`${props.testID}.checkAgain`}
          size="small"
          display="secondary"
          title={t('resourceProposal.checkAgain')}
          onPress={controller.checkAgain}
        />
      ) : null}
      {size === 'full' && !stale && controller.rows.length <= LIST_ROWS[size] ? (
        <RoundButton
          testID={`${props.testID}.approve`}
          size="small"
          title={resolveResourceProposalLabels(controller).approve}
          disabled={controller.approveWithheld || deciding}
          onPress={() => run('approve')}
        />
      ) : null}
      <RoundButton
        testID={`${props.testID}.review`}
        size="small"
        display={size === 'full' || stale ? 'secondary' : 'default'}
        title={t('machines.widgets.body.suggestion.review')}
        onPress={openProposal}
      />
      {!stale ? (
        <RoundButton
          testID={`${props.testID}.notNow`}
          size="small"
          display="inverted"
          title={t('resourceProposal.notNow')}
          disabled={deciding}
          onPress={() => run('reject')}
        />
      ) : null}
    </View>
  );
  const rows = (
    <ProposalRows
      rows={present}
      count={LIST_ROWS[size]}
      total={controller.rows.length}
      withVerdict={size === 'full'}
      testID={props.testID}
    />
  );
  const after =
    size === 'medium' || size === 'full' ? (
      <ProposalAfterBar
        target={props.target}
        bytes={controller.selectedBytes}
      />
    ) : null;
  if (size === 'small')
    return (
      <View testID={props.testID} style={styles.column}>
        {hero}
        <View style={styles.end}>{actions}</View>
      </View>
    );
  if (size === 'wide') {
    return (
      <View testID={props.testID} style={styles.fill}>
        <MachineWidgetTwoColumns
          lead={
            <>
              {hero}
              <View style={styles.end}>{actions}</View>
            </>
          }
          rest={rows}
        />
      </View>
    );
  }
  if (size === 'full' || size === 'large') {
    return (
      <View testID={props.testID} style={styles.fill}>
        <MachineWidgetTwoColumns
          lead={
            <>
              {hero}
              {after}
              <Text style={styles.caption}>
                {t('machines.widgets.body.suggestion.nothingUntil')}
              </Text>
              <View style={styles.end}>{actions}</View>
            </>
          }
          rest={rows}
        />
      </View>
    );
  }
  return (
    <View testID={props.testID} style={styles.column}>
      {hero}
      {rows}
      {after}
      <View style={styles.end}>{actions}</View>
    </View>
  );
}

/** "Largest of 8": the proposal's items by what each gives back, with the verdict where every item is shown. */
function ProposalRows(
  props: Readonly<{
    rows: readonly ResourceProposalRow[];
    count: number;
    total: number;
    withVerdict: boolean;
    testID: string;
  }>,
) {
  const shown = React.useMemo(
    () =>
      [...props.rows]
        .sort((a, b) => (b.facts?.bytes ?? 0) - (a.facts?.bytes ?? 0))
        .slice(0, props.count),
    [props.count, props.rows],
  );
  if (props.count === 0 || shown.length === 0) return null;
  const largest = shown[0]?.facts?.bytes ?? 0;
  return (
    <View testID={`${props.testID}.rows`} style={styles.rows}>
      <MachineWidgetSectionLabel
        label={t('machines.widgets.body.suggestion.largestOf', {
          count: props.total,
        })}
        meta={t('machines.widgets.body.worktrees.size')}
      />
      {shown.map((row, index) => (
        <StorageItemRow
          key={row.item.key}
          testID={`${props.testID}.row.${row.item.key}`}
          title={titleOf(row.item.path)}
          evidence={
            row.reason ? storageReasonLabel(row.reason) : ''
          }
          bytes={row.facts?.bytes ?? 0}
          atLeast={false}
          largest={largest}
          chip={null}
          trailing={
            props.withVerdict && row.reason ? (
              <StorageVerdictPill
                chip={describeStorageVerdict({
                  verdict: row.verdict,
                  reason: row.reason,
                })}
              />
            ) : undefined
          }
          compact
          showDivider={index < shown.length - 1}
        />
      ))}
    </View>
  );
}

function titleOf(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

/** The disk as it will be: the Storage tab's own volume row with the proposal as its ghost. */
function ProposalAfterBar(
  props: Readonly<{ target: MachineWidgetTarget; bytes: number }>,
) {
  const storage = useMachineStorageSummary(props.target);
  const headline = storage.summary
    ? selectStorageHeadlineVolume(storage.summary)
    : null;
  const volume = React.useMemo(
    () =>
      headline
        ? {
            ...headline,
            pileBytes: Math.min(headline.happierBytes, props.bytes),
          }
        : null,
    [headline, props.bytes],
  );
  if (!volume || props.bytes <= 0) return null;
  return <StorageVolumeRow volume={volume} compact after="trashEmpties" />;
}

/** After the decision: "N items in Trash" with Undo and Empty now; "freed" only once the Trash is empty (R25). */
function ProposalReceipt(
  props: Readonly<{ controller: ResourceProposalController; testID: string }>,
) {
  const { display, undo, emptyNow } = props.controller;
  const line =
    display.kind === 'trashed'
      ? {
          title: t('machines.widgets.body.suggestion.inTrash', {
            count: display.result.outcomes.filter((o) => o.status === 'moved')
              .length,
            amount: formatMachineBytes(display.result.inTrashBytes, 'storage'),
          }),
          reason: [
            display.result.outcomes.some((o) => o.status === 'skipped')
              ? t('machines.widgets.body.suggestion.skipped', {
                  count: display.result.outcomes.filter(
                    (o) => o.status === 'skipped',
                  ).length,
                })
              : null,
            t('machines.widgets.body.suggestion.comesBack'),
          ]
            .filter(Boolean)
            .join(' '),
        }
      : display.kind === 'emptied'
        ? {
            title: t('machines.widgets.body.suggestion.freed', {
              amount: formatMachineBytes(display.freedBytes, 'storage'),
            }),
          }
        : display.kind === 'executing'
          ? {
              title: t('machines.widgets.body.suggestion.moving', {
                count: display.count,
              }),
            }
          : display.kind === 'restored'
            ? { title: t('machines.widgets.body.suggestion.restored') }
            : display.kind === 'declined'
              ? { title: t('machines.widgets.body.suggestion.declined') }
              : { title: t('machines.widgets.body.suggestion.failed') };
  return (
    <View testID={`${props.testID}.receipt`} style={styles.column}>
      <MachineWidgetState
        kind="empty"
        title={line.title}
        reason={'reason' in line ? line.reason : undefined}
        testID={`${props.testID}.receipt`}
      />
      {display.kind === 'trashed' ? (
        <View style={styles.actions}>
          {undo ? (
            <RoundButton
              testID={`${props.testID}.undo`}
              size="small"
              display="secondary"
              title={t('machines.widgets.body.suggestion.undo')}
              onPress={() => {
                void undo();
              }}
            />
          ) : null}
          {emptyNow ? (
            <RoundButton
              testID={`${props.testID}.emptyNow`}
              size="small"
              display="inverted"
              title={t('machineStorage.pile.emptyNow')}
              onPress={() => {
                fireAndForget(
                  emptyNow(),
                  { tag: 'MachineSuggestionWidget.emptyNow' },
                );
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * No proposal waiting: the machine's own verified suggestions (plan 40's summary), which Review
 * collects into the pile as the Storage tab does; or a quiet invitation to ask an agent.
 */
function MachineSuggestionFallback(
  props: Readonly<{ target: MachineWidgetTarget; testID: string }>,
) {
  const size = useMachineWidgetSize();
  const facts = useMachineWidgetMachine(props.target);
  const storage = useMachineStorageSummary(props.target);
  const open = useOpenMachinePage(props.target);
  useMachineWidgetFreshness(
    storage.offline ? { kind: 'offline' } : { kind: 'live' },
    props.testID,
  );
  const items = storage.summary?.suggestionsSafeTop ?? storage.summary?.suggestionsTop ?? EMPTY_ITEMS;
  const safe = React.useMemo(
    () => items.filter((item) => item.verdict === 'safe' && item.collectable),
    [items],
  );
  if (facts.online === null) return <MachineWidgetState kind="unavailable" title={t('common.unknown')} testID={props.testID} />;
  if (!storage.summary) {
    if (storage.status === 'not_reported')
      return (
        <MachineWidgetState
          kind="not_reported"
          machineName={facts.name}
          testID={props.testID}
        />
      );
    if (storage.offline)
      return (
        <MachineWidgetState
          kind="offline"
          machineName={facts.name}
          lastSeenAt={facts.lastSeenAt}
          testID={props.testID}
        />
      );
    if (storage.status === 'error')
      return (
        <MachineWidgetState
          kind="error"
          onRetry={storage.retry}
          testID={props.testID}
        />
      );
    return <MachineWidgetState kind="loading" rows={2} testID={props.testID} />;
  }
  if (safe.length === 0) {
    return (
      <MachineWidgetState
        kind="empty"
        testID={props.testID}
        title={t('machines.widgets.body.suggestion.noneTitle')}
        reason={t('machines.widgets.body.suggestion.noneBody', {
          machine: facts.name,
        })}
        {...(!storage.offline && !facts.recipient
          ? {
              action: {
                label: t('machines.widgets.body.suggestion.ask'),
                onPress: () => open({ id: 'storage' }),
              },
            }
          : {})}
      />
    );
  }
  const bytes = storage.summary.suggestionsSafeFreesBytes ?? safe.reduce((sum, item) => sum + item.size.freesBytes, 0);
  const count = storage.summary.suggestionsSafeTotalCount ?? safe.length;
  const parts = machineBytesParts(bytes, 'storage');
  const hero = (
    <View testID={`${props.testID}.hero`} style={styles.hero}>
      <View style={styles.valueRow}>
        <VitalsValue
          value={parts.value}
          unit={t('machines.widgets.body.suggestion.canGo', {
            unit: parts.unit,
          })}
        />
      </View>
      <VitalsSubLine>
        {t('machines.widgets.body.suggestion.verified', {
          count,
          machine: facts.name,
        })}
      </VitalsSubLine>
    </View>
  );
  const actions = facts.recipient ? (
    <Text style={styles.caption}>
      {t('machines.widgets.body.common.recipient')}
    </Text>
  ) : storage.offline ? null : (
    <SuggestionsReviewAction
      target={props.target}
      items={safe}
      open={open}
      testID={props.testID}
    />
  );
  const rows =
    LIST_ROWS[size] > 0 ? (
      <View testID={`${props.testID}.rows`} style={styles.rows}>
        <MachineWidgetSectionLabel
          label={t('machines.widgets.body.suggestion.largestOf', {
            count,
          })}
          meta={t('machines.widgets.body.worktrees.size')}
        />
        {safe.slice(0, LIST_ROWS[size]).map((item, index, shown) => (
          <StorageItemRow
            key={item.itemId}
            testID={`${props.testID}.row.${item.itemId}`}
            title={item.title}
            evidence={item.evidence.slice(0, 1).map(storageEvidenceLabel).join(' · ')}
            bytes={item.size.allocatedBytes}
            atLeast={item.size.atLeast}
            largest={shown[0]!.size.allocatedBytes}
            freesBytes={item.size.freesBytes}
            chip={size === 'full' ? describeStorageVerdict(item) : null}
            compact
            showDivider={index < shown.length - 1}
          />
        ))}
      </View>
    ) : null;
  if (size === 'small')
    return (
      <View testID={props.testID} style={styles.column}>
        {hero}
        <View style={styles.end}>{actions}</View>
      </View>
    );
  if (size === 'medium' || size === 'tall')
    return (
      <View testID={props.testID} style={styles.column}>
        {hero}
        {rows}
        <View style={styles.end}>{actions}</View>
      </View>
    );
  return (
    <View testID={props.testID} style={styles.fill}>
      <MachineWidgetTwoColumns
        lead={
          <>
            {hero}
            <View style={styles.end}>{actions}</View>
          </>
        }
        rest={rows}
      />
    </View>
  );
}

const EMPTY_ITEMS: readonly StorageItemV1[] = [];

function SuggestionsReviewAction(
  props: Readonly<{
    target: MachineWidgetTarget;
    items: readonly StorageItemV1[];
    open: (tab?: MachinePageTabParams) => void;
    testID: string;
  }>,
) {
  const collect = useStorageCollect({
    serverId: props.target.serverId,
    machineId: props.target.machineId,
  });
  const { items, open } = props;
  const review = React.useCallback(() => {
    if (collect.groupOf(items) !== 'checked') collect.collectAll(items);
    open(SUGGESTIONS_TAB);
  }, [collect, items, open]);
  return (
    <View style={styles.actions}>
      <RoundButton
        testID={`${props.testID}.review`}
        size="small"
        title={t('machines.widgets.body.suggestion.review')}
        onPress={review}
      />
      <Text style={styles.caption} numberOfLines={1}>
        {t('machines.widgets.body.storage.trashFirst')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: { flexGrow: 1, minWidth: 0 },
  column: { flexGrow: 1, minWidth: 0, gap: 14 },
  hero: { gap: theme.space.s2 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: theme.space.s6 },
  rows: { minWidth: 0, gap: theme.space.s4 },
  end: { marginTop: 'auto' },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s10,
    flexWrap: 'wrap',
  },
  caption: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
}));
