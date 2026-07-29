import type { ReactElement, ReactNode } from 'react';

import type { PluginUiPortableAction } from '../actions.js';
import { createPrimitiveElement } from './primitiveElement.js';

export type { PluginUiPortableAction } from '../actions.js';

export type ActionProps = Readonly<{
  action: PluginUiPortableAction;
  labelKey?: string;
  disabled?: boolean;
  children?: ReactNode;
}>;

export function Action({
  action,
  labelKey,
  disabled,
  children,
}: ActionProps): ReactElement {
  return createPrimitiveElement('Action', 'happier-plugin-action', {
    action,
    labelKey,
    disabled,
  }, children);
}
