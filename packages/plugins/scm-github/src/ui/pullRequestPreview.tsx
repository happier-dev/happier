import * as React from 'react';
import {
  Action,
  Button,
  Icon,
  Item,
  ItemGroup,
  Row,
  Stack,
  Status,
  Step,
  Text,
  usePluginHostApi,
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

/**
 * The PR's Preview step (DEPLOY-COMPOSE-1107 P15): what the one `github/pull-request/preview` Action states about
 * this pull request's preview Environments, the same read an agent makes. Nothing here decides a state: the read
 * owner selects the exact PR, derives each state from its receipt and gives a URL only for a ready preview. Every
 * next step opens the Environment in Happier (`openDeployment`), where its own review and Stop and remove live.
 */

type PreviewResult = Extract<GithubPreviewResultV1, { kind: 'preview' }>;
type PreviewChild = PreviewResult['previews'][number];
type PreviewItem = Extract<PreviewChild, { kind: 'preview' }>;
type PreviewPhase =
  | PreviewItem['state']
  | 'removing'
  | 'cleanupStopped'
  | 'unavailable';
type MarkerState = 'passed' | 'failed' | 'running' | 'open';

const shortSha = (sha: string): string => sha.slice(0, 7);

const previewCollectionProjection: PluginUiResourceProjection<string> = { decode: content => content.digest };
const selectPreviewCollection = (snapshot: PluginUiResourceProjectionSnapshot<string>) =>
  snapshot.value ?? (snapshot.error ? 'unavailable' : undefined);

/** A teardown receipt is the preview being removed: its running and failed states read as cleanup. */
function childPhase(child: PreviewChild): PreviewPhase {
  if (child.kind === 'unavailable') return 'unavailable';
  if (child.operation === 'teardown' && child.state === 'deploying')
    return 'removing';
  if (child.operation === 'teardown' && child.state === 'failed')
    return 'cleanupStopped';
  return child.state;
}

const MARKER_STATE = {
  needsApproval: 'open',
  deploying: 'running',
  removing: 'running',
  ready: 'passed',
  failed: 'failed',
  cleanupStopped: 'failed',
  removed: 'open',
  outdated: 'open',
  unavailable: 'open',
} as const satisfies Record<PreviewPhase, MarkerState>;

const SENTENCE_TONE = {
  needsApproval: 'attention',
  deploying: 'secondary',
  removing: 'secondary',
  ready: 'secondary',
  failed: 'danger',
  cleanupStopped: 'danger',
  removed: 'secondary',
  outdated: 'secondary',
  unavailable: 'secondary',
} as const satisfies Record<PreviewPhase, 'secondary' | 'attention' | 'danger'>;

/** When several previews answer, the step's own marker and sentence follow the one that needs someone first. */
const LEAD_ORDER: readonly PreviewPhase[] = [
  'cleanupStopped',
  'failed',
  'needsApproval',
  'unavailable',
  'removing',
  'deploying',
  'outdated',
  'ready',
  'removed',
];

/** One sentence per state; the step's marker reads the same sentence aloud. */
function previewSentence(text: PluginTranslate, child: PreviewChild): string {
  if (child.kind === 'unavailable')
    return text('plugins.github.ui.preview.unavailable', 'Unavailable');
  const sha = shortSha(child.servingSha);
  switch (childPhase(child)) {
    case 'ready':
      return text('plugins.github.ui.preview.ready', 'Deployed {sha}', { sha });
    case 'deploying':
      return text('plugins.github.ui.preview.deploying', 'Deploying {sha}', {
        sha,
      });
    case 'removing':
      return text('plugins.github.ui.preview.removing', 'Removing the preview');
    case 'needsApproval':
      return text(
        'plugins.github.ui.preview.needsApproval',
        'Waiting for a deployer',
      );
    case 'failed':
      return text('plugins.github.ui.preview.failed', 'Last run failed');
    case 'cleanupStopped':
      return text(
        'plugins.github.ui.preview.cleanupStopped',
        'Cleanup stopped',
      );
    case 'removed':
      return text('plugins.github.ui.preview.removed', 'Removed');
    default:
      return text(
        'plugins.github.ui.preview.outdated',
        'Serving an older commit',
      );
  }
}

/** A closed pull request whose preview still runs, or whose cleanup stopped, is cleaned up from its Environment. */
function needsCleanup(child: PreviewChild, closed: boolean): boolean {
  const phase = childPhase(child);
  return (
    phase === 'cleanupStopped' ||
    (closed &&
      (phase === 'ready' ||
        phase === 'deploying' ||
        phase === 'outdated' ||
        phase === 'failed'))
  );
}

/** What the sentence leaves out, said once under it: why it waits, which commit is behind, or why it can't be read. */
function previewReason(
  text: PluginTranslate,
  child: PreviewChild,
  headSha: string,
  closed: boolean,
): string | null {
  if (child.kind === 'unavailable') return failureText(text, child.failure);
  const phase = childPhase(child);
  if (phase === 'cleanupStopped')
    return text(
      'plugins.github.ui.preview.cleanupStopped.reason',
      'Some of the preview is still up. Its Environment says which step stopped.',
    );
  if (closed && needsCleanup(child, closed))
    return text(
      'plugins.github.ui.preview.closedRunning.reason',
      'This pull request is closed, and its preview is still up.',
    );
  if (phase === 'needsApproval')
    return text(
      'plugins.github.ui.preview.needsApproval.reason',
      'A deployer approves {sha} before it deploys.',
      { sha: shortSha(child.servingSha) },
    );
  if (phase === 'outdated')
    return text(
      'plugins.github.ui.preview.outdated.reason',
      '{serving} is live. The newest push, {head}, hasn’t deployed yet.',
      { serving: shortSha(child.servingSha), head: shortSha(headSha) },
    );
  return null;
}

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
      ? buildGithubPreviewEnvironmentQueryV1(serverId, route, localRef.entryId) : null;
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

type OpenDeployment = (
  request: Readonly<{
    environmentId: string;
    receiptId?: string;
    tab?: string;
  }>,
) => void;

/** Opens the Environment in Happier; null on a host that does not offer `openDeployment`. */
function useOpenDeployment(serverId: string | null): OpenDeployment | null {
  const host = usePluginHostApi();
  const offered = host.version().methods.includes('openDeployment');
  return React.useMemo(
    () =>
      !offered || serverId === null
        ? null
        : (request) => {
            void host
              .openDeployment({ ...request, serverId })
              .catch(() => undefined);
          },
    [host, offered, serverId],
  );
}

/**
 * The Preview step under Checks. It is drawn once the read states a preview or fails: a pull request with no
 * preview shows nothing, and nothing is reserved for a step most pull requests never have.
 */
export function GithubPullRequestPreviewStep({
  input,
  closed,
}: Readonly<{
  input: TriageDetailSurfaceInputV1;
  /** The pull request is closed or merged (the Overview's own read). */
  closed: boolean;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { result, serverId, retry } = useGithubPullRequestPreview(input);
  const open = useOpenDeployment(serverId);
  if (result === null) return null;
  if (result.kind === 'unavailable') {
    const label = text('plugins.github.ui.preview.unavailable', 'Unavailable');
    return (
      <Step
        title="Preview"
        titleKey="plugins.github.ui.preview.title"
        marker={{ kind: 'state', state: 'open', label }}
        trailing={<Text variant="meta" tone="secondary" value={label} />}
      >
        <Status
          tone="muted"
          label={text(
            'plugins.github.ui.preview.readFailed',
            'Couldn’t read this pull request’s preview',
          )}
          value={failureText(text, result.failure)}
          action={
            <Button
              variant="secondary"
              size="small"
              title={text('plugins.github.ui.preview.retry', 'Retry')}
              onPress={retry}
            />
          }
        />
        <GithubReadFailureDetails failures={[result.failure]} />
      </Step>
    );
  }
  const children = result.previews;
  if (children.length === 0) return null;
  const lead = [...children].sort(
    (a, b) =>
      LEAD_ORDER.indexOf(childPhase(a)) - LEAD_ORDER.indexOf(childPhase(b)),
  )[0]!;
  const single = children.length === 1;
  const leadSentence = previewSentence(text, lead);
  const trailing = single
    ? leadSentence
    : text('plugins.github.ui.preview.count', '{count} previews', {
        count: children.length,
      });
  return (
    <Step
      title="Preview"
      titleKey="plugins.github.ui.preview.title"
      marker={{
        kind: 'state',
        state: MARKER_STATE[childPhase(lead)],
        label: leadSentence,
      }}
      trailing={
        <Text
          variant="meta"
          tone={single ? SENTENCE_TONE[childPhase(lead)] : 'secondary'}
          value={trailing}
        />
      }
    >
      {single ? (
        <SinglePreview
          child={lead}
          headSha={result.headSha}
          closed={closed}
          open={open}
        />
      ) : (
        <ItemGroup>
          {children.map((child) => (
            <PreviewRow
              key={child.environmentId}
              child={child}
              headSha={result.headSha}
              closed={closed}
              open={open}
            />
          ))}
        </ItemGroup>
      )}
    </Step>
  );
}

const readyUrl = (child: PreviewChild): string | null =>
  child.kind === 'preview' && child.state === 'ready' ? child.targetUrl : null;

/** A lone preview: its sentence is already the step's, so under it go only the address, the reason and its next step. */
function SinglePreview({
  child,
  headSha,
  closed,
  open,
}: Readonly<{
  child: PreviewChild;
  headSha: string;
  closed: boolean;
  open: OpenDeployment | null;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const url = readyUrl(child);
  const reason = previewReason(text, child, headSha, closed);
  const next = <PreviewNextStep child={child} closed={closed} open={open} />;
  if (url === null && reason === null && !hasNextStep(child, closed, open)
    && (child.kind !== 'preview' || child.publication === undefined)
    && (!child.controller || child.controller.state === 'available'))
    return null;
  return (
    <Stack gap="small">
      {url === null ? null : (
        <ItemGroup>
          <PreviewAddressRow url={url} />
        </ItemGroup>
      )}
      {reason === null ? null : (
        <Text variant="body" tone="secondary" value={reason} />
      )}
      {next}
      {child.kind === 'unavailable' ? <GithubReadFailureDetails failures={[child.failure]} /> : null}
      <PreviewController child={child} open={open} />
      {child.kind === 'preview' && child.publication ? <PreviewPublication key={`${child.deploymentId}:${child.state}`} publication={child.publication} /> : null}
    </Stack>
  );
}

function PreviewRow({
  child,
  headSha,
  closed,
  open,
}: Readonly<{
  child: PreviewChild;
  headSha: string;
  closed: boolean;
  open: OpenDeployment | null;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const url = readyUrl(child);
  const reason = previewReason(text, child, headSha, closed);
  return (
    <Stack gap="small">
    {url !== null && !needsCleanup(child, closed) ? <PreviewAddressRow url={url} /> :
    <Item
      title={url ?? previewSentence(text, child)}
      {...(reason === null ? {} : { subtitle: reason })}
      accessoryWraps
      accessory={<PreviewNextStep child={child} closed={closed} open={open} />}
    />}
    {child.kind === 'unavailable' ? <GithubReadFailureDetails failures={[child.failure]} /> : null}
    {child.kind === 'preview' && child.publication ? <PreviewPublication key={`${child.deploymentId}:${child.state}`} publication={child.publication} /> : null}
    <PreviewController child={child} open={open} />
    </Stack>
  );
}

/** The Environment owner supplies reachability independently of the app's serving receipt. */
function PreviewController({ child, open }: Readonly<{ child: PreviewChild; open: OpenDeployment | null }>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (!child.controller || child.controller.state === 'available') return null;
  return <Item title={child.controller.state === 'paused'
    ? text('plugins.github.ui.preview.controllerPaused', 'Controller paused')
    : text('plugins.github.ui.preview.controllerUnknown', 'Controller availability unknown')}
    subtitle={text('plugins.github.ui.preview.controllerRecovery', 'Bring the controller online or choose another Machine.')}
    accessoryWraps accessory={open === null ? undefined : <Button size="small" variant="plain"
      title={text('plugins.github.ui.preview.chooseController', 'Choose another controller')}
      onPress={() => open({ environmentId: child.environmentId, tab: 'settings' })} />} />;
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

function hasNextStep(
  child: PreviewChild,
  closed: boolean,
  open: OpenDeployment | null,
): boolean {
  if (open === null || child.kind === 'unavailable') return false;
  const phase = childPhase(child);
  return (
    needsCleanup(child, closed) ||
    phase === 'needsApproval' ||
    phase === 'failed' ||
    phase === 'removed'
  );
}

/**
 * The one next step a preview offers, each opening its Environment in Happier: Clean up (or Retry cleanup) at
 * the Environment, where Stop and remove lives; Review or Open receipt at the receipt; History once it is removed.
 */
function PreviewNextStep({
  child,
  closed,
  open,
}: Readonly<{
  child: PreviewChild;
  closed: boolean;
  open: OpenDeployment | null;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  if (
    !hasNextStep(child, closed, open) ||
    open === null ||
    child.kind === 'unavailable'
  )
    return null;
  const phase = childPhase(child);
  const environmentId = child.environmentId;
  const receipt = { environmentId, receiptId: child.deploymentId };
  const [title, request, variant] =
    phase === 'cleanupStopped'
      ? [
          text('plugins.github.ui.preview.retryCleanup', 'Retry cleanup'),
          { environmentId },
          'primary' as const,
        ]
      : needsCleanup(child, closed)
        ? [
            text('plugins.github.ui.preview.cleanUp', 'Clean up'),
            { environmentId },
            'secondary' as const,
          ]
        : phase === 'needsApproval'
          ? [
              text('plugins.github.ui.preview.review', 'Review'),
              receipt,
              'secondary' as const,
            ]
          : phase === 'failed'
            ? [
                text('plugins.github.ui.preview.openReceipt', 'Open receipt'),
                receipt,
                'secondary' as const,
              ]
            : [
                text('plugins.github.ui.preview.history', 'History'),
                { environmentId, tab: 'history' },
                'plain' as const,
              ];
  return (
    <Row gap="small">
      <Button
        variant={variant}
        size="small"
        title={title}
        onPress={() => open(request)}
      />
    </Row>
  );
}

/** A ready preview's address: the URL comes only from the read owner's ready fact. */
function PreviewAddressRow({
  url,
}: Readonly<{ url: string }>): React.ReactElement {
  const text = usePluginTranslation();
  return (
    <Item
      title={url}
      icon={<Icon name="globe" size="small" tone="secondary" />}
      accessoryWraps
      accessory={
        <Row gap="small">
          <Action.Copy
            value={url}
            title={text('plugins.github.ui.preview.copy', 'Copy URL')}
          />
          <Action.OpenExternal
            url={url}
            title={text('plugins.github.ui.preview.open', 'Open')}
          />
        </Row>
      }
    />
  );
}
