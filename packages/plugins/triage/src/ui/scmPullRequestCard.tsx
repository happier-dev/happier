import * as React from 'react';
import { isPluginError, readPluginErrorRequestIdV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';
import type { RenderSurface } from '@happier-dev/plugin-sdk/ui';
import type {
  SessionPullRequestBindingResultV1,
  SessionPullRequestWatchPolicyV1,
} from '@happier-dev/channels-protocol/v1';
import {
  Badge,
  Button,
  Icon,
  Row,
  Stack,
  Text,
  WidgetFrame,
  defineUiSurface,
  usePluginHostApi,
  usePluginTranslation,
  useSessionState,
  useSurfaceContext,
} from '@happier-dev/plugin-ui';

import { useTriageScmPullRequestCardV1, type TriageScmPullRequestCardControllerV1 } from '../sessions/scmPullRequestCard.js';
import { acceptTriagePullRequestWatchOfferV1, projectTriagePullRequestWatchOfferV1,
  type TriagePullRequestWatchDefaultsResultV1 } from '../sessions/sessionPullRequestControls.js';
import { useTriageSessionPullRequestWatchDefaultsV1 } from '../sessions/useSessionPullRequestControls.js';
import type { TriageSessionPullRequestBindingV1, TriageSessionPullRequestCardV1 } from '../sessions/sessionPullRequestStatus.js';
import { PullRequestGlance } from '../sessions/pullRequestGlance/PullRequestGlance.js';
import { PullRequestFailureDetails, PullRequestReadFailure } from '../sessions/pullRequestGlance/PullRequestReadFailure.js';
import { LinkedPullRequestSelector, useLinkedPullRequestSelection } from '../sessions/pullRequestGlance/LinkedPullRequestSelector.js';
import { PullRequestWatchOffer } from '../sessions/pullRequestGlance/PullRequestWatchOffer.js';
import { usePullRequestWatchConfigureV1 } from '../sessions/pullRequestGlance/useWatchConfigure.js';
import { PendingApprovalLine } from '../sessions/pullRequestGlance/PendingApprovalLine.js';
import { usePullRequestGlanceNavigationV1 } from '../sessions/pullRequestGlance/useGlanceNavigation.js';
import { usePullRequestOperationsV1 } from '../sessions/pullRequestGlance/usePullRequestOperations.js';
import { TriageSourceWriteCluster } from './header/sourceWriteCluster.js';

function branchChecksText(text: ReturnType<typeof usePluginTranslation>, state: string): string {
  switch (state) {
    case 'success': return text('plugins.triage.prCard.branchChecks.success', 'Checks on this branch passed');
    case 'failure': return text('plugins.triage.prCard.branchChecks.failure', 'A check on this branch failed');
    case 'pending': return text('plugins.triage.prCard.branchChecks.pending', 'Checks on this branch are running');
    default: return text('plugins.triage.prCard.branchChecks.unknown', 'Checks on this branch: not read yet');
  }
}

type LinkEvent = Extract<
  SessionPullRequestBindingResultV1,
  { kind: 'attached' }
>;
type LinkState =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'linking' }>
  | Readonly<{ kind: 'approval' }>
  | Readonly<{ kind: 'failed'; codes: readonly string[]; requestId?: string }>;

/**
 * The Git pane's and Project source control's pull request card (c7). A PR linked to this Session shows the
 * shared status (the Companion glance's own family, same read); a PR found only on the checkout's branch is a
 * hint — labelled, never watched, never silently linked — with Link this PR through the existing attach.
 * A PR created here uses that same Link path automatically once the Session Resource settles.
 */
