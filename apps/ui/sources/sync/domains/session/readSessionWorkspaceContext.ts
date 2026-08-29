import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from './readSessionOwnerMetadataView';
import { readSessionMetadataLayoutVersion } from '@/sync/engine/sessions/parsePlainSessionPayload';

type SessionWorkspaceContextState = Readonly<{
    sessions?: Record<string, {
        metadata?: Session['metadata'];
        metadataLayoutVersion?: Session['metadataLayoutVersion'];
        ownerMetadataView?: Session['ownerMetadataView'];
    }>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string | null; rootPath?: string | null } } | null;
}>;

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function readSessionWorkspaceContext(
    state: SessionWorkspaceContextState,
    sessionId: string,
): Readonly<{
    workspacePath: string | null;
    projectPath: string | null;
    projectMachineId: string | null;
}> {
    const session = state.sessions?.[sessionId];
    const metadata = session
        ? readSessionOwnerMetadataView({
            metadataLayoutVersion: session.metadataLayoutVersion,
            metadata: session.metadata ?? null,
            ownerMetadataView: session.ownerMetadataView,
        })
        : null;
    const sessionPath = normalizeNonEmptyString(metadata?.path);
    const project = typeof state.getProjectForSession === 'function' ? state.getProjectForSession(sessionId) : null;
    const projectPath = normalizeNonEmptyString(project?.key?.rootPath);
    const projectMachineId = normalizeNonEmptyString(project?.key?.machineId);
    const metadataLayoutVersion = readSessionMetadataLayoutVersion(session?.metadataLayoutVersion);
    const ownerViewUnavailable = metadataLayoutVersion !== 0 && metadata == null;
    return {
        workspacePath: ownerViewUnavailable ? null : sessionPath ?? projectPath,
        projectPath,
        projectMachineId,
    };
}
