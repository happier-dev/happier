import * as React from 'react';
import type { WidgetDefinitionRefV1, WidgetDefinitionV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { useActiveServerAccountScope, useArtifact } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readWidgetDefinitionForInstanceV1 } from './widgetDefinitionRead';

/** Existing per-Artifact invalidation feeds the canonical Action read, never a second byte store. */
export type MountedWidgetDefinitionV1 = Readonly<{ definition: WidgetDefinitionV1 | null; state: 'loading' | 'available' | 'unavailable'; reasonCode?: string }>;
export function useWidgetDefinition(scope: WidgetSurfaceRefV1, reference: WidgetDefinitionRefV1, enabled = true): MountedWidgetDefinitionV1 {
    const viewer = useActiveServerAccountScope();
    const artifactId = reference.kind === 'artifact' ? reference.artifactId : '';
    const artifact = useArtifact(artifactId);
    const lifetime = React.useMemo(() => captureActiveServerAccountScopeLifetime(), [viewer?.serverId, viewer?.accountId]);
    const [opened, setOpened] = React.useState<Readonly<{ artifactId: string; definition: WidgetDefinitionV1 | null; cached: boolean; reasonCode?: string }> | null>(null);
    const current = enabled && !!lifetime?.isCurrent() && areServerAccountScopesEqual(viewer, scope);
    React.useEffect(() => {
        if (!current || !artifactId || !lifetime) { setOpened(null); return; }
        const controller = new AbortController();
        const retirement = lifetime.onRetire(() => controller.abort());
        if (!artifact) setOpened(null);
        void import('@/sync/ops/actions/defaultActionExecutor').then(({ createDefaultActionExecutor }) =>
            readWidgetDefinitionForInstanceV1(createDefaultActionExecutor(), scope, { kind: 'artifact', artifactId }, controller.signal),
        ).then(definition => {
            if (!controller.signal.aborted && lifetime.isCurrent()) setOpened({ artifactId, definition, cached: !!artifact,
                ...(!definition ? { reasonCode: 'widget_definition_not_found' } : {}) });
        }).catch((error: unknown) => {
            const reasonCode = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'widget_definition_unavailable';
            if (!controller.signal.aborted && lifetime.isCurrent()) setOpened({ artifactId, definition: null, cached: false, reasonCode });
        });
        return () => { retirement.dispose(); controller.abort(); };
    }, [current, lifetime, scope.serverId, scope.accountId, artifactId, artifact?.headerVersion, artifact?.bodyVersion, artifact?.seq, !!artifact]);
    if (!current) return { definition: null, state: 'unavailable', reasonCode: 'widget_scope_unavailable' };
    if (reference.kind === 'inline') return { definition: reference.definition, state: 'available' };
    if (opened?.artifactId !== artifactId || opened.cached && !artifact) return { definition: null, state: 'loading' };
    return { definition: opened.definition, state: opened.definition ? 'available' : 'unavailable', reasonCode: opened.reasonCode };
}
