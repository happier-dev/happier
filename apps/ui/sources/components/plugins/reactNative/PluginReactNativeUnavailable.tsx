import * as React from 'react';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';

type PluginReactNativeUnavailableProps = Readonly<{
    diagnostics?: readonly string[];
}>;

export function PluginReactNativeUnavailable(props: PluginReactNativeUnavailableProps): React.ReactElement {
    const diagnostics = [...new Set(
        (props.diagnostics ?? []).filter((diagnostic) => diagnostic.trim().length > 0),
    )];
    const copy = resolveReasonCopy({ reasonCode: diagnostics[0], kind: 'pluginRuntime' });
    return (
        <SurfaceStateCard
            testID="plugin-rn-ui-unavailable"
            kind="unavailable"
            title={copy.title === t('common.unavailable') ? t('pluginReactNative.unavailable') : copy.title}
            reason={copy.body}
            // The full diagnostic set stays reachable for QA via the testID
            // channel only — never in visible product copy (audit PLG-11).
            diagnosticCode={diagnostics.length > 0 ? diagnostics.slice(0, 3).join('|') : null}
        />
    );
}
