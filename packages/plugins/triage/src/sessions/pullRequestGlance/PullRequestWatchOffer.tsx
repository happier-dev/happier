import * as React from 'react';
import type { ReactElement } from 'react';
import {
  Button,
  Menu,
  Row,
  Stack,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';
import type {
  SessionPullRequestWatchModeV1,
  SessionPullRequestWatchPolicyV1,
} from '@happier-dev/channels-protocol/v1';

import {
  PULL_REQUEST_WATCH_MODES_V1,
  pullRequestWatchModeConsequenceV1,
  pullRequestWatchModeLabelV1,
} from './PullRequestGlance.js';

/**
 * "Watch this PR?" (c2): offered once, right after a PR is opened or linked from this session. The default mode
 * (the Account's, Notify unless changed) is one press; the caret picks another mode first; Not now only
 * dismisses. Nothing here changes a watch the person did not ask for.
 */
export function PullRequestWatchOffer(
  props: Readonly<{
    defaultPolicy: SessionPullRequestWatchPolicyV1;
    agent: string | null;
    busy?: boolean;
    onWatch(policy: SessionPullRequestWatchPolicyV1): unknown;
    onDismiss(): void;
    testID?: string;
  }>,
): ReactElement {
  const text = usePluginTranslation();
  const [open, setOpen] = React.useState(false);
  const agent =
    props.agent ?? text('plugins.triage.prWatch.theAgent', 'the agent');
  const defaultMode =
    props.defaultPolicy.mode === 'off' ? 'notify' : props.defaultPolicy.mode;
  const watchAs = (mode: SessionPullRequestWatchModeV1) =>
    props.onWatch({ ...props.defaultPolicy, mode });
  return (
    <Stack gap="small" testID={props.testID ?? 'pr-watch-offer'}>
      <Stack gap="xsmall">
        <Text
          variant="label"
          value={text('plugins.triage.prWatch.offer.title', 'Watch this PR?')}
        />
        <Text
          variant="body"
          tone="secondary"
          value={text(
            'plugins.triage.prWatch.offer.body',
            '{agent} can follow up on CI failures and review comments here, in this session.',
            { agent: agent[0]!.toLocaleUpperCase() + agent.slice(1) },
          )}
        />
      </Stack>
      <Row gap="small" align="center" wrap>
        <Button
          variant="primary"
          size="small"
          busy={props.busy === true}
          title={text(
            'plugins.triage.prWatch.offer.watchAs',
            'Watch · {mode}',
            { mode: pullRequestWatchModeLabelV1(text, defaultMode) },
          )}
          onPress={() => watchAs(defaultMode)}
          testID="pr-watch-offer.watch"
        />
        <Menu
          open={open}
          onOpenChange={setOpen}
          trigger={text('plugins.triage.prWatch.offer.otherMode', 'Other mode')}
          triggerAppearance="control"
          triggerAccessibilityLabel={text(
            'plugins.triage.prWatch.offer.otherModeLabel',
            'Watch with another mode',
          )}
          disabled={props.busy === true}
          items={PULL_REQUEST_WATCH_MODES_V1.filter(
            (mode) => mode !== 'off',
          ).map((mode) => ({
            id: mode,
            label: pullRequestWatchModeLabelV1(text, mode),
            subtitle: pullRequestWatchModeConsequenceV1(
              text,
              mode,
              props.agent,
            ),
          }))}
          onSelect={(id) => watchAs(id as SessionPullRequestWatchModeV1)}
          testID="pr-watch-offer.modes"
        />
        <Stack grow />
        <Button
          variant="plain"
          size="small"
          title={text('plugins.triage.prWatch.offer.notNow', 'Not now')}
          onPress={props.onDismiss}
          testID="pr-watch-offer.dismiss"
        />
      </Row>
    </Stack>
  );
}
