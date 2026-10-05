import * as React from 'react';
import type { JsonValue } from '@happier-dev/protocol';
import type { WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import type { WidgetSetupDraft } from '@/components/widgets/add/widgetSetupModel';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { WidgetSurface } from './WidgetSurface';
import { widgetDefinitionOfCandidate } from './widgetSurfaceSetup';

/**
 * The Set up / Edit inputs step's live preview: the same instance body every surface mounts, at the
 * draft's bindings. It goes through the configured-target owner, so a widget pinned to Session B reads
 * with B's own access, machine and plugin projection even when the step opened in A's Companion or on
 * Home. Mounted only while the step is open and the draft resolves; a changed binding retires it.
 */
export function WidgetSetupPreview(props: Readonly<{
    scope: WidgetSurfaceRefV1;
    providedContext: Readonly<Record<string, readonly JsonValue[]>>;
    candidate: WidgetCandidate;
    draft: WidgetSetupDraft;
    testID: string;
}>): React.ReactElement {
    const appRuntime = useAppShellPluginUiProjection();
    const { candidate, draft } = props;
    const instance = React.useMemo(() => ({
        v: 1 as const,
        id: `setup-preview:${candidate.key}`,
        definition: widgetDefinitionOfCandidate(candidate),
        bindings: draft.bindings,
    }), [candidate, draft.bindings]);
    return (
        <WidgetSurface
            scope={props.scope}
            providedContext={props.providedContext}
            descriptor={candidate}
            instance={instance}
            appRuntime={appRuntime}
            presentation="content"
            recordRevision={`setup-preview:${stableJsonStringify(draft.bindings)}`}
            testID={props.testID}
        />
    );
}
