import * as React from 'react';

const ModalCoveredContext = React.createContext(false);

/**
 * Whether another dialog of the same host stands in front of this one. The modal host decides it from its
 * one stack order; a covered dialog's shell is inert, so Tab, clicks and assistive technology reach only
 * the front dialog until it closes.
 */
export function ModalCoveredProvider(
  props: Readonly<{ covered: boolean; children: React.ReactNode }>,
) {
  return (
    <ModalCoveredContext.Provider value={props.covered}>
      {props.children}
    </ModalCoveredContext.Provider>
  );
}

export const useModalCovered = () => React.useContext(ModalCoveredContext);
