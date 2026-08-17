import * as React from 'react';

import {
    SurfaceStateCard,
    type SurfaceStateAction,
    type SurfaceStateAccessibilitySemantics,
} from '@/components/ui/surfaces/SurfaceStateCard';
import { resolvePluginSurfaceStatePresentation } from '@/sync/domains/surfaces/copy';

export function PluginSurfaceFallback(props: Readonly<{
    testID: string;
    /** Raw host/runtime diagnostic; the shared presentation owner localizes it. */
    reasonCode?: string | null;
    /** Caller-owned recovery through an incumbent host surface. */
    action?: SurfaceStateAction;
    /** Dynamic mount failures announce through the shared terminal-state owner. */
    accessibilitySemantics?: SurfaceStateAccessibilitySemantics;
}>): React.ReactElement {
    const presentation = resolvePluginSurfaceStatePresentation({
        state: 'unavailable',
        reasonCode: props.reasonCode,
    });
    const card = presentation.card;
    if (!card) {
        throw new Error('plugin_surface_unavailable_presentation_missing_card');
    }
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind={card.kind}
            title={card.title}
            reason={card.reason}
            diagnosticCode={presentation.diagnosticCode}
            action={props.action}
            accessibilitySemantics={props.accessibilitySemantics ?? card.accessibilitySemantics}
        />
    );
}
