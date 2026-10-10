import * as React from 'react';

/**
 * True inside a Workflows column that carries the destination's own "+" (a phone, where navigation
 * shows the title and would otherwise fold the home's header actions into a second `⋯` of raw
 * buttons, DESIGN-9 N6). The column decides; the home reads it and leaves its header actions out, so
 * there is one way to add and one overflow.
 */
export const WorkflowsColumnOwnsCreationContext = React.createContext(false);

export function useWorkflowsColumnOwnsCreation(): boolean {
    return React.useContext(WorkflowsColumnOwnsCreationContext);
}
