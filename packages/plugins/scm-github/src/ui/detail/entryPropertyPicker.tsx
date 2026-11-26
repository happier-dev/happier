import * as React from 'react';
import { HAPPIER_PAGE_METRICS, PropertyList, Stack, Text, usePluginTranslation, type PropertyChoice } from '@happier-dev/plugin-ui';
import type { GithubOverviewValueV1 } from './overviewReader.js';
import { GithubReadFailure } from './readFailure.js';

/** GitHub's people and labels use the shared property editor; each checkbox names one native delta. */
export function GithubEntryPropertyPicker(props: Readonly<{
  property: 'assignees' | 'labels';
  overview: GithubOverviewValueV1;
  pending: boolean;
  disabledReason: string | null;
  feedback: React.ReactNode;
  onChange(member: string, mode: 'add' | 'remove'): Promise<void>;
  refresh: () => unknown;
}>): React.ReactElement | null {
  const text = usePluginTranslation();
  const { property, overview } = props;
  const current = overview[property];
  const directory = overview.propertyChoices?.[property];
  const choices = React.useMemo<readonly PropertyChoice[] | undefined>(() => {
    if (directory?.kind !== 'available') return undefined;
    const names = directory.choices.map(choice => typeof choice === 'string' ? choice : choice.login);
    // A person no longer assignable to this repository can still be removed from this entry.
    return [...names, ...(current?.filter(member => !names.includes(member)) ?? [])]
      .map(member => ({ id: member, label: member,
        ...(property === 'assignees' ? { person: member, subtitle: text('plugins.github.ui.parity.user', 'GitHub user') } : {}) }));
  }, [current, directory, property, text]);
  if (current === undefined) return null;
  const label = property === 'assignees'
    ? text('plugins.github.ui.parity.assignees', 'Assignees')
    : text('plugins.github.ui.parity.labels', 'Labels');
  // It sits among the Details sheet's rows, so it stands on their inset rather than the sheet's edge (N30).
  return <Stack gap="small" style={SHEET_ROW_INSET_STYLE_V1}>
    <PropertyList testID={`github-pr-${property}`} items={[{
      id: property,
      label,
      value: current.length === 0 ? null : current.join(', '),
      busy: props.pending,
      clearable: false,
      ...(choices === undefined || props.disabledReason !== null ? {} : { editor: {
        kind: 'choices' as const,
        searchable: true,
        ...(property === 'labels' ? { chips: true } : {}),
        value: current,
        choices,
        onCommit: async (next: readonly string[]) => {
          const added = next.find(member => !current.includes(member));
          const removed = current.find(member => !next.includes(member));
          if (added !== undefined) await props.onChange(added, 'add');
          else if (removed !== undefined) await props.onChange(removed, 'remove');
        },
      } }),
    }]} />
    {props.disabledReason === null ? null : <Text variant="micro" tone="secondary" value={props.disabledReason} />}
    {directory?.kind === 'unavailable' ? <GithubReadFailure
      title={text('plugins.github.ui.readFailed', 'GitHub could not complete this read.')}
      failures={[directory.failure]} refresh={props.refresh} /> : null}
    {props.feedback}
  </Stack>;
}

const SHEET_ROW_INSET_STYLE_V1 = Object.freeze({
  paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
  paddingVertical: HAPPIER_PAGE_METRICS.rowPaddingVerticalPx,
});
