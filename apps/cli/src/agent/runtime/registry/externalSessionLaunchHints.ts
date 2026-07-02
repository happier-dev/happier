import type { BackendSessionLaunchHintsV1 } from '@happier-dev/agents';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import type { LoadedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { ResolvedBackendContribution } from '@/plugins/projection/registry/types';

function resolveBackendTargetForContribution(backend: ResolvedBackendContribution): BackendTargetRefV2 {
    if (backend.provenance === 'first_party' && backend.source.kind === 'bundled') {
        return {
            kind: 'backend',
            backendId: backend.id,
            sourceKind: 'built_in',
        };
    }

    return {
        kind: 'backend',
        backendId: backend.id,
        configuredBackendId: backend.id,
        sourceKind: 'configured',
    };
}

export function mapExternalSessionLaunchHintsToSpawnOptions(params: Readonly<{
    backend: ResolvedBackendContribution;
    hints: BackendSessionLaunchHintsV1;
    linked: LoadedLinkedExternalSession;
    sessionId: string;
    fallbackDirectory?: string | null;
}>): SpawnSessionOptions {
    return {
        directory: params.hints.directory ?? params.fallbackDirectory ?? params.linked.sessionPath ?? '',
        backendTarget: resolveBackendTargetForContribution(params.backend),
        existingSessionId: params.sessionId,
        resume: params.linked.remoteSessionId,
        approvedNewDirectoryCreation: true,
        transcriptStorage: 'direct',
        ...(params.linked.providerId === 'codex' && params.linked.codexBackendMode
            ? { codexBackendMode: params.linked.codexBackendMode }
            : {}),
        ...(params.hints.environmentVariables ? { environmentVariables: { ...params.hints.environmentVariables } } : {}),
    };
}
