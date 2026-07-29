import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

export function BrowserFrameUnavailable(props: Readonly<{
    testID: string;
    reasonCode?: string;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: props.reasonCode, kind: 'browserFrame' });
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
