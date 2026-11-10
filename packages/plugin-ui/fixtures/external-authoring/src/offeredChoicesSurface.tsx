import { OfferedChoices, type OfferedChoice } from '@happier-dev/plugin-ui/components';

const choices: readonly OfferedChoice[] = [
  { id: 'session', label: 'Allow this session', refusal: false, available: true, description: 'Until this session ends' },
  { id: 'once', label: 'Allow once', refusal: false, available: true },
  { id: 'owner', label: 'Save a rule', refusal: false, available: false, description: 'Ask the owner' },
  { id: 'reject', label: 'Request changes', refusal: true, available: true, allowsFeedback: true },
];

/** The author supplies decision and scope facts; the shared presenter owns the row/list and feedback. */
export function OfferedChoicesSurface(props: Readonly<{ onChoose: (id: string, feedback?: string) => void }>) {
  return <OfferedChoices choices={choices} primaryId="once" disabled={false} busyChoiceId={null}
    unavailableReason="Ask the owner" feedbackPlaceholder="What should change?" cancelLabel="Cancel" testID="offered"
    onChoose={props.onChoose} />;
}
