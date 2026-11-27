import * as React from 'react';
import type { OpenDeploymentRequest } from '@happier-dev/plugin-sdk/ui';
import type {
  DeploymentReceiptHeaderV1,
  ProtocolDeploymentControllerAvailabilityV1Schema,
} from '@happier-dev/plugin-sdk/protocol';

import { usePluginHostApi } from '../hostApi/context.js';
import { Action } from './Action.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import { Item, ItemGroup } from './List.js';
import { Row, Stack } from './Layout.js';
import type { PluginTranslate } from './PluginUiProvider.js';
import { Status } from './Status.js';
import { Step } from './Step.js';
import { Text } from './Text.js';

type PreviewState = 'needsApproval' | 'deploying' | 'ready' | 'failed' | 'removed' | 'outdated';
type Controller = ReturnType<typeof ProtocolDeploymentControllerAvailabilityV1Schema.parse>;
type Environment = Readonly<{ environmentId: string; controller?: Controller }>;

export type PullRequestPreviewChild<Failure = unknown> = Environment & (
  | Readonly<{ kind: 'unavailable'; failure: Failure }>
  | Readonly<{
      kind: 'preview';
      deploymentId: string;
      operation: DeploymentReceiptHeaderV1['operation'];
      servingSha: string;
      state: PreviewState;
      targetUrl: string | null;
    }>
);

export type PullRequestPreviewSectionProps<Failure, Child extends PullRequestPreviewChild<Failure>> = Readonly<{
  result: Readonly<{ kind: 'preview'; headSha: string; previews: readonly Child[] }>
    | Readonly<{ kind: 'unavailable'; failure: Failure }>
    | null;
  closed: boolean;
  serverId: string | null;
  retry: () => void;
  presentation?: 'detail' | 'badge';
  /** Receives shared keys such as preview.title with their English fallbacks. */
  text: PluginTranslate;
  describeFailure?: (failure: Failure) => string;
  renderFailureDetails?: (failure: Failure) => React.ReactNode;
  renderPublication?: (child: Child) => React.ReactNode;
}>;

type PreviewPhase = PreviewState | 'removing' | 'cleanupStopped' | 'unavailable';
type MarkerState = 'passed' | 'failed' | 'running' | 'open';
type OpenDeployment = (request: Omit<OpenDeploymentRequest, 'serverId'>) => void;
type ChildPresentation<Failure, Child extends PullRequestPreviewChild<Failure>> = Pick<
  PullRequestPreviewSectionProps<Failure, Child>, 'closed' | 'text' | 'describeFailure' | 'renderFailureDetails' | 'renderPublication'
> & Readonly<{ child: Child; headSha: string; open: OpenDeployment | null; grouped: boolean }>;

const shortSha = (sha: string): string => sha.slice(0, 7);

