import * as React from 'react';
import type { View } from 'react-native';

import { AnchoredWidgetShell, WIDGET_FLOW_WIDTH_PX, WidgetSheetShell } from '@/components/widgets/flow/WidgetFlowShell';
import { useDeviceType } from '@/utils/platform/responsive';

import { WidgetSetupStep } from './WidgetSetupStep';
import type { WidgetSetup, WidgetSetupSubmitResult } from './widgetSetupModel';

/**
 * Edit inputs and in-card repair (lab dbind E/Ep, dagent ST): the same step as the Add pane, in its
 * own popover and sheet, anchored to the widget's ⋯ (or its repair action). Only this copy changes.
 */
export function WidgetSetupPopover(props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    placement?: 'top' | 'bottom';
    /** Built when it opens; nothing reads while it is closed. */
    setup: () => WidgetSetup;
    onRequestClose: () => void;
    onDone?: (result: Extract<WidgetSetupSubmitResult, { ok: true }>) => void;
    serverId?: string | null;
    sessionId?: string | null;
    /** A repair opens the step at the input it names, its choices open. */
    focusPath?: string;
    testID: string;
}>): React.ReactElement | null {
    const phone = useDeviceType() === 'phone';
    if (!props.open) return null;
    return <OpenWidgetSetupPopover {...props} phone={phone} />;
}

function OpenWidgetSetupPopover(props: React.ComponentProps<typeof WidgetSetupPopover> & Readonly<{ phone: boolean }>): React.ReactElement {
    const [setup] = React.useState(props.setup);
    const step = (
        <WidgetSetupStep
            setup={setup}
            phone={props.phone}
            onCancel={props.onRequestClose}
            onClose={props.onRequestClose}
            onDone={props.onDone ?? props.onRequestClose}
            {...(props.serverId ? { serverId: props.serverId } : {})}
            {...(props.sessionId ? { sessionId: props.sessionId } : {})}
            {...(props.focusPath ? { focusPath: props.focusPath } : {})}
            testID={props.testID}
        />
    );
    return props.phone ? (
        <WidgetSheetShell title={setup.title} onRequestClose={props.onRequestClose} testID={`${props.testID}.sheet`}>{step}</WidgetSheetShell>
    ) : (
        <AnchoredWidgetShell anchorRef={props.anchorRef} placement={props.placement} width={WIDGET_FLOW_WIDTH_PX.setup} onRequestClose={props.onRequestClose}>
            {step}
        </AnchoredWidgetShell>
    );
}
