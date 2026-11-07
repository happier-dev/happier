import * as React from 'react';
import type { ReactElement } from 'react';
import {
  Select,
  Stack,
  Text,
  usePluginTranslation,
} from '@happier-dev/plugin-ui';

import type { TriageSessionPullRequestBindingV1 } from '../sessionPullRequestStatus.js';

/** The first linked PR that needs the person (its watch stopped on credentials or the fix limit), else the first. */
export function pickInitialLinkedPullRequest(
  bindings: readonly TriageSessionPullRequestBindingV1[],
): string | null {
  const needs = bindings.find(
    (binding) =>
      binding.watch.reason === 'exhausted' ||
      binding.watch.reason === 'credentials',
  );
  return (needs ?? bindings[0])?.bindingId ?? null;
}

/**
 * Which of a Session's linked PRs is shown: the person's choice while it is still linked, else the one that needs
 * them. Every surface that shows one PR of several (the Companion glance, the Git pane card) chooses through this.
 */
export function useLinkedPullRequestSelection(
  bindings: readonly TriageSessionPullRequestBindingV1[] | null,
  initialBindingId?: string,
): Readonly<{ selectedId: string | null; choose(bindingId: string): void }> {
  const [chosen, setChosen] = React.useState<string | null>(
    initialBindingId ?? null,
  );
  const selectedId = bindings?.some((binding) => binding.bindingId === chosen)
    ? chosen
    : bindings
      ? pickInitialLinkedPullRequest(bindings)
      : null;
  return { selectedId, choose: setChosen };
}

/** The shared selector above a single PR's controls, so a mode change or a merge applies to the PR shown. */
export function LinkedPullRequestSelector(
  props: Readonly<{
    bindings: readonly TriageSessionPullRequestBindingV1[];
    selectedId: string;
    onChange(bindingId: string): void;
    testID?: string;
  }>,
): ReactElement | null {
  const text = usePluginTranslation();
  if (props.bindings.length < 2) return null;
  return (
    <Stack gap="xsmall">
      <Text
        variant="meta"
        tone="secondary"
        value={text(
          'plugins.triage.prGlance.linkedCount',
          '{count} pull requests linked to this session',
          {
            count: props.bindings.length,
          },
        )}
      />
      <Select
        label={text('plugins.triage.prGlance.selectLabel', 'Pull request')}
        presentation={props.bindings.length <= 4 ? 'segmented' : 'field'}
        options={props.bindings.map((binding) => ({
          value: binding.bindingId,
          label: `#${binding.link.number}`,
        }))}
        value={props.selectedId}
        onChange={(value) => {
          if (typeof value === 'string') props.onChange(value);
        }}
        testID={props.testID}
      />
    </Stack>
  );
}
