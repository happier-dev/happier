import type { ReactElement } from 'react';
import type { AutomationSubjectV1, AutomationSubjectKind, PluginSubjectKindListInputV1 } from '@happier-dev/plugin-sdk/automations';
import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Text } from './Text.js';

export type { AutomationSubjectKind } from '@happier-dev/plugin-sdk/automations';

export type AutomationsSectionProps = Readonly<{
  subject: AutomationSubjectV1;
  subjectName?: string;
  testID?: string;
}>;

/** Page demand belongs to the caller or to the selected list owner's existing default. */
export type AutomationSubjectPickerDemand =
  | Readonly<{ kind: Extract<AutomationSubjectKind, { kind: 'plugin' }>;
      page?: Omit<PluginSubjectKindListInputV1, 'cursor'> }>
  | Readonly<{ kind: Extract<AutomationSubjectKind, { kind: 'healthCheck' }>;
      page?: Omit<PluginActionInputById['workflow.subjects.list'], 'kind' | 'cursor'> }>
  | Readonly<{ kind: Extract<AutomationSubjectKind, { kind: 'app' }>;
      page?: Pick<PluginSubjectKindListInputV1, 'query' | 'limit'> }>
  | Readonly<{ kind: Exclude<AutomationSubjectKind, { kind: 'plugin' | 'healthCheck' | 'app' }> }>;

export type AutomationSubjectPickerProps = AutomationSubjectPickerDemand & Readonly<{
  /** The complete identity, including its Home and plugin qualification, never a local id alone. */
  value: AutomationSubjectV1 | null;
  onChange(subject: AutomationSubjectV1): void;
  disabled?: boolean;
  testID?: string;
}>;

/** The resource's core Automations controller owns reads, authoring and mutations on both surfaces. */
export function AutomationsSection(props: AutomationsSectionProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderAutomationsSection) {
    return <Text testID={props.testID === undefined ? undefined : `${props.testID}-unavailable`}
      tone="secondary" valueKey="happier.plugin-ui.automations.unavailable"
      fallback="Automations are unavailable on this host." />;
  }
  return <>{host.renderAutomationsSection(props)}</>;
}

/** The host opens its existing subject picker; closed pickers add no separate loader or matcher. */
export function AutomationSubjectPicker(props: AutomationSubjectPickerProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderAutomationSubjectPicker) {
    return <Text testID={props.testID === undefined ? undefined : `${props.testID}-unavailable`}
      tone="secondary" valueKey="happier.plugin-ui.automations.subjectPickerUnavailable"
      fallback="Automation subject selection is unavailable on this host." />;
  }
  return <>{host.renderAutomationSubjectPicker(props)}</>;
}
