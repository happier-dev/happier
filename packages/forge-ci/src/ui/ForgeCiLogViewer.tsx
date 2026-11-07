import type { ReactNode } from 'react';
import { useForgeCiLogViewerV1, type ForgeCiLogViewerInputV1, type ForgeCiLogViewerModelV1 } from './useForgeCiLogViewer.js';

export type ForgeCiLogViewerProps = ForgeCiLogViewerInputV1 & Readonly<{ children(model: ForgeCiLogViewerModelV1): ReactNode }>;

/** The UI lane renders the existing virtual List/Find controls from this one admitted index. */
export function ForgeCiLogViewer(props: ForgeCiLogViewerProps): ReactNode {
  return props.children(useForgeCiLogViewerV1(props));
}
