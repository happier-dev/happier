import type { AutomationSubjectV1 } from '@happier-dev/plugin-sdk/automations';
import { AutomationsSection } from '@happier-dev/plugin-ui/components';

/** A plugin resource page reuses the host's selected-resource controller. */
export function TicketAutomations(props: {
  subject: Extract<AutomationSubjectV1, { kind: 'plugin' }>;
  title: string;
}) {
  return <AutomationsSection subject={props.subject} subjectName={props.title} />;
}
