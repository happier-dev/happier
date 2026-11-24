import { createContext } from 'react';

/**
 * A bounded approval prompt's report line for its deciding fact: the shared fields table reports where its first
 * row ends, measured from the top of the prompt's facts, so the prompt's minimum keeps that row in view
 * (UI refinements ruling 2026-11-24). Null outside a bounded prompt.
 */
export const HappierApprovalFirstFactContext = createContext<((bottomPx: number) => void) | null>(null);
