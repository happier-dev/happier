import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

export function BrowserFrameError(props: Readonly<{
    testID: string;
    errorCode?: string;
    onReload?: () => void;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: props.errorCode, kind: 'browserFrame' });
    return (
        <SurfaceStateCard
            testID={`${props.testID}-error`}
            kind="error"
            title={t('browserShell.frame.errorTitle')}
            reason={copy.body}
            diagnosticCode={copy.diagnosticCode}
            action={props.onReload ? {
                label: t('browserShell.toolbar.reloadAfterCrash'),
                onPress: props.onReload,
            } : undefined}
        />
    );
}
