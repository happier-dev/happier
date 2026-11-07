import type { ReactElement, ReactNode } from 'react';
import type { PluginActionInputById } from '@happier-dev/plugin-sdk/actions';

import { useHappierUiAnimationActivityInternal } from '../environment/context.js';
import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';

/** The saved cosmetic value from the public template contract, not a second face schema. */
export type BotFaceValue = NonNullable<PluginActionInputById['template.draft']['content']['identity']['face']>;

export type BotFaceProps = Readonly<{
  seed: string;
  face?: BotFaceValue | null;
  size: number;
  visible?: boolean;
  motion?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  /** Shown by hosts without the app's face renderer (for example an isolated web frame). */
  fallback?: ReactNode;
}>;

/** Draw a Bot's saved face through Happier's identity, Account-default and motion owners. */
export function BotFace({ fallback, visible = true, ...input }: BotFaceProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const active = useHappierUiAnimationActivityInternal();
  return <>{host?.renderBotFace?.({ ...input, visible: active && visible }) ?? fallback}</>;
}
