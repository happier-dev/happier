import type { PropertyListItem, usePluginTranslation } from '@happier-dev/plugin-ui';
import type { TriageTaskCapabilitiesV1 } from '@happier-dev/triage-protocol/v1';

/** The place's own creation catalog, projected into the draft's existing property list. */
export function projectTriageTaskDraftStatusV1(input: Readonly<{
  statuses: TriageTaskCapabilitiesV1['initialStatuses'];
  value: unknown;
  onChange(id: string | null): void;
  text: ReturnType<typeof usePluginTranslation>;
}>): Readonly<{ initialStatusId: string | undefined; property: PropertyListItem | null }> {
  const statuses = input.statuses ?? [];
  const selected = statuses.find(status => status.id === input.value);
  // Untouched, the draft still omits initialStatusId (the place decides), but it names the state the place marks as
  // its own default instead of a bare "Default". Without a marker the place's choice stays unknown.
  const shown = selected ?? statuses.find(status => status.isDefault === true);
  return {
    initialStatusId: selected?.id,
    property: statuses.length === 0 ? null : {
      id: 'initialStatusId', label: input.text('plugins.triage.tasks.column.status', 'Status'),
      value: shown?.label ?? input.text('plugins.triage.tasks.initialStatus.default', 'Default'),
      editor: { kind: 'choice', value: shown?.id ?? null,
        choices: statuses.map(status => ({ id: status.id, label: status.label })),
        onCommit: input.onChange },
    },
  };
}
