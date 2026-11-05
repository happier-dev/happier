import * as React from 'react';

import { useDesktopActivityOverlayField } from '../runtime/useDesktopActivityOverlayState';
import { DesktopActivityOverlayExpanded } from './DesktopActivityOverlayExpanded';
import type { DesktopActivityOverlayUiModel } from './shared/desktopActivityOverlayUiModel';

const EMPTY_LIST_DETAIL: DesktopActivityOverlayUiModel['expanded'] = { title: '', rows: [] };

/** Only the opened list consumes detail; the island subscribes to its blocking summary. */
export function DesktopActivityOverlayListPanel(props: Omit<React.ComponentProps<typeof DesktopActivityOverlayExpanded>, 'model'>): React.ReactElement {
    const listDetail = useDesktopActivityOverlayField('listDetail');
    const model = React.useMemo(() => ({ expanded: listDetail ?? EMPTY_LIST_DETAIL }), [listDetail]);
    return <DesktopActivityOverlayExpanded {...props} model={model} />;
}