/** A teardown receipt is the preview being removed: its running and failed states read as cleanup. */
function childPhase(child: PullRequestPreviewChild): PreviewPhase {
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
function previewSentence(text: PluginTranslate, child: PullRequestPreviewChild): string {
  if (child.kind === 'unavailable')
    return text('preview.unavailable', 'Unavailable');
  const sha = shortSha(child.servingSha);
  switch (childPhase(child)) {
    case 'ready':
      return text('preview.ready', 'Deployed {sha}', { sha });
    case 'deploying':
      return text('preview.deploying', 'Deploying {sha}', {
        sha,
      });
    case 'removing':
      return text('preview.removing', 'Removing the preview');
    case 'needsApproval':
      return text(
        'preview.needsApproval',
        'Waiting for a deployer',
      );
    case 'failed':
      return text('preview.failed', 'Last run failed');
    case 'cleanupStopped':
      return text(
        'preview.cleanupStopped',
        'Cleanup stopped',
      );
    case 'removed':
      return text('preview.removed', 'Removed');
    default:
      return text(
        'preview.outdated',
        'Serving an older commit',
      );
  }
}

/** A closed pull request whose preview still runs, or whose cleanup stopped, is cleaned up from its Environment. */
function needsCleanup(child: PullRequestPreviewChild, closed: boolean): boolean {
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
function previewReason<Failure>(
  text: PluginTranslate,
  child: PullRequestPreviewChild<Failure>,
  headSha: string,
  closed: boolean,
  describeFailure?: (failure: Failure) => string,
): string | null {
  if (child.kind === 'unavailable') return describeFailure?.(child.failure) ?? null;
  const phase = childPhase(child);
  if (phase === 'cleanupStopped')
    return text(
      'preview.cleanupStopped.reason',
      'Some of the preview is still up. Its Environment says which step stopped.',
    );
  if (closed && needsCleanup(child, closed))
    return text(
      'preview.closedRunning.reason',
      'This pull request is closed, and its preview is still up.',
    );
  if (phase === 'needsApproval')
    return text(
      'preview.needsApproval.reason',
      'A deployer approves {sha} before it deploys.',
      { sha: shortSha(child.servingSha) },
    );
  if (phase === 'outdated')
    return text(
      'preview.outdated.reason',
      '{serving} is live. The newest push, {head}, hasn’t deployed yet.',
      { serving: shortSha(child.servingSha), head: shortSha(headSha) },
    );
  return null;
}

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
 * Present an admitted PR preview read. Use the badge with the same projection in
 * a list row and the detail section in the selected pull request.
 */
export function PullRequestPreviewSection<Failure, Child extends PullRequestPreviewChild<Failure>>(
  props: PullRequestPreviewSectionProps<Failure, Child>,
): React.ReactElement | null {
  const { result, presentation = 'detail', text } = props;
  if (result === null || (result.kind === 'preview' && result.previews.length === 0)) return null;
  const lead = result.kind === 'preview'
    ? result.previews.reduce((first, child) =>
      LEAD_ORDER.indexOf(childPhase(child)) < LEAD_ORDER.indexOf(childPhase(first)) ? child : first)
    : null;
  const label = lead ? previewSentence(text, lead) : text('preview.unavailable', 'Unavailable');
  const phase = lead ? childPhase(lead) : 'unavailable';
  if (presentation === 'badge') {
    return <Status presentation="inline" tone={SENTENCE_TONE[phase]} label={label} />;
  }
  return <PreviewDetail {...props} result={result} phase={phase} label={label} />;
}

function PreviewDetail<Failure, Child extends PullRequestPreviewChild<Failure>>({
  result, serverId, retry, text, phase, label, ...childProps
}: PullRequestPreviewSectionProps<Failure, Child> & Readonly<{
  result: NonNullable<PullRequestPreviewSectionProps<Failure, Child>['result']>;
  phase: PreviewPhase;
  label: string;
}>): React.ReactElement {
  const open = useOpenDeployment(serverId);
  const title = text('preview.title', 'Preview');
  if (result.kind === 'unavailable') {
    return (
      <Step title={title} marker={{ kind: 'state', state: 'open', label }}
        trailing={<Text variant="meta" tone="secondary" value={label} />}>
        <Status tone="muted" label={text('preview.readFailed', 'Couldn’t read this pull request’s preview')}
          value={childProps.describeFailure?.(result.failure)}
          action={<Button variant="secondary" size="small" title={text('preview.retry', 'Retry')} onPress={retry} />} />
        {childProps.renderFailureDetails?.(result.failure)}
      </Step>
    );
  }
  const grouped = result.previews.length > 1;
  const trailing = grouped ? text('preview.count', '{count} previews', { count: result.previews.length }) : label;
  const content = result.previews.map(child => <PreviewBody key={child.environmentId} {...childProps}
    child={child} grouped={grouped} headSha={result.headSha} text={text} open={open} />);
  return (
    <Step title={title} marker={{ kind: 'state', state: MARKER_STATE[phase], label }}
      trailing={<Text variant="meta" tone={grouped ? 'secondary' : SENTENCE_TONE[phase]} value={trailing} />}>
      {grouped ? <ItemGroup>{content}</ItemGroup> : content}
    </Step>
  );
}

function PreviewBody<Failure, Child extends PullRequestPreviewChild<Failure>>({
  child, grouped, headSha, closed, open, text, describeFailure, renderFailureDetails, renderPublication,
}: ChildPresentation<Failure, Child>): React.ReactElement | null {
  const url = child.kind === 'preview' && child.state === 'ready' ? child.targetUrl : null;
  const cleanup = needsCleanup(child, closed);
  const reason = previewReason(text, child, headSha, closed, describeFailure);
  const next = previewNextStep(child, cleanup, open, text);
  const publication = renderPublication?.(child);
  const controllerUnavailable = child.controller && child.controller.state !== 'available';
  if (!grouped && url === null && reason === null && next === null && !controllerUnavailable && !publication
    && (child.kind !== 'unavailable' || !renderFailureDetails)) return null;

  const address = url === null ? null : <PreviewAddressRow url={url} next={cleanup ? null : next} text={text} />;
  const details = child.kind === 'unavailable' ? renderFailureDetails?.(child.failure) : null;
  return (
    <Stack gap="small">
      {grouped
        ? address && !cleanup ? address : <Item title={url ?? previewSentence(text, child)}
            {...(reason === null ? {} : { subtitle: reason })} accessoryWraps accessory={next} />
        : <>
            {address ? <ItemGroup>{address}</ItemGroup> : null}
            {reason === null ? null : <Text variant="body" tone="secondary" value={reason} />}
            {(!address || cleanup) && next ? <Row gap="small">{next}</Row> : null}
          </>}
      {details}
      {grouped ? publication : null}
      <PreviewController child={child} open={open} text={text} />
      {grouped ? null : publication}
    </Stack>
  );
}

/** The Environment owner supplies reachability independently of the app's serving receipt. */
function PreviewController({ child, open, text }: Readonly<{ child: PullRequestPreviewChild; open: OpenDeployment | null; text: PluginTranslate }>): React.ReactElement | null {
  if (!child.controller || child.controller.state === 'available') return null;
  return <Item title={child.controller.state === 'paused'
    ? text('preview.controllerPaused', 'Controller paused')
    : text('preview.controllerUnknown', 'Controller availability unknown')}
    subtitle={text('preview.controllerRecovery', 'Bring the controller online or choose another Machine.')}
    accessoryWraps accessory={open === null ? undefined : <Button size="small" variant="plain"
      title={text('preview.chooseController', 'Choose another controller')}
      onPress={() => open({ environmentId: child.environmentId, tab: 'settings' })} />} />;
}

/** A closed running preview goes to its cleanup controls. An exact receipt opens the native receipt viewer. */
function previewNextStep(
  child: PullRequestPreviewChild, cleanup: boolean, open: OpenDeployment | null, text: PluginTranslate,
): React.ReactElement | null {
  if (!open || child.kind === 'unavailable') return null;
  const { environmentId, deploymentId: receiptId } = child;
  const phase = childPhase(child);
  const receipt = { environmentId, receiptId };
  const button = (title: string, request: Omit<OpenDeploymentRequest, 'serverId'>, variant: 'primary' | 'secondary' | 'plain') => (
    <Button variant={variant} size="small" title={title} onPress={() => open(request)} />
  );
  if (phase === 'cleanupStopped') return button(text('preview.retryCleanup', 'Retry cleanup'), { environmentId }, 'primary');
  if (cleanup) return button(text('preview.cleanUp', 'Clean up'), { environmentId }, 'secondary');
  switch (phase) {
    case 'needsApproval':
      return button(text('preview.review', 'Review'), receipt, 'secondary');
    case 'ready':
    case 'failed':
      return button(text('preview.openReceipt', 'Open receipt'), receipt, phase === 'ready' ? 'plain' : 'secondary');
    case 'removed':
      return button(text('preview.history', 'History'), { environmentId, tab: 'history' }, 'plain');
    default:
      return null;
  }
}

/** A ready preview's address: the URL comes only from the read owner's ready fact. */
function PreviewAddressRow({
  url, next, text,
}: Readonly<{ url: string; next: React.ReactNode; text: PluginTranslate }>): React.ReactElement {
  return (
    <Item
      title={url}
      icon={<Icon name="globe" size="small" tone="secondary" />}
      accessoryWraps
      accessory={
        <Row gap="small">
          {next}
          <Action.Copy
            value={url}
            title={text('preview.copy', 'Copy URL')}
          />
          <Action.OpenExternal
            url={url}
            title={text('preview.open', 'Open')}
          />
        </Row>
      }
    />
  );
}
