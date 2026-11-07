import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type {
  MachineStorageDockerPruneResultV1,
  MachineStorageDockerSummaryV1,
} from '@happier-dev/protocol/storage/storageV1';

import { openActionOperationDetail } from '@/components/inbox/actionOperations/openActionOperationDetail';
import { Modal } from '@/modal';
import type { CustomModalInjectedProps } from '@/modal/types';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  pruneMachineStorageDockerViaAction,
  type MachineStorageResult,
} from '@/sync/domains/machines/storage/machineRpc';
import { t } from '@/text';

import { StorageItemRow } from './StorageItemRow';
import { describeStorageVerdict } from './storageReasonPresentation';

type ReadyDocker = Extract<MachineStorageDockerSummaryV1, { kind: 'ready' }>;
type Candidate = Extract<
  ReadyDocker['images']['custody'],
  { kind: 'complete' }
>['candidates'][number];
type Phase =
  | Readonly<{ kind: 'facts' }>
  | Readonly<{ kind: 'review' | 'removing'; candidates: readonly Candidate[] }>
  | Readonly<{
      kind: 'result';
      result: MachineStorageResult<MachineStorageDockerPruneResultV1>;
    }>;

const FACTS: Phase = Object.freeze({ kind: 'facts' });
/** Volumes are never cleaned here: the owner marks them always kept. */
const ALWAYS_KEPT = describeStorageVerdict({ verdict: 'keep', reason: { code: 'always_kept' } });

/** Bytes only when the owner measured every part; an absent size is unknown, never zero. */
function knownSum(values: readonly (number | undefined)[]): number | null {
  return values.every((value) => value !== undefined)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
}

/**
 * Docker on a deploy target (P-M5 "Free space"): what its images, volumes, kept releases and build cache
 * take, from the Storage owner's summary, and one in-place review that removes exactly the images the owner
 * proved unused through `machines.storage.docker.prune`. The person's Remove is the confirmation (row 323);
 * the receiving owner rechecks every selector. Nothing here decides custody.
 */
