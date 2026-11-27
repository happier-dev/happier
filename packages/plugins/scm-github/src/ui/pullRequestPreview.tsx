import * as React from 'react';
import {
  Action,
  Item,
  PullRequestPreviewSection,
  usePluginTranslation,
  useExecutePluginAction,
  projectPluginActionControlExecutionV1,
  isPluginActionConfirmationDeclined,
  useSurfaceContext,
  useTabPanelActivity,
  type PluginTranslate,
} from '@happier-dev/plugin-ui';
import {
  describeTriageSourceFailureV1,
  type TriageDetailSurfaceInputV1,
  type TriageSourceFailureV1,
} from '@happier-dev/triage-protocol/v1';
import type { PluginUiActionControlController } from '@happier-dev/plugin-sdk/ui';
import { useTriageDetailRequest } from '@happier-dev/triage-sources/ui';
import { useLivePluginResourceProjection, type PluginUiResourceProjection, type PluginUiResourceProjectionSnapshot } from '@happier-dev/plugin-ui/hostApi';
import { buildGithubPreviewEnvironmentQueryV1 } from '../triage/previewQuery.js';
import { parseGithubRoutingToken } from '../triage/locator.js';

import { GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1, GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1 } from '../triage/contribution.js';
import { GithubPullRequestPreviewStatusResultV1Schema } from '../triage/mutations/contracts.js';
import {
  GithubPreviewResultV1Schema,
  type GithubPreviewResultV1,
} from '../triage/detail/contracts.js';
import {
  dispatchFailure,
  UNREADABLE_RESULT,
  type ExecuteResult,
} from './detail/readBoundary.js';
import { GithubReadFailureDetails } from './detail/readFailure.js';

type PreviewResult = Extract<GithubPreviewResultV1, { kind: 'preview' }>;
type PreviewChild = PreviewResult['previews'][number];
type PreviewItem = Extract<PreviewChild, { kind: 'preview' }>;
const previewCollectionProjection: PluginUiResourceProjection<string> = { decode: content => content.digest };
const selectPreviewCollection = (snapshot: PluginUiResourceProjectionSnapshot<string>) =>
  snapshot.value ?? (snapshot.error ? 'unavailable' : undefined);

function failureText(
  text: PluginTranslate,
  failure: TriageSourceFailureV1,
): string {
  return describeTriageSourceFailureV1(
    failure,
    text(
      'plugins.github.ui.readFailed',
      'GitHub could not complete this read.',
    ),
    text,
  );
}

/**
 * The existing deployment collection wakes the same canonical PR read when receipts or cleanup change.
 * Its first snapshot precedes the initial Action, so a change during mounting cannot become a stale baseline.
 */
function useGithubPullRequestPreview(
  input: TriageDetailSurfaceInputV1,
): Readonly<{
  result: GithubPreviewResultV1 | null;
  serverId: string | null;
  retry: () => void;
}> {
  const surface = useSurfaceContext();
  const serverId = surface.accountScope?.serverId ?? null;
  const pullRequest = input.observation.entryRef.kindId === 'pull-request';
  const action = React.useMemo(
    () => ({
      pluginId: GITHUB_PLUGIN_ID,
      localId: GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.readPreview,
    }),
    [],
  );
  const { execute } = useExecutePluginAction(action);
  const { instance, localRef } = useTriageDetailRequest(input);
  const routingToken = input.observation.locator.routingToken ?? null;
  const observedHead =
    input.observation.snapshot.reviewRevision?.headSha ?? null;
  const { active, activeSignal } = useTabPanelActivity();
  const [attempt, setAttempt] = React.useState(0);
  const query = React.useMemo(() => {
    const route = routingToken === null ? null : parseGithubRoutingToken(routingToken);
    return serverId !== null && route !== null
      ? buildGithubPreviewEnvironmentQueryV1(serverId, route, [localRef.entryId]) : null;
  }, [serverId, routingToken, localRef.entryId]);
  const observedCollection = useLivePluginResourceProjection({ hostRead: 'deployments.environments.list', input: query ?? { serverId: serverId ?? '' } },
    previewCollectionProjection, selectPreviewCollection, { enabled: pullRequest && query !== null && active }).value;
  const collection = query === null ? 'unavailable' : observedCollection;
  const authority = React.useMemo(
    () => ({
      instance,
      localRef,
      routingToken,
      serverId,
      observedHead,
      attempt,
      collection,
    }),
    [instance, localRef, routingToken, serverId, observedHead, attempt, collection],
  );
  const [settled, setSettled] = React.useState<Readonly<{
    authority: typeof authority;
    result: GithubPreviewResultV1;
  }> | null>(null);
  const readable = pullRequest && serverId !== null && routingToken !== null;
  const settledAuthority = settled?.authority;
  React.useEffect(() => {
    if (
      !readable ||
      collection === undefined ||
      !active ||
      activeSignal.aborted ||
      settledAuthority === authority
    )
      return undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    activeSignal.addEventListener('abort', abort);
    void execute(
      { v: 1, instance, localRef, routingToken, serverId },
      { signal: controller.signal },
    ).then((execution: ExecuteResult) => {
      if (controller.signal.aborted) return;
      const parsed =
        execution.status === 'success'
          ? GithubPreviewResultV1Schema.safeParse(execution.result)
          : null;
      const failure = (value: TriageSourceFailureV1) =>
        dispatchFailure(execution, 'github-preview-read-failed', value);
      const result: GithubPreviewResultV1 =
        execution.status !== 'success'
          ? {
              kind: 'unavailable',
              failure: dispatchFailure(execution, 'github-preview-read-failed'),
            }
          : parsed?.success
            ? parsed.data.kind === 'unavailable'
              ? { ...parsed.data, failure: failure(parsed.data.failure) }
              : { ...parsed.data, previews: parsed.data.previews.map(child =>
                  child.kind === 'unavailable'
                    ? { ...child, failure: failure(child.failure) }
                    : child.publication?.kind === 'unavailable'
                      ? { ...child, publication: { ...child.publication,
                          failure: failure(child.publication.failure) } }
                      : child) }
            : { kind: 'unavailable', failure: failure(UNREADABLE_RESULT) };
      setSettled({ authority, result });
    });
    return () => {
      activeSignal.removeEventListener('abort', abort);
      controller.abort();
    };
  }, [
    readable,
    collection,
    active,
    activeSignal,
    authority,
    settledAuthority,
    execute,
    instance,
    localRef,
    routingToken,
    serverId,
  ]);
  const retry = React.useCallback(() => setAttempt((value) => value + 1), []);
  // The last settled previews stay in place while a read for a newer head settles.
  return {
    result: readable ? (settled?.result ?? null) : null,
    serverId,
    retry,
  };
}

