import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { DiffFilesListView } from '@/components/ui/code/diff/DiffFilesListView';
import { buildDiffFileEntries } from '@/components/ui/code/model/diff/diffViewModel';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { ModalCardFooterActions } from '@/modal/components/card/ModalCardFooterActions';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import type {
  CustomModalChromeCardConfig,
  CustomModalInjectedProps,
} from '@/modal/types';
import {
  applySessionProjectFilesReturn,
  prepareSessionProjectFilesReturn,
  projectSessionProjectFilesReturnApplyState,
  projectSessionProjectFilesReturnReviewState,
  replaceSessionProjectFilesReturnConflict,
  type SessionProjectFilesReturnReviewState,
} from '@/sync/ops/sessionProjectFilesReturn';
import { t } from '@/text';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { SessionProjectFilesReturnSource } from './useSessionProjectFilesReturnSource';

type ReturnInput = Readonly<{
  sessionId: string;
  source: SessionProjectFilesReturnSource;
  /** The source Machine's display name and home folder, for the subtitle. */
  machineName: string;
  homeDir?: string | null;
}>;

/** "Bring back…" on a copied Session's turn changes (lab machine-sandboxes-1115 F3): the review opens on demand. */
export function openProjectFilesReturn(input: ReturnInput) {
  Modal.show({
    component: ProjectFilesReturnModal,
    props: input,
    chrome: returnChrome(input, null),
  });
}

function returnChrome(
  input: ReturnInput,
  footer: React.ReactNode,
): CustomModalChromeCardConfig {
  return {
    kind: 'card',
    material: 'solid',
    title: t('machineDetailPage.projectFiles.reviewTitle'),
    subtitle: t('machineDetailPage.projectFiles.reviewTo', {
      folder: formatPathRelativeToHome(input.source.rootPath, input.homeDir, {
        homeLabel: t('machineDetailPage.projectFiles.homeFolder'),
      }),
      machine: input.machineName,
    }),
    subtitleLines: 1,
    testID: 'project-files-return',
    scrollHost: 'bounded',
    dimensions: {
      width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
      maxHeightRatio: 0.86,
      size: 'lg',
    },
    phonePresentation: 'sheet',
    ...(footer ? { footer } : {}),
  };
}

type Phase =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'review'; state: SessionProjectFilesReturnReviewState }>
  | Readonly<{ kind: 'applied'; count: number }>;

function readFailureAppliedPaths(failure: ActionExecuteFailure): readonly string[] {
  return Array.isArray(failure.details?.appliedPaths)
    ? failure.details.appliedPaths.filter((path): path is string => typeof path === 'string')
    : [];
}