export const StorageDockerCleanup = React.memo(function StorageDockerCleanup(
  props: Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    docker: MachineStorageDockerSummaryV1;
    offline: boolean;
    /** Re-reads the summary after a cleanup, so the facts say what is left. */
    onSizeAgain: () => Promise<unknown>;
    /** A phone: the review opens full height with Remove pinned, like the pile's review (MR10). */
    compact: boolean;
  }>,
) {
  const [phase, setPhase] = React.useState<Phase>(FACTS);
  const { docker } = props;
  // Docker that does not run here is not a section; one that would not list its images says so.
  if (docker.kind === 'unavailable') {
    if (docker.reason === 'native_runtime_unavailable') return null;
    return (
      <ItemGroup header="none">
        <SurfaceStateCard
          testID="machine-storage-docker"
          kind="warning"
          size="line"
          title={t('machineStorage.docker.inventoryUnavailable')}
          {...(props.offline
            ? {}
            : {
                action: {
                  label: t('machineStorage.tryAgain'),
                  testID: 'machine-storage-docker-retry',
                  onPress: () => {
                    void props.onSizeAgain();
                  },
                },
              })}
        />
      </ItemGroup>
    );
  }
  const custody = docker.images.custody;
  const candidates = custody.kind === 'complete' ? custody.candidates : [];
  const remove = async (selected: readonly Candidate[], inPlace: boolean) => {
    if (inPlace) setPhase({ kind: 'removing', candidates: selected });
    const result = await pruneMachineStorageDockerViaAction({
      machineId: props.machineId,
      serverId: props.serverId,
      expectedEngineId: docker.engineId,
      reviewedByPerson: true,
      selection: {
        kind: 'explicit',
        images: selected.map(({ nativeId, configDigest, platform }) => ({
          nativeId,
          configDigest,
          platform,
        })),
        buildCacheIds: [],
      },
    });
    setPhase({ kind: 'result', result });
    void props.onSizeAgain();
  };
  const reviewing = phase.kind === 'review' || phase.kind === 'removing';
  // The rows share the Storage row shape (bar, size, chip columns), so their sizes line up with the rows below.
  const largest = Math.max(0, docker.images.sizeBytes ?? 0, docker.volumes.sizeBytes ?? 0, docker.buildCache.sizeBytes ?? 0);
  return (
    <ItemGroup
      testID="machine-storage-docker"
      title={t('machineStorage.docker.title')}
      description={t('machineStorage.docker.description', {
        machine: props.machineName,
      })}
      action={
        !reviewing &&
        phase.kind !== 'result' &&
        candidates.length > 0 &&
        !props.offline ? (
          <TextLinkButton
            testID="machine-storage-docker-free-space"
            tone="strong"
            label={t('machineStorage.docker.freeSpace')}
            onPress={() => {
              if (!props.compact) {
                setPhase({ kind: 'review', candidates });
                return;
              }
              Modal.show({
                component: DockerReviewSheet,
                props: { candidates, onRemove: () => remove(candidates, false) },
                chrome: {
                  kind: 'card',
                  title: t('machineStorage.docker.freeSpace'),
                  testID: 'machine-storage-docker-review-modal',
                  phonePresentation: 'fullscreen',
                  scrollHost: 'bounded',
                  bodyScroll: 'auto',
                  dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide, maxHeightRatio: 0.9, size: 'md' },
                },
                closeOnBackdrop: true,
              });
            }}
          />
        ) : undefined
      }
    >
      {reviewing ? (
        <DockerReview
          candidates={phase.candidates}
          removing={phase.kind === 'removing'}
          onCancel={() => setPhase(FACTS)}
          onRemove={() => {
            void remove(phase.candidates, true);
          }}
        />
      ) : (
        <>
          {phase.kind === 'result' ? (
            <DockerResult
              serverId={props.serverId}
              result={phase.result}
              onDone={() => setPhase(FACTS)}
            />
          ) : null}
          <StorageItemRow
            testID="machine-storage-docker-images"
            title={t('machineStorage.docker.images')}
            evidence={[
              t('machineStorage.docker.count', { count: docker.images.count }),
              custody.kind === 'unavailable'
                ? t('machineStorage.docker.custodyUnavailable')
                : candidates.length > 0
                  ? t('machineStorage.docker.canGo', { count: candidates.length })
                  : t('machineStorage.docker.noneCanGo'),
            ].join(' · ')}
            bytes={docker.images.sizeBytes ?? null}
            atLeast={false}
            largest={largest}
            chip={null}
            compact={props.compact}
            showDivider
          />
          <StorageItemRow
            testID="machine-storage-docker-volumes"
            title={t('machineStorage.docker.volumes')}
            evidence={t('machineStorage.docker.count', { count: docker.volumes.count })}
            bytes={docker.volumes.sizeBytes ?? null}
            atLeast={false}
            largest={largest}
            chip={ALWAYS_KEPT}
            compact={props.compact}
            showDivider
          />
          <StorageItemRow
            testID="machine-storage-docker-releases"
            title={t('machineStorage.docker.deployments')}
            evidence={
              docker.releases.kind === 'ready'
                ? t('machineStorage.docker.releasesKept', {
                    count: docker.releases.environments.reduce((sum, environment) => sum + environment.keptReleaseCount, 0),
                  })
                : t('machineStorage.docker.releasesUnknown')
            }
            bytes={null}
            atLeast={false}
            largest={largest}
            chip={null}
            compact={props.compact}
            showDivider
          />
          <StorageItemRow
            testID="machine-storage-docker-build-cache"
            title={t('machineStorage.docker.buildCache')}
            evidence={t('machineStorage.docker.buildCacheKept')}
            bytes={docker.buildCache.sizeBytes ?? null}
            atLeast={false}
            largest={largest}
            chip={null}
            compact={props.compact}
            showDivider={false}
          />
        </>
      )}
    </ItemGroup>
  );
});

/** The exact unused images and what stays: the body of the review, in place or in the phone sheet. */
function DockerReviewBody(props: Readonly<{ candidates: readonly Candidate[] }>) {
  const frees = knownSum(props.candidates.map((candidate) => candidate.reclaimableBytes));
  return (
    <Item
      testID="machine-storage-docker-review"
      mode="info"
      showChevron={false}
      title={t('machineStorage.docker.reviewLead', { count: props.candidates.length })}
      subtitle={t('machineStorage.docker.reviewKept')}
      {...(frees !== null ? { detail: formatMachineBytes(frees, 'storage') } : {})}
    />
  );
}

/** Cancel and Remove: the person's Remove is the one confirmation. */
function DockerReviewActions(props: Readonly<{ removing: boolean; onCancel: () => void; onRemove: () => void; fill?: boolean }>) {
  return (
    <View style={styles.actions}>
      <RoundButton testID="machine-storage-docker-cancel" size="normal" display="inverted" title={t('common.cancel')}
        disabled={props.removing} onPress={props.onCancel} />
      <RoundButton testID="machine-storage-docker-remove" size="normal" display="destructive" style={props.fill ? styles.grow : undefined}
        title={t('machineStorage.docker.remove')} loading={props.removing} onPress={props.onRemove} />
    </View>
  );
}

