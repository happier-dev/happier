import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import type { ManagedWorkspaceLocatorV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import {
  SetupSteps,
  type SetupStep,
} from '@/components/ui/setupBlocks/SetupSteps';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { formatElapsedDuration } from '@/components/machines/durationWords';
import { useElapsedTime } from '@/hooks/ui/useElapsedTime';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { resolveActionExecutionErrorMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

import { PathBrowserModalFooter } from './PathBrowserModalFooter';
import { PATH_BROWSER_MODAL_TEST_ID } from './pathBrowserTestIds';

export type PreparedManagedWorkspace = Pick<
  ManagedWorkspaceLocatorV2,
  'serverId' | 'managedId' | 'controller' | 'rootPath'
>;
export type ManagedWorkspacePreparationOutcome =
  | Readonly<{ kind: 'ready'; workspace: PreparedManagedWorkspace }>
  | Readonly<{ kind: 'unsupported_platform' }>
  | Readonly<{ kind: 'failed'; code: string; message: string | null }>;

/**
 * Access to a workspace that has none yet (an attachment before its Project exists): the chooser runs it first,
 * shows it as one step, and browses the workspace it settles to. The owner of the access runs it; the chooser
 * only presents it.
 */
export type ManagedWorkspacePreparationRequest = Readonly<{
  /** The workspace's name, for the copy ("on api-dev"). */
  name: string;
  serverId: string;
  run(
    input: Readonly<{
      signal: AbortSignal;
      onApprovalPending(registration: ActionApprovalRegistration): void;
    }>,
  ): Promise<ManagedWorkspacePreparationOutcome>;
  /** The unsupported-platform next step (lab browse-windows). */
  onSetUpAsMachine?: () => void;
}>;

const styles = StyleSheet.create((theme) => ({
  // The card's own edge inset (ModalCardFrame), so the step lines up with the title and footer.
  body: {
    minHeight: 420,
    paddingTop: theme.space.s8,
    paddingHorizontal: theme.space.s16,
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
  },
}));

type Attempt = Readonly<{
  startedAt: number;
  outcome: ManagedWorkspacePreparationOutcome | null;
}>;

/** Preparing workspace access → the tree, in one card that never resizes (lab browse-prep / prepFail / windows). */
export function ManagedWorkspacePreparation(
  props: Readonly<{
    request: ManagedWorkspacePreparationRequest;
    title: string;
    setChrome: CustomModalInjectedProps['setChrome'];
    onPrepared(workspace: PreparedManagedWorkspace): void;
    onCancel(): void;
  }>,
) {
  const { request, onPrepared } = props;
  const [revision, retry] = React.useReducer((value: number) => value + 1, 0);
  const [attempt, setAttempt] = React.useState<Attempt>(() => ({
    startedAt: Date.now(),
    outcome: null,
  }));
  const approval = useActionApprovalContinuation({
    serverId: request.serverId,
    scopeKey: JSON.stringify([request.serverId, request.name, revision]),
    onExecuted() {},
  });
  const requestApproval = approval.requestApproval;
  React.useEffect(() => {
    const lifetime = new AbortController();
    const startedAt = Date.now();
    setAttempt({ startedAt, outcome: null });
    void request
      .run({ signal: lifetime.signal, onApprovalPending: requestApproval })
      .catch((): ManagedWorkspacePreparationOutcome => ({
        kind: 'failed',
        code: 'provider_unavailable',
        message: null,
      }))
      .then((outcome) => {
        if (lifetime.signal.aborted) return;
        if (outcome.kind === 'ready') onPrepared(outcome.workspace);
        else setAttempt({ startedAt, outcome });
      });
    return () => lifetime.abort();
  }, [request, revision, requestApproval, onPrepared]);

  const outcome = attempt.outcome;
  const running = outcome === null;
  const elapsed = useElapsedTime(attempt.startedAt, running);
  const unsupported = outcome?.kind === 'unsupported_platform';
  const failure = outcome?.kind === 'failed' ? outcome : null;
  const reason = failure
    ? failure.message ||
      resolveActionExecutionErrorMessage(
        { code: failure.code },
        t('errors.tryAgain'),
      )
    : null;

  const footer = React.useMemo(
    () => (
      <PathBrowserModalFooter label={null}>
        <RoundButton
          title={t('common.cancel')}
          size="normal"
          display="inverted"
          onPress={props.onCancel}
        />
        {failure ? (
          <RoundButton
            testID="path-browser-prepare-retry"
            title={t('common.retry')}
            size="normal"
            onPress={retry}
          />
        ) : running && approval.approvalPending ? (
          <RoundButton
            title={t('approvals.details')}
            size="normal"
            onPress={approval.openApproval}
          />
        ) : null}
      </PathBrowserModalFooter>
    ),
    [
      approval.approvalPending,
      approval.openApproval,
      failure,
      props.onCancel,
      running,
    ],
  );
  const chrome = React.useMemo(
    () => ({
      kind: 'card' as const,
      title: props.title,
      subtitle: unsupported
        ? undefined
        : t('files.pane.serverFolderHelperNote', { workspace: request.name }),
      testID: PATH_BROWSER_MODAL_TEST_ID,
      footer,
      dimensions: {
        width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
        maxHeightRatio: 0.96,
        size: 'lg' as const,
        viewportMargin: { horizontal: 12, vertical: 12 } as const,
      },
    }),
    [footer, props.title, request.name, unsupported],
  );
  useModalCardChrome(props.setChrome, chrome);

  if (unsupported) {
    return (
      <View style={[styles.body, styles.centered]}>
        <SurfaceStateCard
          testID="path-browser-unsupported-platform"
          kind="unavailable"
          iconName="hard-drives"
          title={t('files.pane.serverFolderUnsupportedTitle')}
          reason={t('files.pane.serverFolderUnsupportedBody', {
            workspace: request.name,
          })}
          action={
            request.onSetUpAsMachine
              ? {
                  label: t('settings.remoteHostsSetupAsMachineTitle'),
                  // The chooser closes; the machine flow takes over.
                  onPress: () => {
                    props.onCancel();
                    request.onSetUpAsMachine?.();
                  },
                }
              : undefined
          }
        />
      </View>
    );
  }
  if (failure && reason) {
    // A failed preparation is the chooser's one state: what failed, why, and Retry (lab browse-prepFail).
    return (
      <View style={[styles.body, styles.centered]}>
        <SurfaceStateCard
          testID="path-browser-prepare-failed"
          kind="error"
          title={t('files.pane.serverFolderPreparing')}
          reason={t('files.pane.serverFolderPrepareFailed', { reason })}
          diagnosticCode={failure.code}
        />
      </View>
    );
  }
  // Running or waiting on approval: one step with its elapsed time; Details opens the approval (footer).
  const step: SetupStep = {
    key: 'prepare',
    state: approval.approvalPending ? 'waiting' : 'running',
    title: approval.approvalPending
      ? t('managedMachines.creation.approval', { name: request.name })
      : t('files.pane.serverFolderPreparing'),
    meta: formatElapsedDuration(elapsed * 1000),
  };
  return (
    <View style={styles.body}>
      <SetupSteps
        variant="compact"
        steps={[step]}
        testID="path-browser-prepare"
      />
    </View>
  );
}
