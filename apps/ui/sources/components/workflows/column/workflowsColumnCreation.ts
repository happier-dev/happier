import * as React from 'react';
import type { FocusReturnMutableRef } from '@/keyboard/focusReturn';

/** The page-form column and its library share the real creation control's focus target. */
export const WorkflowsColumnCreationRefContext = React.createContext<FocusReturnMutableRef | null>(null);

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

/**
 * True when the column is the page on a phone-sized window and leads with the page's name, so the home
 * under its Definitions/Runs switch does not head the page a second time (R8). The column decides.
 */
export const WorkflowsColumnHeadsPageContext = React.createContext(false);

export function useWorkflowsColumnHeadsPage(): boolean {
    return React.useContext(WorkflowsColumnHeadsPageContext);
}

/**
 * On a phone the column heads the page with the main-screen head, whose title is the library's space and whose
 * magnifier searches it (owner 11-11). It lends the home the one library controller it reads, so
 * the home draws neither a second scope line nor a second search and narrows through the same instance.
 */
export type WorkflowsColumnLentLibrary = Readonly<{
    libraryView: import('../library/useWorkflowLibraryView').WorkflowLibraryViewController;
}>;

export const WorkflowsColumnLibraryContext = React.createContext<WorkflowsColumnLentLibrary | null>(null);

export function useWorkflowsColumnLentLibrary(): WorkflowsColumnLentLibrary | null {
    return React.useContext(WorkflowsColumnLibraryContext);
}
