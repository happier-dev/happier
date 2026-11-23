import * as React from 'react';

import { WIDGET_FLOW_WIDTH_PX, WidgetFlowShell } from '@/components/widgets/flow/WidgetFlowShell';
import { useDeviceType } from '@/utils/platform/responsive';

import type { WidgetSetupPopoverProps } from './WidgetSetupPopover';
import { WidgetSetupStep } from './WidgetSetupStep';

export function WidgetSetupPopoverBody(props: WidgetSetupPopoverProps): React.ReactElement {
    const phone = useDeviceType() === 'phone';
    return <OpenWidgetSetupPopover {...props} phone={phone} />;
}

function OpenWidgetSetupPopover(props: WidgetSetupPopoverProps & Readonly<{ phone: boolean }>): React.ReactElement {
    const [setup] = React.useState(props.setup);
    const step = (
        <WidgetSetupStep
            setup={setup}
            callerContext={props.callerContext}
            phone={props.phone}
            onCancel={props.onRequestClose}
            onClose={props.onRequestClose}
            onDone={props.onDone ?? props.onRequestClose}
            notice={props.notice}
            {...(props.serverId ? { serverId: props.serverId } : {})}
            {...(props.sessionId ? { sessionId: props.sessionId } : {})}
            {...(props.focusPath ? { focusPath: props.focusPath } : {})}
            testID={props.testID}
        />
    );
    return (
        <WidgetFlowShell title={setup.title} testID={props.testID} anchorRef={props.anchorRef} placement={props.placement} width={WIDGET_FLOW_WIDTH_PX.setup} onRequestClose={props.onRequestClose}>
            {step}
        </WidgetFlowShell>
    );
}
