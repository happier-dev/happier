import * as React from 'react';
import type { AppWindowRecord } from './appWindowBoot';

export const AppWindowRecordContext = React.createContext<AppWindowRecord | null>(null);

export function useDesktopAppWindowRecord(): AppWindowRecord | null {
    return React.useContext(AppWindowRecordContext);
}
