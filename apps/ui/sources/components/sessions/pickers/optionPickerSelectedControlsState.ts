import * as React from 'react';
import type {
  SessionConfigOptionControl,
  SessionConfigOptionValueId,
} from '@/sync/domains/sessionControl/configOptionsControl';

export const OptionPickerSelectedControlsContext = React.createContext<
  Readonly<{
    controls?: readonly SessionConfigOptionControl[];
    onSelect?: (configId: string, valueId: SessionConfigOptionValueId) => void;
    multiColumn?: boolean;
  }>
>({});
