import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';

export function SimulatorUnavailableState(props: Readonly<{
    reasonCode?: string;
    testID: string;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: props.reasonCode, kind: 'simulatorPreview' });
    return (
        <SurfaceStateCard
            testID={`${props.testID}-unavailable`}
            kind="unavailable"
            title={copy.title}
            reason={props.reasonCode ? copy.body : undefined}
            diagnosticCode={copy.diagnosticCode}
        />
    );
}
