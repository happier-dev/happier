import type { ReactElement, ReactNode } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Text } from './Text.js';

/** Display facts already admitted by the caller, not a Session identity or launch recipe. */
export type ExecutableParticipantPickerOption = Readonly<{
  id: string;
  label: string;
  /** Canonical model/Agent names used only for matching by the host's shared query owner. */
  searchText?: string;
  subtitle?: string;
  icon?: ReactNode | (() => ReactNode);
  rightAccessory?: ReactNode | (() => ReactNode);
  accessibilityLabel?: string;
  disabled?: boolean;
  testID?: string;
  /** Explicit row intent; the caller may demand current detail for this option. */
  onHighlight?: () => void;
  onPressIn?: () => void;
}>;

export type ExecutableParticipantPickerSection = Readonly<{
  id: string;
  title?: string;
  rightAccessory?: ReactNode | (() => ReactNode);
  options: readonly ExecutableParticipantPickerOption[];
}>;

export type ExecutableParticipantPickerSelection =
  | Readonly<{ kind: 'single'; selectedId: string | null }>
  | Readonly<{ kind: 'multiple'; selectedIds: ReadonlySet<string> }>;

export type ExecutableParticipantPickerProps = Readonly<{
  sections: readonly ExecutableParticipantPickerSection[];
  selection: ExecutableParticipantPickerSelection;
  searchPlaceholder: string;
  doneLabel: string;
  /** A configured choice need not have a marked row; confirmation belongs to the caller. */
  canConfirm: boolean;
  onSelect(id: string): void;
  onDone(): void;
  onRequestClose(): void;
  testID?: string;
  /** Readable alternative on a host without the picker presentation capability. */
  unavailableLabel?: string;
}>;

/**
 * The incumbent searchable participant choice presentation, shared with Happier core.
 * The host supplies its one SelectionList renderer; inventory, readiness, selection,
 * native setup and committing a choice remain with the caller. Supported in same-realm
 * native and React Native Web surfaces; other hosts show the explicit unavailable state.
 */
export function ExecutableParticipantPicker(props: ExecutableParticipantPickerProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderExecutableParticipantPicker) {
    return <Text testID={props.testID === undefined ? undefined : `${props.testID}-unavailable`}
      tone="secondary" valueKey="happier.plugin-ui.executableParticipantPicker.unavailable"
      fallback={props.unavailableLabel ?? 'Participant selection is unavailable on this host.'} />;
  }
  return <>{host.renderExecutableParticipantPicker(props)}</>;
}
