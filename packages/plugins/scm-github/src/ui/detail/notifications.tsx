import * as React from 'react';
import { Item, ItemGroup, LoadingState, useExecutePluginAction, usePluginTranslation } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { GITHUB_PLUGIN_ID } from '../../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../triage/contribution.js';
import { GithubIssueFactsResultV1Schema, type GithubIssueFactsResultV1 } from '../../triage/detail/contracts.js';
import { dispatchFailure, ROUTE_UNAVAILABLE, UNREADABLE_RESULT, useGithubRoutingToken } from './readBoundary.js';
import { GithubReadFailure } from './readFailure.js';
import type { GithubReadStateV1 } from './panelState.js';

export type GithubIssueNotificationFactsV1 = Extract<GithubIssueFactsResultV1, { kind: 'issueFacts' }>;
export type GithubIssueNotificationUpdateV1 = Partial<Pick<GithubIssueNotificationFactsV1, 'isPinned' | 'viewerSubscription'>>;
type RenderControls = (facts: GithubIssueNotificationFactsV1, update: (patch: GithubIssueNotificationUpdateV1) => void) => React.ReactNode;

/** Issue-only facts are read on first expansion; mutation receipts maintain the visible facts. */
export function GithubIssueNotifications({ input, renderControls }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  renderControls: RenderControls;
}>): React.ReactElement {
  const request = useTriageDetailRequest(input);
  const routingToken = useGithubRoutingToken(input);
  return <GithubIssueNotificationBody key={JSON.stringify([request, routingToken])}
    request={request} routingToken={routingToken} renderControls={renderControls} />;
}

function GithubIssueNotificationBody({ request, routingToken, renderControls }: Readonly<{
  request: ReturnType<typeof useTriageDetailRequest>;
  routingToken: string | null;
  renderControls: RenderControls;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const action = React.useMemo(() => ({ pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readIssueFacts }), []);
  const { execute } = useExecutePluginAction(action);
  const [open, setOpen] = React.useState(false);
  const [demanded, setDemanded] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<GithubReadStateV1<GithubIssueNotificationFactsV1>>({ kind: 'loading' });
  React.useEffect(() => {
    if (!demanded) return;
    const controller = new AbortController();
    setState({ kind: 'loading' });
    if (routingToken === null) {
      setState({ kind: 'unavailable', failure: ROUTE_UNAVAILABLE });
      return () => controller.abort();
    }
    void (async () => {
      const execution = await execute({ v: 1, ...request, routingToken }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (execution.status !== 'success') {
        setState({ kind: 'unavailable', failure: dispatchFailure(execution, 'github-issue-facts-read-failed') });
        return;
      }
      const parsed = GithubIssueFactsResultV1Schema.safeParse(execution.result);
      setState(!parsed.success ? { kind: 'unavailable', failure: UNREADABLE_RESULT }
        : parsed.data.kind === 'unavailable' ? parsed.data : { kind: 'ready', value: parsed.data });
    })();
    return () => controller.abort();
  }, [attempt, demanded, execute, request, routingToken]);
  const update = React.useCallback((patch: GithubIssueNotificationUpdateV1) => {
    setState(current => current.kind === 'ready' ? { kind: 'ready', value: { ...current.value, ...patch } } : current);
  }, []);
  return <ItemGroup>
    <Item title={text('plugins.github.ui.notifications.title', 'Notifications')}
      expanded={open} onPress={() => { setOpen(current => !current); setDemanded(true); }}
      {...(open ? { expandedContent: state.kind === 'ready' ? renderControls(state.value, update)
        : state.kind === 'unavailable' ? <GithubReadFailure
          title={text('plugins.github.ui.notifications.readFailed', 'Notifications could not be read.')}
          failures={[state.failure]} refresh={() => setAttempt(current => current + 1)} />
          : <LoadingState title={text('plugins.github.ui.notifications.loading', 'Reading notifications…')} /> } : {})}
    />
  </ItemGroup>;
}