/** The Forge adapter owns the admitted read and GitHub's publication control. */
export function GithubPullRequestPreviewStep({
  input, closed,
}: Readonly<{ input: TriageDetailSurfaceInputV1; closed: boolean }>): React.ReactElement {
  const text = usePluginTranslation();
  const { result, serverId, retry } = useGithubPullRequestPreview(input);
  return <PullRequestPreviewSection<TriageSourceFailureV1, PreviewChild>
    result={result} serverId={serverId} retry={retry} closed={closed}
    text={(key, fallback, params) => text(`plugins.github.ui.${key}`, fallback, params)}
    describeFailure={failure => failureText(text, failure)}
    renderFailureDetails={failure => <GithubReadFailureDetails failures={[failure]} />}
    renderPublication={child => child.kind === 'preview' && child.publication
      ? <PreviewPublication key={`${child.deploymentId}:${child.state}`} publication={child.publication} /> : null}
  />;
}

/** A failed PR update never changes the receipt's readiness or starts another deploy. */
function PreviewPublication({ publication }: Readonly<{ publication: NonNullable<PreviewItem['publication']> }>): React.ReactElement {
  const text = usePluginTranslation();
  const action = React.useMemo(() => ({ pluginId: GITHUB_PLUGIN_ID,
    localId: GITHUB_TRIAGE_MUTATION_ACTION_IDS_V1.pullRequestPreviewStatus }), []);
  const { activeSignal } = useTabPanelActivity();
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<ReturnType<typeof GithubPullRequestPreviewStatusResultV1Schema.parse> | null>(null);
  const current = publication.kind === 'current' || result?.kind === 'applied';
  const failure = result?.kind === 'failed' || result?.kind === 'uncertain' ? result.failure
    : publication.kind === 'unavailable' ? publication.failure : undefined;
  const retryControl = React.useMemo(() => ({
    prepare: ({ signal }) => {
      if (signal.aborted || publication.kind === 'current') return null;
      setBusy(true);
      return { input: publication.input };
    },
    onSettled: settlement => {
      setBusy(false);
      const execution = projectPluginActionControlExecutionV1(settlement, text);
      if (isPluginActionConfirmationDeclined(execution) || execution.status === 'idle' || execution.status === 'pending') return;
      if (execution.status === 'success') {
        const parsed = GithubPullRequestPreviewStatusResultV1Schema.safeParse(execution.result);
        setResult(parsed.success ? parsed.data : { kind: 'failed', failure: UNREADABLE_RESULT });
      } else {
        const failure = dispatchFailure(execution, 'github-preview-status-failed');
        setResult(execution.status === 'outcomeUnknown' ? { kind: 'uncertain', failure } : { kind: 'failed', failure });
      }
    },
  } satisfies PluginUiActionControlController), [publication, text]);
  return <><Item title={current ? text('plugins.github.ui.preview.prUpdated', 'PR updated')
    : result?.kind === 'uncertain' ? text('plugins.github.ui.preview.prUpdateUnconfirmed', 'PR update not confirmed')
    : failure || result?.kind === 'refused' ? text('plugins.github.ui.preview.prUpdateUnavailable', 'PR update unavailable')
    : text('plugins.github.ui.preview.prUpdatePending', 'PR update pending')}
    {...(failure ? { subtitle: failureText(text, failure) } : result?.kind === 'refused' ? { subtitle: result.reason } : {})}
    accessory={current ? undefined : <Action.Control action={action} controller={retryControl} signal={activeSignal}
      variant="plain" disabled={busy}
      title={busy ? text('plugins.github.ui.preview.prUpdating', 'Updating PR…') : text('plugins.github.ui.preview.retryPrUpdate', 'Retry PR update')} />} />
    {failure ? <GithubReadFailureDetails failures={[failure]} /> : null}
  </>;
}
