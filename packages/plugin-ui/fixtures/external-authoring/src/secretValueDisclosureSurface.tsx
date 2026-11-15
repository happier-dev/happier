import * as React from 'react';
import { SecretValueControls, SecretValueText } from '@happier-dev/plugin-ui/components';

/** The author shows its own value through the host's one presenter; it owns what reveal and Copy do. */
export function SecretValueDisclosureExample() {
  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  return <>
    <SecretValueText testID="author-secret-value" revealed={revealed ? 'whsec_example_signing_value' : null}
      mask="whsec_••••••••" maskedAccessibilityLabel="Signing secret, hidden" />
    <SecretValueControls testIDPrefix="author-secret" revealed={revealed}
      revealLabel="Show signing secret" hideLabel="Hide signing secret"
      onToggleReveal={() => setRevealed(current => !current)}
      onCopy={() => setCopied(true)} copied={copied} />
  </>;
}
