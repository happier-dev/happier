import * as React from 'react';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
  LoadingState,
  Stack,
  SurfaceState,
  Text,
  defineUiSurface,
  usePluginHostApi,
  usePluginTranslation,
  useSessionState,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

import {
  useTriageSessionPullRequestStatusV1,
  type TriageSessionPullRequestProjectionSnapshotV1,
} from '../sessions/sessionPullRequestStatus.js';
import { PullRequestGlance } from '../sessions/pullRequestGlance/PullRequestGlance.js';
import { PullRequestReadFailure } from '../sessions/pullRequestGlance/PullRequestReadFailure.js';
import { LinkedPullRequestSelector, useLinkedPullRequestSelection } from '../sessions/pullRequestGlance/LinkedPullRequestSelector.js';
import { usePullRequestWatchConfigureV1 } from '../sessions/pullRequestGlance/useWatchConfigure.js';
import { PendingApprovalLine } from '../sessions/pullRequestGlance/PendingApprovalLine.js';
import { usePullRequestGlanceNavigationV1 } from '../sessions/pullRequestGlance/useGlanceNavigation.js';
import { usePullRequestOperationsV1 } from '../sessions/pullRequestGlance/usePullRequestOperations.js';
import { TriageSourceWriteCluster } from './header/sourceWriteCluster.js';
import { TriageSessionPullRequestComposer } from './sessionPullRequestComposer.js';

const selectSnapshot = (
  snapshot: TriageSessionPullRequestProjectionSnapshotV1,
) => snapshot;

/**
 * The Companion's Pull request glance (c6). It reads the one shared Session PR Resource — the same read the
 * Git card, the chip menu and the linked-entry detail use — and draws nothing of its own about readiness.
 * Several linked PRs pick one through a segmented control before anything about it is edited.
 */
export function TriageSessionPullRequestWidget(props: Readonly<{
  signal: AbortSignal;
  initialBindingId?: string;
  onResourceOpened?(): void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { target } = useSurfaceContext();
  const sessionId = target.kind === 'session' ? target.sessionId : null;
  const { value: snapshot, refresh } = useTriageSessionPullRequestStatusV1(
    selectSnapshot,
    sessionId !== null,
  );
  const session = useSessionState(sessionId);
  const agent = session.state?.agent?.displayName ?? null;
  const watch = usePullRequestWatchConfigureV1(sessionId, refresh);
  const homeServerId = useSurfaceContext().accountScope?.serverId ?? null;
  const navigationSession = React.useMemo(() => homeServerId !== null && sessionId !== null ? { serverId: homeServerId, sessionId } : null, [homeServerId, sessionId]);
  const navigation = usePullRequestGlanceNavigationV1(navigationSession, props.signal);
  const result = snapshot.value;
  const bindings =
    result?.kind === 'ready' && result.sessionId === sessionId
      ? result.pullRequests
      : null;
  const { selectedId, choose } = useLinkedPullRequestSelection(bindings, props.initialBindingId);
  const selected =
    bindings?.find((binding) => binding.bindingId === selectedId) ?? null;
  const { primaryWrite } = usePullRequestOperationsV1(sessionId, selected?.bindingId ?? null, props.signal);

  if (sessionId === null) {
    return (
      <SurfaceState
        kind="empty"
        size="line"
        title={text(
          'plugins.triage.prGlance.noSession',
          'Open a session to see its pull request',
        )}
      />
    );
  }
  if (result === undefined) {
    if (snapshot.error !== undefined && snapshot.pending === 'idle') {
      return <PullRequestReadFailure snapshot={snapshot} refresh={refresh} testID="pr-widget" />;
    }
    // The glance keeps its place while the first read lands: identity, facts and the watch line, in outline.
    return (
      <LoadingState rows={3} testID="pr-widget.loading" title={text('plugins.triage.prGlance.loading', 'Reading this session’s pull request')} />
    );
  }
  if (result.kind === 'unavailable') {
    return <PullRequestReadFailure snapshot={snapshot} refresh={refresh} testID="pr-widget" />;
  }
  if (bindings === null || bindings.length === 0 || selected === null) {
    return (
      <SurfaceState
        kind="empty"
        size="line"
        testID="pr-widget.empty"
        title={text(
          'plugins.triage.prGlance.empty',
          'No pull request is linked to this session',
        )}
        description={text(
          'plugins.triage.prGlance.emptyDetail',
          'Link one from the Git pane or PRs & Issues; it shows here with its checks and review.',
        )}
      />
    );
  }
  const configuring =
    watch.state.kind === 'pending' &&
    watch.state.bindingId === selected.bindingId;
  return (
    <Stack gap="medium" testID="pr-widget">
      <PullRequestReadFailure snapshot={snapshot} refresh={refresh} testID="pr-widget" />
      <LinkedPullRequestSelector bindings={bindings} selectedId={selected.bindingId} onChange={choose}
        testID="pr-widget.select" />
      {watch.state.kind === 'approval' &&
      watch.state.bindingId === selected.bindingId ? (
        <PendingApprovalLine />
      ) : null}
      {watch.state.kind === 'failed' &&
      watch.state.bindingId === selected.bindingId ? (
        <Text
          variant="meta"
          tone="danger"
          value={text(
            'plugins.triage.prGlance.configureFailed',
            'That didn’t go through. The pull request and its watch are unchanged.',
          )}
        />
      ) : null}
      <PullRequestGlance
        binding={selected}
        title={null}
        agent={agent}
        configuring={configuring}
        onConfigure={(policy) => {
          void watch.configure(selected, policy);
        }}
        onUnlink={() => {
          void watch.unlink(selected);
        }}
        onContinueFixing={() => watch.continueFixing(selected)}
        onOpenProvider={async () => {
          try {
            await host.openResource({ kind: 'pullRequest', url: selected.link.url }, { signal: props.signal });
          } catch {
            return;
          }
          props.onResourceOpened?.();
        }}
        onReconnect={() => {
          void host.openConnectedAccounts();
        }}
        onOpenLatest={navigation.latestOpener(selected)}
        onRunLocally={() => navigation.runLocally(selected)}
        runLocallyUnavailable={navigation.localOpen === 'unavailable'}
      />
      {primaryWrite === null ? null : <TriageSourceWriteCluster write={primaryWrite} />}
      {primaryWrite?.feedback}
    </Stack>
  );
}

export const renderSurface: RenderSurface = defineUiSurface((context) => {
  const input = context.launchInput;
  if (input !== null && typeof input === 'object' && !Array.isArray(input)
    && Reflect.get(input, 'role') === 'region') {
    return <TriageSessionPullRequestComposer launchInput={input}
      renderDetails={(bindingId, onResourceOpened) => <TriageSessionPullRequestWidget
        signal={context.signal} initialBindingId={bindingId} onResourceOpened={onResourceOpened} />}
    />;
  }
  return <TriageSessionPullRequestWidget signal={context.signal} />;
});
