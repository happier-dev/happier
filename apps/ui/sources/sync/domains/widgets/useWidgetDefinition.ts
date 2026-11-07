import * as React from 'react';
import type { WidgetDefinitionRefV1, WidgetDefinitionV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { useActiveServerAccountScopeLifetime, useArtifact } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { readWidgetDefinitionArtifactV1 } from '@happier-dev/protocol/widgets/widgetDefinitionArtifactV1';
import { useArtifactBody } from '@/components/artifacts/useArtifactBody';

/** Existing per-Artifact invalidation feeds the canonical exact Artifact reader, never a second byte store. */
export type MountedWidgetDefinitionV1 = Readonly<{ definition: WidgetDefinitionV1 | null; state: 'loading' | 'available' | 'unavailable'; reasonCode?: string }>;
export function useWidgetDefinition(scope: WidgetSurfaceRefV1, reference: WidgetDefinitionRefV1, enabled = true, admittedViewer?: ServerAccountScope): MountedWidgetDefinitionV1 {
    const lifetime = useActiveServerAccountScopeLifetime();
    const viewer = lifetime?.scope ?? null;
    const artifactId = reference.kind === 'artifact' ? reference.artifactId : '';
    const artifact = useArtifact(artifactId);
    const current = enabled && !!lifetime?.isCurrent() && !!viewer && areServerProfileIdentifiersEquivalent(viewer.serverId, scope.serverId)
        && (viewer.accountId === scope.accountId || reference.kind === 'inline' && areServerAccountScopesEqual(viewer, admittedViewer));
    // One body hydration/publication owner serves Documents and exact saved definitions.
    // Its publication acknowledgement prevents our own row from restarting its read.
    const body = useArtifactBody(artifactId, current && artifactId ? artifact ?? null : null,
        { readMissing: current && !!artifactId });
    const opened = React.useMemo<MountedWidgetDefinitionV1>(() => {
        if (body.state === 'missing') return { definition: null, state: 'unavailable', reasonCode: 'widget_definition_not_found' };
        if (!artifact) return { definition: null, state: body.state === 'failed' ? 'unavailable' : 'loading',
            ...(body.state === 'failed' ? { reasonCode: 'widget_definition_unavailable' } : {}) };
        if (!artifact.ownerAccountId || artifact.access === undefined) return { definition: null, state: body.state === 'failed' ? 'unavailable' : 'loading',
            ...(body.state === 'failed' ? { reasonCode: 'widget_definition_unavailable' } : {}) };
        if (artifact.id !== artifactId || artifact.ownerAccountId !== scope.accountId)
            return { definition: null, state: 'unavailable', reasonCode: 'widget_definition_account_mismatch' };
        if (!artifact.isDecrypted || !artifact.rawHeader || artifact.body === null
            || artifact.body !== undefined && typeof artifact.body !== 'string')
            return { definition: null, state: 'unavailable', reasonCode: 'widget_definition_unavailable' };
        if (artifact.body === undefined) return { definition: null, state: body.state === 'failed' ? 'unavailable' : 'loading',
            ...(body.state === 'failed' ? { reasonCode: 'widget_definition_unavailable' } : {}) };
        try {
            return { definition: readWidgetDefinitionArtifactV1({ artifactId, header: artifact.rawHeader, body: artifact.body }), state: 'available' };
        } catch {
            return { definition: null, state: 'unavailable', reasonCode: 'widget_definition_unavailable' };
        }
    }, [artifact, artifactId, scope.accountId, body.state]);
    if (!current) {
        // A saved definition is its owner's private Artifact: another Account's viewer on a live Home never
        // reads it, a durable access fact and not a Home that is still being applied.
        const privateToOwner = enabled && reference.kind === 'artifact' && !!lifetime?.isCurrent() && !!viewer
            && areServerProfileIdentifiersEquivalent(viewer.serverId, scope.serverId) && viewer.accountId !== scope.accountId;
        return { definition: null, state: 'unavailable', reasonCode: privateToOwner ? 'widget_definition_unavailable' : 'widget_scope_unavailable' };
    }
    if (reference.kind === 'inline') return { definition: reference.definition, state: 'available' };
    return opened;
}
