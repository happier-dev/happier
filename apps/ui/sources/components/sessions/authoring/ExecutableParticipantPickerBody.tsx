import * as React from 'react';
import { View } from 'react-native';
import type { ExecutableParticipantSelectionV1 } from '@happier-dev/protocol/discussions/executableParticipants';

import { executableParticipantOptionId } from '@/components/discussions/useExecutableParticipantSections';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import {
  ContextualStartComposerBody,
  useContextualStartComposer,
  useContextualStartParticipantSource,
  type ContextualStartAdmissibleSet,
} from './ContextualStartComposer';

export type ExecutableParticipantChoice = ExecutableParticipantSelectionV1 | readonly ExecutableParticipantSelectionV1[];
export type ExecutableParticipantPickerInput = Readonly<{
  accountLifetime: ServerAccountScopeLifetime;
  multiple: boolean;
  /** The invoking Run's machine, rather than its plugin projection relay. */
  machineId?: string | null;
  selected?: ExecutableParticipantChoice;
}>;

const WORKFLOW_PARTICIPANTS = {
  who: ['newAgent', 'session', 'bot'], machine: 'fixed', folder: 'fixed',
} as const satisfies ContextualStartAdmissibleSet;
const noChange = () => undefined;

function sameParticipant(left: ExecutableParticipantSelectionV1, right: ExecutableParticipantSelectionV1): boolean {
  const id = executableParticipantOptionId(left);
  return id === null ? left === right : id === executableParticipantOptionId(right);
}

/** Demand-mounted by Browse. Choosing authors a value; only the host's later Start admits work. */
export function ExecutableParticipantPickerBody(props: ExecutableParticipantPickerInput & Readonly<{
  onResolve: (choice: ExecutableParticipantChoice | null) => void;
  /** The host's inline level takes focus on its Back when the picker opens. */
  backRef?: React.ComponentProps<typeof TextLinkButton>['controlRef'];
}>) {
  const { multiple, onResolve, accountLifetime } = props;
  const [query, setQuery] = React.useState('');
  const [chosen, setChosen] = React.useState<readonly ExecutableParticipantSelectionV1[]>(() =>
    props.selected === undefined ? [] : Array.isArray(props.selected)
      ? props.selected : [props.selected as ExecutableParticipantSelectionV1]);
  const onChoose = React.useCallback((selection: ExecutableParticipantSelectionV1) => {
    if (!multiple) { onResolve(selection); return; }
    setChosen(current => current.some(entry => sameParticipant(entry, selection))
      ? current.filter(entry => !sameParticipant(entry, selection)) : [...current, selection]);
  }, [multiple, onResolve]);
  const onReplace = React.useCallback((previous: ExecutableParticipantSelectionV1, next: ExecutableParticipantSelectionV1) => {
    setChosen(current => current.map(entry => sameParticipant(entry, previous) ? next : entry));
  }, []);
  const source = useContextualStartParticipantSource({ accountLifetime, enabled: true, query, onQueryChange: setQuery,
    preferredMachineId: props.machineId, sessionsContext: t('workflows.start.participantSession'),
    selected: chosen, onChoose, onReplace, question: '', onQuestionChange: noChange,
    showWhere: false, onProject: noChange });
  const model = useContextualStartComposer({ ...source, question: undefined }, WORKFLOW_PARTICIPANTS);
  return <View testID="executable-participant-picker">
    <TextLinkButton testID="executable-participant-picker-back" label={t('common.back')} onPress={() => onResolve(null)} controlRef={props.backRef} />
    <FieldTextInput testID="executable-participant-picker-search" value={query} onChangeText={setQuery}
      placeholder={t('workflows.start.participantSearch')} accessibilityLabel={t('workflows.start.participantSearch')} />
    <ContextualStartComposerBody model={model} />
    {multiple ? <RoundButton testID="executable-participant-picker-done" size="small"
      title={t('workflows.start.participantDone')} disabled={chosen.length === 0}
      onPress={() => onResolve(chosen)} /> : null}
  </View>;
}
