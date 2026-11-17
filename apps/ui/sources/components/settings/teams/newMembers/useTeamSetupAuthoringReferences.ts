import * as React from 'react';
import type { PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { projectSourceOnboardingTaskReferenceV1 } from '@happier-dev/protocol/projects/sources/projectSourceOnboardingTaskV1';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useProjectSources } from '@/components/projects/sources/useProjectSources';

/** L5 consumes the Source owner's scoped catalog and mutation state without reading prompt bodies. */
export function useTeamSetupAuthoringReferences(scope: ServerAccountScope, teamId: string, options: Readonly<{
    enabled?: boolean;
    lifetime?: ServerAccountScopeLifetime | null;
}> = {}) {
    const sources = useProjectSources(scope, { enabled: options.enabled, lifetime: options.lifetime,
        sharedWithTeamId: teamId, repositoryFacts: false });
    const rows = React.useMemo(() => sources.state.rows.map(source => ({ source,
        taskReference: projectSourceOnboardingTaskReferenceV1({ serverId: scope.serverId, source }) })),
    [scope.serverId, sources.state.rows]);
    const setSuggestedTask = React.useCallback((source: ProjectSourceV1, ref: PromptDocArtifactRefV1 | null) => {
        if (ref) return sources.controller.updateSource({ attachment: { kind: 'attach', attachment: { purpose: 'onboarding_task', ref } } }, source);
        const current = projectSourceOnboardingTaskReferenceV1({ serverId: scope.serverId, source });
        return current ? sources.controller.updateSource({ attachment: { kind: 'detach', purpose: 'onboarding_task', ref: current.ref } }, source)
            : Promise.resolve(undefined);
    }, [scope.serverId, sources.controller]);
    return { ...sources, rows, setSuggestedTask };
}
