import * as React from 'react';
import { readWidgetDefinitionArtifactSummaryV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { describeAuthoredWidgetDefinitionV1, describeWidgetDefinitionSummaryV1, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useActiveServerAccountScope, useArtifact } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

/** Shared frame/setup metadata; executable body reads stay with WidgetSurface. */
export function useWidgetInstanceDescriptor(
    scope: Readonly<{ serverId: string; accountId: string }> | null,
    instance: WidgetInstanceV1,
    candidate: WidgetCandidate | null | undefined,
): WidgetCandidate | null {
    const viewer = useActiveServerAccountScope();
    const artifactId = instance.definition.kind === 'artifact' ? instance.definition.artifactId : '';
    const artifact = useArtifact(artifactId);
    return React.useMemo(() => {
        if (instance.definition.kind === 'inline') return describeAuthoredWidgetDefinitionV1(instance.definition.definition, instance.definition, candidate);
        if (instance.definition.kind !== 'artifact') return candidate ?? null;
        if (!scope || !areServerAccountScopesEqual(viewer, scope)) return null;
        if (!artifact?.isDecrypted || artifact.ownerAccountId !== scope.accountId || !artifact.rawHeader) return null;
        const summary = readWidgetDefinitionArtifactSummaryV1(artifactId, artifact.rawHeader);
        return summary ? describeWidgetDefinitionSummaryV1(summary, candidate) : null;
    }, [viewer, scope?.serverId, scope?.accountId, artifactId, artifact, instance.definition, candidate]);
}
