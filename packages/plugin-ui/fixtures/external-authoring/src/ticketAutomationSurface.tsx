import { useMemo, useState } from 'react';
import type { AutomationSubjectV1, PluginSubjectKindListInputV1 } from '@happier-dev/plugin-sdk/automations';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { defineUiSurface, usePluginHostApi } from '@happier-dev/plugin-ui';
import { AutomationsSection, AutomationSubjectPicker, Button } from '@happier-dev/plugin-ui/components';

import { EXTERNAL_TICKET_KIND_ID } from './ticketAutomationPlugin.js';

/** External resource-page consumer: the picker returns the identity the section passes to core. */
export function TicketAutomationExample(props: Readonly<{ pluginId: string; page?: Omit<PluginSubjectKindListInputV1, 'cursor'> }>) {
  const host = usePluginHostApi();
  const [subject, setSubject] = useState<AutomationSubjectV1 | null>(null);
  const kind = useMemo(() => ({
    kind: 'plugin' as const,
    pluginId: props.pluginId,
    subjectKindId: EXTERNAL_TICKET_KIND_ID,
  }), [props.pluginId]);

  return <>
    <AutomationSubjectPicker testID="external-ticket-picker" kind={kind} page={props.page}
      value={subject} onChange={setSubject} />
    <AutomationSubjectPicker testID="external-ticket-picker-disabled" kind={kind} page={props.page}
      value={subject} onChange={setSubject} disabled />
    {subject ? <AutomationsSection testID="external-ticket-automations" subject={subject} /> : null}
    <Button testID="external-ticket-close" title="Close ticket" disabled={subject?.kind !== 'plugin'}
      onPress={async () => {
        if (subject?.kind !== 'plugin') return;
        await host.executeAction({ pluginId: subject.pluginId, localId: 'close-ticket' }, { ticket: subject.identity });
      }} />
  </>;
}

function TicketAutomationSurface(context: RenderContext) {
  return <TicketAutomationExample pluginId={context.plugin.id} page={{ limit: 20 }} />;
}

export const renderSurface = defineUiSurface(TicketAutomationSurface);
