import type { ReactElement } from 'react';
import { RowStatusLine, type RowStatusLineProps } from '@happier-dev/plugin-ui/components';

/** The author supplies translated copy and the existing operation's held state. */
export function RowStatusLineExample(props: Readonly<{
  text: string;
  actionLabel: string;
  signingIn: boolean;
  startSignIn(): Promise<void>;
}>): ReactElement {
  const status = {
    text: props.text,
    tone: 'warn',
    busy: props.signingIn,
    action: { label: props.actionLabel, onPress: props.startSignIn },
  } satisfies RowStatusLineProps;
  return <RowStatusLine {...status} />;
}
