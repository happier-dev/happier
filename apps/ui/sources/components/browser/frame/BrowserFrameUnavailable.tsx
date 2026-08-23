import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

export function BrowserFrameUnavailable(props: Readonly<{
    testID: string;
    reasonCode?: string;
    /**
     * R-3: the system-browser escape. Whenever the caller still knows a URL the user asked for, an
     * unavailable in-app engine must offer to open it in their own browser rather than dead-end.
     * Fulfilled by the caller through the canonical `buildOpenExternalTabSelection` →
     * `openBrowserExternalTabSelection` path, so this card never learns how an OS tab is opened.
     */
    onOpenInSystemBrowser?: () => void;
}>): React.ReactElement {
    const copy = resolveReasonCopy({ reasonCode: props.reasonCode, kind: 'browserFrame' });
    const onOpenInSystemBrowser = props.onOpenInSystemBrowser;
    return (
        <SurfaceStateCard
            testID={`${props.testID}-unavailable`}
            kind="unavailable"
            title={copy.title}
            reason={props.reasonCode ? copy.body : undefined}
            diagnosticCode={copy.diagnosticCode}
            action={onOpenInSystemBrowser ? {
                label: t('browserShell.nonFramable.openInSystemBrowser'),
                onPress: onOpenInSystemBrowser,
            } : undefined}
        />
    );
}
