import type { ReactElement, ReactNode } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Text } from './Text.js';

/** Presentation of an admitted runner; the inventory owner decides eligibility. */
export type ReviewRunnerPickerOption = Readonly<{
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  disabled?: boolean;
  testID?: string;
}>;

export type ReviewRunnerPickerProps = Readonly<{
  title: string;
  options: readonly ReviewRunnerPickerOption[];
  selectedId: string | null;
  onSelect(id: string): void;
  /** Selected runner's ordinary model/account controls. */
  children?: ReactNode;
  addMember?: Readonly<{ label: string; onPress(): void }>;
  testID?: string;
  unavailableLabel?: string;
}>;

/** The same runner rows as the native Review launcher, with caller-owned selection. */
export function ReviewRunnerPicker(props: ReviewRunnerPickerProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderReviewRunnerPicker) {
    return <Text testID={props.testID === undefined ? undefined : `${props.testID}-unavailable`}
      tone="secondary" valueKey="happier.plugin-ui.reviewRunnerPicker.unavailable"
      fallback={props.unavailableLabel ?? 'Runner selection is unavailable on this host.'} />;
  }
  return <>{host.renderReviewRunnerPicker(props)}</>;
}