/** The review in place of the facts (wide pages). */
function DockerReview(props: Readonly<{ candidates: readonly Candidate[]; removing: boolean; onCancel: () => void; onRemove: () => void }>) {
  return (
    <>
      <DockerReviewBody candidates={props.candidates} />
      <SectionContentRow showDivider={false}>
        <DockerReviewActions removing={props.removing} onCancel={props.onCancel} onRemove={props.onRemove} />
      </SectionContentRow>
    </>
  );
}

/** The phone review: full height, the actions pinned in the sheet's footer while the body scrolls. */
function DockerReviewSheet(props: CustomModalInjectedProps & Readonly<{ candidates: readonly Candidate[]; onRemove: () => Promise<void> }>) {
  const [removing, setRemoving] = React.useState(false);
  const { setChrome, onClose, onRemove } = props;
  const footer = (
    <DockerReviewActions removing={removing} fill onCancel={onClose}
      onRemove={() => {
        setRemoving(true);
        void onRemove().finally(onClose);
      }} />
  );
  React.useEffect(() => {
    setChrome?.({ kind: 'card', footer });
  });
  React.useEffect(() => () => setChrome?.(null), [setChrome]);
  return (
    <View style={styles.sheetBody}>
      <DockerReviewBody candidates={props.candidates} />
      {setChrome ? null : footer}
    </View>
  );
}

/** The owner's typed outcome in words, with its one next step. */
function DockerResult(
  props: Readonly<{
    serverId: string;
    result: MachineStorageResult<MachineStorageDockerPruneResultV1>;
    onDone: () => void;
  }>,
) {
  const { result } = props;
  if (!result.ok) {
    const title =
      result.reason === 'approval_requested'
        ? t('machineStorage.docker.approval')
        : result.reason === 'declined'
          ? t('machineStorage.docker.notRemoved')
          : t('machineStorage.docker.failed');
    return (
      <ResultLine
        kind={
          result.reason === 'approval_requested' || result.reason === 'declined'
            ? 'neutral'
            : 'warning'
        }
        title={title}
        onDone={props.onDone}
      />
    );
  }
  const value = result.value;
  switch (value.kind) {
    case 'completed':
      return (
        <ResultLine
          kind="success"
          title={t('machineStorage.docker.removed', {
            removed: value.removed.length,
            kept: value.kept.length,
          })}
          onDone={props.onDone}
        />
      );
    case 'changed':
      return (
        <ResultLine
          kind="warning"
          title={t('machineStorage.docker.changed', {
            removed: value.removed.length,
          })}
          onDone={props.onDone}
        />
      );
    case 'failed':
      return (
        <ResultLine
          kind="warning"
          title={t('machineStorage.docker.failed')}
          onDone={props.onDone}
        />
      );
    case 'outcome_unknown':
      return (
        <ResultLine
          kind="warning"
          title={t('machineStorage.docker.outcomeUnknown')}
          onDone={props.onDone}
        />
      );
    case 'unavailable':
    case 'unsupported':
      return (
        <ResultLine
          kind="warning"
          title={t(`machineStorage.docker.reasons.${value.reason}`)}
          onDone={props.onDone}
        />
      );
    case 'effect_in_progress':
      return (
        <ResultLine
          kind="neutral"
          title={t('machineStorage.docker.inProgress')}
          onDone={props.onDone}
          action={{
            label: t('machineStorage.docker.openProgress'),
            onPress: () =>
              openActionOperationDetail({
                serverId: props.serverId,
                operationId: value.actionOperationId,
              }),
          }}
        />
      );
  }
}

function ResultLine(
  props: Readonly<{
    kind: 'success' | 'warning' | 'neutral';
    title: string;
    onDone: () => void;
    action?: Readonly<{ label: string; onPress: () => void }>;
  }>,
) {
  return (
    <SectionContentRow>
      <View style={styles.result} testID="machine-storage-docker-result">
        <Text
          style={[
            styles.resultText,
            props.kind === 'warning' ? styles.warning : null,
          ]}
        >
          {props.title}
        </Text>
        <View style={styles.resultActions}>
          {props.action ? (
            <TextLinkButton
              tone="strong"
              label={props.action.label}
              onPress={props.action.onPress}
            />
          ) : null}
          <TextLinkButton
            testID="machine-storage-docker-done"
            label={t('common.done')}
            onPress={props.onDone}
          />
        </View>
      </View>
    </SectionContentRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  grow: {
    flexGrow: 1,
  },
  sheetBody: {
    paddingBottom: theme.space.s16,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: theme.space.s8,
  },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: theme.space.s12,
  },
  resultActions: {
    flexDirection: 'row',
    gap: theme.space.s12,
  },
  resultText: {
    ...Typography.default('medium'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  warning: {
    color: theme.colors.state.attention.textForeground,
  },
}));
