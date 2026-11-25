import { createContext } from 'react';

/** A group editor hands a refused field back to the mounted child that owns its editor. */
export const WidgetGroupChildInputRepairContext = createContext<Readonly<{
    childId: string;
    fieldPath: string | undefined;
    consume: () => void;
}> | null>(null);
