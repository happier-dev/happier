import { createContext } from 'react';

/**
 * The text edge a button with no resting fill (`plain`) stands on: `start` when it sits on its own line under a
 * section's text, `end` when it ends a row (Select at the end of a phone's search row). Such a button puts its
 * label on that edge instead of insetting it by its own padding; its box, hit area and press feedback keep their
 * size and reach into the gutter by the padding it gave up. `null` everywhere else.
 */
export const HappierTextActionEdgeContext = createContext<'start' | 'end' | null>(null);
