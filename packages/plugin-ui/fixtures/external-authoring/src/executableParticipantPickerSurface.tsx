import * as React from 'react';
import {
  Button,
  ExecutableParticipantPicker,
  Text,
  type ExecutableParticipantPickerSection,
  type ExecutableParticipantPickerSelection,
} from '@happier-dev/plugin-ui/components';

/** The author supplies admitted display facts and owns selection, never host inventory or setup. */
export function ExecutableParticipantPickerExample(props: Readonly<{ multiple?: boolean; configuredChoice?: boolean }>) {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [reconnected, setReconnected] = React.useState(false);
  const [result, setResult] = React.useState('No choice committed');
  const sections: readonly ExecutableParticipantPickerSection[] = [{
    id: 'participants', title: 'Reviewers', options: [
      { id: 'review', label: 'Review agent', subtitle: 'Ready', testID: 'author-participant-review' },
      { id: 'design', label: 'Design agent', subtitle: reconnected ? 'Ready' : 'Machine offline', testID: 'author-participant-design' },
      { id: 'busy', label: 'Unavailable choice', subtitle: 'Selection pending', disabled: true, testID: 'author-participant-disabled' },
    ],
  }];
  const selection: ExecutableParticipantPickerSelection = props.multiple
    ? { kind: 'multiple', selectedIds: selected }
    : { kind: 'single', selectedId: selected.values().next().value ?? null };
  return <>
    <ExecutableParticipantPicker
      testID="author-participant-picker"
      sections={sections.map(section => ({ ...section, options: section.options.map(option => ({
        ...option, searchText: option.id === 'review' ? 'GPT review' : option.label,
      })) }))}
      searchPlaceholder="Search reviewers"
      selection={selection}
      doneLabel="Use reviewers"
      canConfirm={props.configuredChoice === true || selected.size > 0}
      onSelect={(id) => {
        setSelected(current => !props.multiple ? new Set([id])
          : current.has(id) ? new Set([...current].filter(value => value !== id)) : new Set([...current, id]));
        if (!props.multiple) setResult(`Chosen ${id}`);
      }}
      onDone={() => setResult(props.configuredChoice ? 'Committed configured choice' : `Committed ${[...selected].join(', ')}`)}
      onRequestClose={() => setResult('Canceled')}
    />
    <Button testID="author-participant-reconnect" title="Update readiness" onPress={() => setReconnected(true)} />
    <Text testID="author-participant-result" value={result} />
  </>;
}
