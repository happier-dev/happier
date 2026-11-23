import * as React from 'react';
import type { View } from 'react-native';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';

import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import type { WidgetSetup, WidgetSetupSubmitResult } from './widgetSetupModel';

export type WidgetSetupPopoverProps = Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    placement?: 'top' | 'bottom';
    /** Built when it opens; nothing reads while it is closed. */
    setup: () => WidgetSetup;
    onRequestClose: () => void;
    onDone?: (result: Extract<WidgetSetupSubmitResult, { ok: true }>) => void;
    notice?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    callerContext?: ActionExecutorContext;
    /** A repair opens the step at the input it names, its choices open. */
    focusPath?: string;
    testID: string;
}>;

const WidgetSetupPopoverBody = retryableLazy(async () => ({
    default: (await import('./WidgetSetupPopoverBody')).WidgetSetupPopoverBody,
}));

/**
 * Edit inputs and in-card repair (lab dbind E/Ep, dagent ST): the same step as the Add pane, in its
 * own popover and sheet, anchored to the widget's ⋯ (or its repair action). Only this copy changes.
 */
export function WidgetSetupPopover(props: WidgetSetupPopoverProps): React.ReactElement | null {
    if (!props.open) return null;
    return <React.Suspense fallback={null}>
        <WidgetSetupPopoverBody {...props} />
    </React.Suspense>;
}