function ProjectFilesReturnModal(
  props: CustomModalInjectedProps & ReturnInput,
) {
  const { sessionId, source, onClose } = props;
  const context = React.useMemo(
    () => ({ serverId: source.serverId }),
    [source.serverId],
  );
  const target = React.useMemo(
    () => ({ sessionId, machineId: source.machineId }),
    [sessionId, source.machineId],
  );
  const [phase, setPhase] = React.useState<Phase>({ kind: 'loading' });
  const [busy, setBusy] = React.useState<'apply' | string | null>(null);
  const [applyFailure, setApplyFailure] = React.useState<ActionExecuteFailure | null>(null);
  // Files already brought back, including successful files from a return with remaining conflicts.
  const [appliedFiles, setAppliedFiles] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const load = React.useCallback(() => {
    setPhase({ kind: 'loading' });
    fireAndForget(
      (async () => {
        const result = await prepareSessionProjectFilesReturn(target, context);
        setPhase({
          kind: 'review',
          state: projectSessionProjectFilesReturnReviewState(result),
        });
      })(),
      { tag: 'ProjectFilesReturn.prepare' },
    );
  }, [context, target]);
  // Opening the review is the demand: nothing is computed before it (no live change count at rest).
  React.useEffect(() => {
    load();
  }, [load]);

  const review =
    phase.kind === 'review' && phase.state.kind !== 'failed'
      ? phase.state.review
      : null;
  const conflicts = React.useMemo(
    () =>
      new Set(
        review?.paths.flatMap((path) =>
          path.conflicts.map((conflict) => conflict.path),
        ) ?? [],
      ),
    [review],
  );
  const applyPaths = React.useMemo(
    () =>
      review?.paths
        .map((path) => path.path)
        .filter((path) => !conflicts.has(path) && !appliedFiles.has(path)) ?? [],
    [appliedFiles, conflicts, review],
  );
  const files = React.useMemo(
    () =>
      review
        ? buildDiffFileEntries(
            review.paths.flatMap((path) =>
              path.files.map((file) => ({
                filePath: file.path,
                unifiedDiff: file.evidence.unifiedDiff ?? '',
              })),
            ),
          )
        : [],
    [review],
  );
  const applyUnavailable =
    review?.applyUnavailableReason === 'baseline_unavailable';

  const retainApplyFailure = React.useCallback((failure: ActionExecuteFailure) => {
    setApplyFailure(failure);
    const paths = readFailureAppliedPaths(failure);
    if (paths.length > 0) {
      setAppliedFiles((current) => new Set([...current, ...paths]));
    }
  }, []);

  const apply = React.useCallback(() => {
    if (!review || applyPaths.length === 0 || busy) return;
    setBusy('apply');
    setApplyFailure(null);
    fireAndForget(
      (async () => {
        const outcome = projectSessionProjectFilesReturnApplyState(
          await applySessionProjectFilesReturn(
            { ...target, returnId: review.returnId, paths: [...applyPaths] },
            context,
          ),
        );
        setBusy(null);
        if (outcome.kind === 'failed') {
          retainApplyFailure(outcome.failure);
          return;
        }
        if (outcome.kind === 'conflicts') {
          setAppliedFiles((current) => new Set([...current, ...outcome.result.appliedPaths]));
          return;
        }
        setPhase({
          kind: 'applied',
          count: outcome.result.appliedPaths.length + appliedFiles.size,
        });
      })(),
      { tag: 'ProjectFilesReturn.apply' },
    );
  }, [appliedFiles.size, applyPaths, busy, context, retainApplyFailure, review, target]);

  const takeSandboxVersion = React.useCallback(
    (path: string) => {
      if (!review || busy) return;
      setBusy(path);
      setApplyFailure(null);
      fireAndForget(
        (async () => {
          const outcome = projectSessionProjectFilesReturnApplyState(
            await replaceSessionProjectFilesReturnConflict(
              { ...target, returnId: review.returnId, path },
              context,
            ),
          );
          setBusy(null);
          if (outcome.kind === 'failed') {
            retainApplyFailure(outcome.failure);
            return;
          }
          setAppliedFiles((current) => new Set([...current, path]));
        })(),
        { tag: 'ProjectFilesReturn.useSandbox' },
      );
    },
    [busy, context, retainApplyFailure, review, target],
  );

  const footer = React.useMemo(
    () =>
      phase.kind === 'applied' ? (
        <ModalCardFooterActions>
          <RoundButton
            testID="project-files-return.close"
            size="normal"
            title={t('common.close')}
            onPress={onClose}
          />
        </ModalCardFooterActions>
      ) : (
        <ModalCardFooterActions
          cancel={{
            onPress: onClose,
            testID: 'project-files-return.cancel',
            disabled: busy === 'apply',
          }}
          note={
            applyUnavailable
              ? t('machineDetailPage.projectFiles.baselineUnavailable')
              : null
          }
        >
          {review && review.paths.length > 0 ? (
            <RoundButton
              testID="project-files-return.apply"
              size="normal"
              title={t('machineDetailPage.projectFiles.apply', {
                count: applyPaths.length,
              })}
              disabled={
                applyPaths.length === 0 || applyUnavailable || busy !== null
              }
              loading={busy === 'apply'}
              onPress={apply}
            />
          ) : null}
        </ModalCardFooterActions>
      ),
    [
      applyPaths.length,
      applyUnavailable,
      apply,
      busy,
      onClose,
      phase.kind,
      review,
    ],
  );
  useModalCardChrome(
    props.setChrome,
    React.useMemo(
      () => returnChrome({ sessionId, source, machineName: props.machineName, homeDir: props.homeDir }, footer),
      [footer, props.homeDir, props.machineName, sessionId, source],
    ),
  );

  if (phase.kind === 'loading') {
    return (
      <SurfaceStateCard
        testID="project-files-return.loading"
        kind="loading"
        layout="inline"
        title={t('machineDetailPage.projectFiles.reviewTitle')}
      />
    );
  }
  if (phase.kind === 'applied') {
    return (
      <SurfaceStateCard
        testID="project-files-return.applied"
        kind="success"
        layout="inline"
        title={t('machineDetailPage.projectFiles.changedCount', {
          count: phase.count,
        })}
      />
    );
  }
  const state = phase.state;
  if (state.kind === 'failed') {
    return (
      <SurfaceStateCard
        testID="project-files-return.failed"
        kind="error"
        layout="inline"
        title={t('machineDetailPage.projectFiles.loadFailed')}
        diagnosticCode={state.failure.errorCode}
        action={{ label: t('common.retry'), onPress: load }}
      />
    );
  }
  if (state.kind === 'no_changes') {
    return (
      <SurfaceStateCard
        testID="project-files-return.empty"
        kind="empty"
        layout="inline"
        title={t('machineDetailPage.projectFiles.nothingTitle')}
        reason={t('machineDetailPage.projectFiles.nothingReason')}
      />
    );
  }
  const partiallyAppliedPaths = applyFailure ? readFailureAppliedPaths(applyFailure) : [];
  return (
    <View testID="project-files-return.review" style={styles.body}>
      <Text style={styles.summary}>
        <Text style={styles.summaryLead}>
          {t('machineDetailPage.projectFiles.changedCount', {
            count: state.review.paths.length,
          })}
        </Text>
        {'  '}
        {t('machineDetailPage.projectFiles.returnNote')}
      </Text>
      {applyFailure ? (
        <>
          <SurfaceStateCard
            testID="project-files-return.apply-failed"
            kind="error"
            size="line"
            title={presentActionExecutionFailure(applyFailure).reason}
            diagnosticCode={applyFailure.errorCode}
          />
          {partiallyAppliedPaths.length > 0 ? (
            <Text style={styles.summary}>
              {t('machineDetailPage.projectFiles.changedCount', { count: partiallyAppliedPaths.length })}
              {'\n'}
              {partiallyAppliedPaths.join('\n')}
            </Text>
          ) : null}
        </>
      ) : null}
      {conflicts.size > 0 ? (
        <Text style={styles.conflictHelp}>
          {t('machineDetailPage.projectFiles.conflictsHelp')}
        </Text>
      ) : null}
      <DiffFilesListView
        testID="project-files-return.files"
        files={files}
        expandedKeys={expanded}
        onToggleExpanded={(key) =>
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          })
        }
        canRenderInlineDiffs
        wrapLines
        showLineNumbers
        showPrefix
        // A file changed in both places keeps yours, with one press to take the sandbox's (owner decision 2).
        renderBeforeFileRow={({ file }) =>
          file.filePath &&
          conflicts.has(file.filePath) &&
          !appliedFiles.has(file.filePath) ? (
            <View style={styles.conflict}>
              <Text style={styles.conflictText}>
                {t('machineDetailPage.projectFiles.conflictsTitle')}
              </Text>
              <TextLinkButton
                testID={`project-files-return.use-sandbox.${file.filePath}`}
                size="meta"
                tone="quiet"
                label={t('machineDetailPage.projectFiles.useSandbox')}
                disabled={busy !== null}
                onPress={() => takeSandboxVersion(file.filePath!)}
              />
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s12 },
  summary: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  summaryLead: {
    ...Typography.variant('label', 'semiBold'),
    color: theme.colors.text.primary,
  },
  conflictHelp: {
    ...Typography.variant('meta'),
    color: theme.colors.text.secondary,
  },
  conflict: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingTop: theme.space.s8,
  },
  conflictText: {
    ...Typography.variant('meta'),
    color: theme.colors.state.warning.foreground,
  },
}));
