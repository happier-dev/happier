import * as React from 'react';
import type {
  SessionConfigOptionControl,
  SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';

/** Where a list row's text starts in a picker pane (a phone sheet); a card keeps its own inset. */
export const OPTION_PICKER_LIST_TEXT_INSET_PX = 14;

export const OptionPickerSelectedControlsContext = React.createContext<
  Readonly<{
    controls?: readonly SessionConfigOptionControl[];
    onSelect?: (configId: string, valueId: SessionConfigOptionValueId) => void;
    multiColumn?: boolean;
  }>
>({});
