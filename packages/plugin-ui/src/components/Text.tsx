import type { ReactElement, ReactNode } from 'react';

import { createPrimitiveElement } from './primitiveElement.js';

export type TextProps = Readonly<{
  value?: string;
  valueKey?: string;
  tone?: 'neutral' | 'muted' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
  variant?: 'body' | 'label' | 'title' | 'caption' | 'code';
  children?: ReactNode;
}>;

export function Text({
  value,
  valueKey,
  tone,
  variant,
  children,
}: TextProps): ReactElement {
  return createPrimitiveElement('Text', 'happier-plugin-text', {
    value,
    valueKey,
    tone,
    variant,
  }, children ?? value);
}
