import type { ReactElement, ReactNode } from 'react';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import { Text } from './Text.js';

/**
 * A secret value in a row subtitle: a one-line masked shape while hidden, the whole value while revealed.
 * The value is the author's own; no Happier-held secret crosses this seam.
 */
export type SecretValueTextProps = Readonly<{
  testID?: string;
  /** The revealed value; `null` draws the mask. */
  revealed: string | null;
  mask: string;
  /** What the masked shape stands for, for assistive readers. */
  maskedAccessibilityLabel?: string;
  /** The revealed value may be selected (an unrecorded secret the person already holds). */
  selectable?: boolean;
  /** Readable alternative on a host without the secret value presentation. */
  unavailableLabel?: string;
}>;

/**
 * The end-slot controls every secret value shares: an eye that reveals or hides, then Copy that turns into
 * the copied confirmation. Copy is drawn only where the author offers it; extra controls follow it.
 */
export type SecretValueControlsProps = Readonly<{
  testIDPrefix: string;
  revealed: boolean;
  revealLabel: string;
  hideLabel: string;
  onToggleReveal: () => void;
  /** Absent: no Copy is drawn. */
  onCopy?: () => void;
  copied?: boolean;
  copyAccessibilityLabel?: string;
  disabled?: boolean;
  children?: ReactNode;
  /** Readable alternative on a host without the secret value presentation. */
  unavailableLabel?: string;
}>;

/** The incumbent secret value text, shared with Happier core; the host draws it. */
export function SecretValueText(props: SecretValueTextProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderSecretValueText) {
    return (
      <Text
        testID={
          props.testID === undefined ? undefined : `${props.testID}-unavailable`
        }
        tone="secondary"
        valueKey="happier.plugin-ui.secretValue.unavailable"
        fallback={
          props.unavailableLabel ?? 'This value is unavailable on this host.'
        }
      />
    );
  }
  return <>{host.renderSecretValueText(props)}</>;
}

/** The incumbent reveal/hide and Copy controls, shared with Happier core; the author owns what each press does. */
export function SecretValueControls(
  props: SecretValueControlsProps,
): ReactElement | null {
  const host = useOptionalPluginUiPresentationHost();
  if (!host?.renderSecretValueControls) {
    // The text beside it already says the value is unavailable; controls that cannot act draw nothing.
    return props.unavailableLabel === undefined ? null : (
      <Text
        testID={`${props.testIDPrefix}-unavailable`}
        tone="secondary"
        valueKey="happier.plugin-ui.secretValue.unavailable"
        fallback={props.unavailableLabel}
      />
    );
  }
  return <>{host.renderSecretValueControls(props)}</>;
}