export function TriageScmPullRequestCard(
  props: Readonly<{ launchInput: JsonValue | undefined; signal: AbortSignal }>,
): React.ReactElement | null {
  const controller = useTriageScmPullRequestCardV1(props.launchInput);
  // The hint becomes a differently keyed bound card when the Resource refreshes.
  // Keep this mount's attach result above that transition, matched by binding id.
  const [linkEvent, setLinkEvent] = React.useState<LinkEvent>();
  const bindings = React.useMemo(() => controller.cards.flatMap(card => card.kind === 'bound' ? [card.binding] : []),
    [controller.cards]);
  const { selectedId, choose } = useLinkedPullRequestSelection(bindings);
  // Several linked PRs show one card at a time, chosen above it, so its controls apply to the PR shown.
  const cards = bindings.length > 1
    ? controller.cards.filter(card => card.kind !== 'bound' || card.binding.bindingId === selectedId)
    : controller.cards;
  const body = cards.map(card => <ScmPullRequestCardBody
    key={card.kind === 'bound' ? card.binding.bindingId : card.pullRequest.url}
    card={card} controller={controller} signal={props.signal}
    linkEvent={linkEvent} onAttached={setLinkEvent} onDismissOffer={() => setLinkEvent(undefined)} />);
  const failure = <PullRequestReadFailure snapshot={controller.resource} refresh={controller.refresh} testID="pr-card" />;
  if (bindings.length < 2 || selectedId === null) return <>{failure}{body}</>;
  return <Stack gap="small">
    {failure}
    <LinkedPullRequestSelector bindings={bindings} selectedId={selectedId} onChange={choose} testID="pr-card.select" />
    {body}
  </Stack>;
}

