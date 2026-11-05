import * as React from 'react';

/**
 * What a hosting pane stacks around a filling picker's options (the engine pane's routing hint and
 * Agent controls). The picker's one scroll owner carries them with the title, search and options, so
 * the whole pane scrolls as one and they never compete with the list for height.
 */
export const OptionPickerPaneSlotsContext = React.createContext<Readonly<{
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}> | null>(null);
