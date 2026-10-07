import * as React from 'react';
import { isSameWidgetDefinitionV1, widgetCandidateDefinitionV1, readWidgetDefinitionArtifactSummaryV1, type WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { useShallow } from 'zustand/react/shallow';
import { describeAuthoredWidgetDefinitionV1, describeWidgetDefinitionSummaryV1, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { storage, useActiveServerAccountScope, useArtifact } from '@/sync/domains/state/storage';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

type AccountScope = Readonly<{ serverId: string; accountId: string }> | null;

function resolveWidgetInstanceDescriptor(scope: AccountScope, viewer: AccountScope, instance: WidgetInstanceV1 | null,
    candidate: WidgetCandidate | null | undefined, artifact: DecryptedArtifact | null | undefined): WidgetCandidate | null {
    if (!instance) return null;
    if (instance.definition.kind === 'inline') return describeAuthoredWidgetDefinitionV1(instance.definition.definition, instance.definition, candidate);
    if (instance.definition.kind !== 'artifact') return candidate ?? null;
    if (!scope || !areServerAccountScopesEqual(viewer, scope)) return null;
    if (!artifact?.isDecrypted || artifact.ownerAccountId !== scope.accountId || !artifact.rawHeader) return null;
    const summary = readWidgetDefinitionArtifactSummaryV1(instance.definition.artifactId, artifact.rawHeader);
    return summary ? describeWidgetDefinitionSummaryV1(summary, candidate) : null;
}

/** Referenced header metadata only, before a direct-child grid chooses each cell's footprint. */
export function useWidgetInstanceDescriptors(scope: AccountScope, instances: readonly WidgetInstanceV1[],
    candidates: readonly WidgetCandidate[]): readonly (WidgetCandidate | null)[] {
    const viewer = useActiveServerAccountScope();
    const artifacts = storage(useShallow(state => instances.map(instance => instance.definition.kind === 'artifact'
        ? state.artifacts[instance.definition.artifactId] ?? null : null)));
    return React.useMemo(() => instances.map((instance, index) => resolveWidgetInstanceDescriptor(scope, viewer, instance,
        candidates.find(candidate => isSameWidgetDefinitionV1(widgetCandidateDefinitionV1(candidate), instance.definition)), artifacts[index])),
        [scope?.serverId, scope?.accountId, viewer, instances, candidates, artifacts]);
}

/** Shared frame/setup metadata; executable body reads stay with WidgetSurface. */
export function useWidgetInstanceDescriptor(
    scope: Readonly<{ serverId: string; accountId: string }> | null,
    instance: WidgetInstanceV1 | null,
    candidate: WidgetCandidate | null | undefined,
): WidgetCandidate | null {
    const viewer = useActiveServerAccountScope();
    const artifactId = instance?.definition.kind === 'artifact' ? instance.definition.artifactId : '';
    const artifact = useArtifact(artifactId);
    return React.useMemo(() => resolveWidgetInstanceDescriptor(scope, viewer, instance, candidate, artifact),
        [viewer, scope?.serverId, scope?.accountId, artifact, instance?.definition, candidate]);
}