function ScmPullRequestCardBody(props: Readonly<{
  card: TriageSessionPullRequestCardV1;
  controller: TriageScmPullRequestCardControllerV1;
  signal: AbortSignal;
  linkEvent: LinkEvent | undefined;
  onAttached(event: LinkEvent): void;
  onDismissOffer(): void;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const { target } = useSurfaceContext();
  const sessionId = target.kind === 'session' ? target.sessionId : null;
  const { controller, card } = props;
  const session = useSessionState(sessionId);
  const agent = session.state?.agent?.displayName ?? null;
  const watch = usePullRequestWatchConfigureV1(sessionId, controller.refresh);
  const homeServerId = useSurfaceContext().accountScope?.serverId ?? null;
  const navigationSession = React.useMemo(() => homeServerId !== null && sessionId !== null ? { serverId: homeServerId, sessionId } : null, [homeServerId, sessionId]);
  const navigation = usePullRequestGlanceNavigationV1(navigationSession, props.signal);
  const [link, setLink] = React.useState<LinkState>({ kind: 'idle' });
  const linkAttempted = React.useRef(false);
  const { pullRequest } = card;
  const number = pullRequest.number ?? null;
  const provider = pullRequest.provider.displayName;
  const source =
    number === null
      ? provider
      : text('plugins.triage.prCard.source', '{provider} · #{number}', {
          provider,
          number,
        });

  const onLink = React.useCallback(async () => {
    linkAttempted.current = true;
    setLink({ kind: 'linking' });
    try {
      const result = await controller.link(props.signal);
      if (props.signal.aborted) return;
      if (result === null || result.kind === 'cancelled')
        setLink({ kind: 'idle' });
      else if (result.kind === 'attached') {
        props.onAttached(result);
        setLink({ kind: 'idle' });
      }
      else setLink({ kind: 'approval' });
    } catch (error) {
      if (!props.signal.aborted) {
        const failure = isPluginError(error) ? error : undefined;
        const requestId = readPluginErrorRequestIdV1(failure);
        setLink({ kind: 'failed', codes: failure
          ? [failure.code, ...(failure.diagnostics ?? []).map(diagnostic => diagnostic.code)] : [],
          ...(typeof requestId === 'string' ? { requestId } : {}) });
      }
    }
  }, [controller.link, props.onAttached, props.signal]);

  React.useEffect(() => {
    // One attempt per mounted hint; after success the Resource projects a bound card, including on remount.
    if (controller.linkCreatedHere && card.kind === 'branchHint' && !linkAttempted.current && !props.signal.aborted) {
      void onLink();
    }
  }, [card.kind, controller.linkCreatedHere, onLink, props.signal]);

  if (card.kind === 'branchHint') {
    const { pullRequest } = card;
    return (
      <WidgetFrame
        frameStyle="card"
        placement="companion"
        testID="pr-card.hint"
        mark={<Icon name="change-open" size="small" tone="secondary" />}
        title={text('plugins.triage.prCard.title', 'Pull request')}
        source={source}
        {...(controller.createdHere ? {} : {
          meta: <Badge variant="tinted" value={text('plugins.triage.prCard.branchHint', 'Branch hint')} />,
        })}
      >
        <Stack gap="small">
          <Text variant="label" value={pullRequest.title} numberOfLines={2} />
          {controller.createdHere && (link.kind === 'failed' || link.kind === 'approval') ? null : <Text
            variant="meta"
            tone="secondary"
            value={
              // A PR created from this pane is linked automatically: say so instead of calling it an unwatched hint.
              controller.createdHere
                ? text('plugins.triage.prCard.createdHere', 'Created from this session. Linking it here…')
                : sessionId === null
                ? text(
                    'plugins.triage.prCard.hintNoSession',
                    'Found on {branch}. Not linked to a session, so not watched.',
                    { branch: pullRequest.headBranch },
                  )
                : text(
                    'plugins.triage.prCard.hint',
                    'Found on {branch}. Not linked to this session, so not watched.',
                    { branch: pullRequest.headBranch },
                  )
            }
          />}
          {pullRequest.checks === undefined ? null : (
            <Text
              variant="meta"
              tone="secondary"
              value={branchChecksText(text, pullRequest.checks.state)}
            />
          )}
          {link.kind === 'approval' ? (
            <PendingApprovalLine />
          ) : null}
          {link.kind === 'failed' ? (
            <Stack gap="small">
              <Text
                variant="meta"
                tone="danger"
                value={text(
                  'plugins.triage.prCard.linkFailed',
                  'Couldn’t link this PR. The branch and the session are unchanged.',
                )}
              />
              <PullRequestFailureDetails codes={link.codes} requestId={link.requestId} />
            </Stack>
          ) : null}
          <Row gap="small" align="center">
            <Button
              variant="primary"
              size="small"
              busy={link.kind === 'linking'}
              title={
                sessionId === null
                  ? text(
                      'plugins.triage.prCard.linkToSession',
                      'Link to a session…',
                    )
                  : text('plugins.triage.prCard.link', 'Link this PR')
              }
              onPress={onLink}
              testID="pr-card.link"
            />
            <Button
              variant="plain"
              size="small"
              title={text(
                'plugins.triage.resource.open',
                'Open',
              )}
              onPress={() => {
                void host.openResource({ kind: 'pullRequest', url: pullRequest.url });
              }}
              testID="pr-card.open-provider"
            />
          </Row>
        </Stack>
      </WidgetFrame>
    );
  }
  const binding = card.binding;
  return (
    <WidgetFrame
      frameStyle="card"
      placement="companion"
      testID="pr-card.bound"
      mark={
        <Icon
          name={
            binding.link.state === 'merged' ? 'change-complete' : 'change-open'
          }
          size="small"
          tone="secondary"
        />
      }
      title={text('plugins.triage.prCard.title', 'Pull request')}
      source={source}
    >
      {watch.state.kind === 'approval' ? (
        <PendingApprovalLine />
      ) : null}
      {watch.state.kind === 'failed' ? (
        <Text variant="meta" tone="danger" value={text('plugins.triage.prGlance.configureFailed', 'That didn’t go through. The pull request and its watch are unchanged.')} />
      ) : null}
      <BoundBody
        signal={props.signal}
        binding={binding}
        title={pullRequest.title}
        agent={agent}
        sessionId={sessionId}
        linkEvent={
          props.linkEvent?.bindingId === binding.bindingId
            ? props.linkEvent
            : undefined
        }
        configuring={watch.state.kind === 'pending'}
        onConfigure={(policy) => {
          void watch.configure(binding, policy);
        }}
        onUnlink={() => {
          void watch.unlink(binding);
        }}
        onContinueFixing={() => watch.continueFixing(binding)}
        onOpenLatest={navigation.latestOpener(binding)}
        onRunLocally={() => navigation.runLocally(binding)}
        runLocallyUnavailable={navigation.localOpen === 'unavailable'}
        onDismissOffer={props.onDismissOffer}
        onOpenProvider={() => {
          void host.openResource({ kind: 'pullRequest', url: pullRequest.url });
        }}
        onReconnect={() => {
          void host.openConnectedAccounts();
        }}
      />
    </WidgetFrame>
  );
}

function BoundBody(
  props: Readonly<{
    binding: TriageSessionPullRequestBindingV1;
    signal: AbortSignal;
    title: string;
    agent: string | null;
    sessionId: string | null;
    linkEvent: LinkEvent | undefined;
    configuring: boolean;
    onConfigure(policy: SessionPullRequestWatchPolicyV1): void;
    onUnlink(): void;
    onContinueFixing(): unknown;
    onOpenLatest: (() => void) | null;
    onRunLocally(): unknown;
    runLocallyUnavailable: boolean;
    onDismissOffer(): void;
    onOpenProvider(): void;
    onReconnect(): void;
  }>,
): React.ReactElement {
  const serverId = useSurfaceContext().accountScope?.serverId ?? null;
  const session = React.useMemo(
    () => (serverId !== null && props.sessionId !== null ? { serverId, sessionId: props.sessionId } : null),
    [props.sessionId, serverId],
  );
  const { primaryWrite } = usePullRequestOperationsV1(props.sessionId, props.binding.bindingId, props.signal);
  return (
    <Stack gap="medium">
      {props.linkEvent !== undefined && session !== null ? (
        <OfferForLink
          signal={props.signal}
          session={session}
          binding={props.binding}
          agent={props.agent}
          onDismiss={props.onDismissOffer}
        />
      ) : null}
      <PullRequestGlance
        binding={props.binding}
        title={props.title}
        agent={props.agent}
        configuring={props.configuring}
        onConfigure={props.onConfigure}
        onUnlink={props.onUnlink}
        onContinueFixing={props.onContinueFixing}
        onOpenLatest={props.onOpenLatest}
        onRunLocally={props.onRunLocally}
        runLocallyUnavailable={props.runLocallyUnavailable}
        onOpenProvider={props.onOpenProvider}
        onReconnect={props.onReconnect}
      />
      {primaryWrite === null ? null : <TriageSourceWriteCluster write={primaryWrite} />}
      {primaryWrite?.feedback}
    </Stack>
  );
}

/** The c2 offer, only for the binding this card itself just linked (never for a refresh or another device's link). */
function OfferForLink(props: Readonly<{
  signal: AbortSignal;
  session: Readonly<{ serverId: string; sessionId: string }>;
  binding: TriageSessionPullRequestBindingV1;
  agent: string | null;
  onDismiss(): void;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const host = usePluginHostApi();
  const [state, setState] = React.useState<'idle' | 'busy' | 'approval' | 'failed'>('idle');
  // The Account's own default decides what is offered (Off offers nothing), read once for this link only.
  // Unreadable settings offer nothing rather than a guessed Notify; the glance's mode menu still sets the watch.
  const readDefaults = useTriageSessionPullRequestWatchDefaultsV1(true);
  const [defaults, setDefaults] = React.useState<TriagePullRequestWatchDefaultsResultV1 | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    const request = mergeAbortSignals([props.signal, controller.signal]);
    void readDefaults({ signal: request.signal }).then((result) => {
      if (!request.signal.aborted) setDefaults(result);
    }).catch(() => { if (!request.signal.aborted) setDefaults({ kind: 'unavailable' }); });
    return () => { controller.abort(); request.dispose(); };
  }, [props.signal, readDefaults]);
  if (state === 'approval') return <PendingApprovalLine />;
  // Keep loading, unavailable and explicit Off distinct at this presentation
  // boundary; none may be reinterpreted as a default or configure a binding.
  if (defaults === null || ('kind' in defaults && defaults.kind === 'unavailable')) return null;
  if (!('kind' in defaults) || defaults.kind !== 'ready') return <PendingApprovalLine />;
  const defaultPolicy = defaults.policy;
  const offer = projectTriagePullRequestWatchOfferV1(props.session, props.binding, defaultPolicy);
  if (offer === null) return null;
  return <Stack gap="xsmall">
    <PullRequestWatchOffer defaultPolicy={defaultPolicy} agent={props.agent} busy={state === 'busy'}
      onWatch={async (policy) => {
        const chosen = projectTriagePullRequestWatchOfferV1(props.session, props.binding, policy);
        if (chosen === null) return;
        setState('busy');
        try {
          const result = await acceptTriagePullRequestWatchOfferV1(host, chosen, { signal: props.signal });
          if (props.signal.aborted) return;
          if ('kind' in result && result.kind === 'updated') props.onDismiss();
          else setState('kind' in result && result.kind === 'unavailable' ? 'failed' : 'approval');
        } catch {
          if (!props.signal.aborted) setState('failed');
        }
      }}
      onDismiss={props.onDismiss} />
    {state === 'failed' ? <Text variant="meta" tone="danger" value={text('plugins.triage.prWatch.offer.failed', 'Watching didn’t start. The PR stays linked; try again from its mode.')} /> : null}
  </Stack>;
}

export const renderSurface: RenderSurface = defineUiSurface((context) => (
  <TriageScmPullRequestCard launchInput={context.launchInput} signal={context.signal} />
));
