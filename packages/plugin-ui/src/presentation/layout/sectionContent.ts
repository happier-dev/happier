import { createContext, useContext } from 'react';

/**
 * Content that already stands in a page section: the host's section has placed it in the column and spaces what it
 * holds. A section drawn inside takes no second section gap above it and no second sheet inset beside it, so it starts
 * where its siblings start (a capture view's Logs sheet beside its Endpoints table, DBW services M1). The host decides
 * once that its content is a section (the app's section owner, `useIsInsideItemSection`) and tells plugin UI here.
 */
export const HappierSectionContentContext = createContext(false);

export function useHappierSectionContent(): boolean {
  return useContext(HappierSectionContentContext);
}
