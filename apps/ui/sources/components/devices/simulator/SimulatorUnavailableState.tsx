import * as React from 'react';

import { SurfaceStateCard, type SurfaceStateAction } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';

/** One cause (the reason owner's copy) and, when there is one, the one next action. */
export function SimulatorUnavailableState(props: Readonly<{
    reasonCode?: string;
    failurePresentation?: Pick<React.ComponentProps<typeof SurfaceStateCard>, 'reason' | 'diagnosticCode' | 'diagnosticDetail'>;
    action?: SurfaceStateAction;
    testID: string;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: props.reasonCode, kind: 'simulatorPreview' });
    return (
        <SurfaceStateCard
            testID={`${props.testID}-unavailable`}
            kind="unavailable"
            iconName="device-mobile"
            title={copy.title}
            reason={props.failurePresentation?.reason ?? (props.reasonCode ? copy.body : undefined)}
            diagnosticCode={props.failurePresentation?.diagnosticCode ?? copy.diagnosticCode}
            diagnosticDetail={props.failurePresentation?.diagnosticDetail}
            action={props.action}
        />
    );
}
