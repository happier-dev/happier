import type { ReactElement, ReactNode } from 'react';

import { createPrimitiveElement } from './primitiveElement.js';

export type PanelProps = Readonly<{
  titleKey: string;
  descriptionKey?: string;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
  size?: 'compact' | 'regular' | 'expanded';
  children?: ReactNode;
}>;

export function Panel({
  titleKey,
  descriptionKey,
  tone,
  size,
  children,
}: PanelProps): ReactElement {
  return createPrimitiveElement('Panel', 'happier-plugin-panel', {
    titleKey,
    descriptionKey,
    tone,
    size,
  }, children);
}
