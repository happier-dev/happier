import * as React from 'react';
import { Badge, Item, Menu, Row, Stack, Text, usePluginTranslation, type MenuItem } from '@happier-dev/plugin-ui';
import type { GithubOverviewValueV1 } from './overviewReader.js';
import { GithubReadFailure } from './readFailure.js';

/**
 * GitHub's people and labels as Details rows: the property's name over its value, as every sibling row reads (N30),
 * with the value as the row's select. The shared menu offers one checkbox per person or label, and each pick sends
 * one native delta.
 */
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
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const { property, overview } = props;
  const current = overview[property];
  const directory = overview.propertyChoices?.[property];
  const choices = React.useMemo<readonly MenuItem[] | undefined>(() => {
    if (directory?.kind !== 'available' || current === undefined) return undefined;
    const names = directory.choices.map(choice => typeof choice === 'string' ? choice : choice.login);
    // A person no longer assignable to this repository can still be removed from this entry.
    return [...names, ...current.filter(member => !names.includes(member))].map((member): MenuItem => ({
      id: member,
      label: member,
      kind: 'checkbox',
      checked: current.includes(member),
      ...(property === 'assignees' ? { person: member, subtitle: text('plugins.github.ui.parity.user', 'GitHub user') } : {}),
    }));
  }, [current, directory, property, text]);
  if (current === undefined) return null;
  const label = property === 'assignees'
    ? text('plugins.github.ui.parity.assignees', 'Assignees')
    : text('plugins.github.ui.parity.labels', 'Labels');
  const value = current.length === 0 ? text('plugins.github.ui.parity.none', 'None') : current.join(', ');
  const select = choices === undefined || props.disabledReason !== null ? null : (
    <Menu
      open={open && !props.pending}
      onOpenChange={(next) => {
        setQuery('');
        setOpen(next && !props.pending);
      }}
      disabled={props.pending}
      trigger={value}
      // The value line in the siblings' value face, with a caret saying it opens its choices.
      triggerTextVariant="body"
      triggerTextTone="secondary"
      triggerDisclosure
      {...(property === 'labels' && current.length > 0
        ? { triggerContent: <Row gap="xsmall" wrap>{current.map(name => <Badge key={name} value={name} />)}</Row> }
        : {})}
      triggerAccessibilityLabel={`${label}, ${value}`}
      sheet={{ title: label }}
      items={choices}
      search={{ value: query, onValueChange: setQuery }}
      testID={`github-pr-${property}.value`}
      onSelect={(member) => {
        if (props.pending) return;
        void props.onChange(member, current.includes(member) ? 'remove' : 'add');
      }}
    />
  );
  const notices = [
    props.disabledReason === null ? null : <Text key="reason" variant="micro" tone="secondary" value={props.disabledReason} />,
    directory?.kind === 'unavailable' ? <GithubReadFailure key="failure"
      title={text('plugins.github.ui.readFailed', 'GitHub could not complete this read.')}
      failures={[directory.failure]} refresh={props.refresh} /> : null,
    props.feedback === null || props.feedback === undefined ? null : <React.Fragment key="feedback">{props.feedback}</React.Fragment>,
  ].filter(notice => notice !== null);
  return <Item title={label} testID={`github-pr-${property}`} {...(select === null ? { subtitle: value } : {})}>
    {select === null && notices.length === 0 ? null : <Stack gap="small">{select}{notices}</Stack>}
  </Item>;
}
