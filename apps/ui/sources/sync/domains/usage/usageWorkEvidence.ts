import { projectUsageQueryWorkEvidence as projectOpenedUsageQueryWorkEvidence,
    projectUsageSessionInput as projectOpenedUsageSessionInput,
    type OpenedUsageSession, type UsageSessionStateEvidence } from '@happier-dev/protocol/usage/usageWorkEvidence';
import type { UsageHowYouWorkDetailInput } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { isSessionContentReadable, readSessionContentAvailability } from '@/sync/domains/session/encryptedContentAvailability';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { projectUsageCoachRemedySession } from './buildUsageCoachRemedies';

export { selectUsageQueryWorkEvidenceSessionIds } from '@happier-dev/protocol/usage/usageWorkEvidence';
type UsageSession = Pick<Session, 'id' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView' | 'agentState' | 'sessionTurns' | 'active'>
    & Partial<Pick<Session, 'createdAt' | 'origin' | 'manager'>> & { stateEvidence?: UsageSessionStateEvidence };
type UsageSessionIdentity = Pick<Session, 'serverId' | 'seq' | 'updatedAt' | 'metadataVersion' | 'agentStateVersion'
    | 'metadataLayoutVersion' | 'encryptionMode' | 'encryptedContentAvailability' | 'access'>;
export type UsageSessionInput = OpenedUsageSession & Omit<UsageSessionIdentity, 'access'>
    & Readonly<{ access?: NonNullable<Session['access']> }>
    & Pick<ReturnType<typeof projectUsageCoachRemedySession>, 'active' | 'ownerMetadata' | 'agentTarget'>;

/** Keep the owning admission identity beside only the canonical consumed facts. */
export function projectUsageSessionInput(session: UsageSession & UsageSessionIdentity): UsageSessionInput {
    return { ...projectOpenedUsageSessionInput({ ...session, metadata: readSessionOwnerMetadataView(session) }),
        ...projectUsageCoachRemedySession(session),
        serverId: session.serverId, seq: session.seq, updatedAt: session.updatedAt,
        metadataVersion: session.metadataVersion, agentStateVersion: session.agentStateVersion,
        metadataLayoutVersion: session.metadataLayoutVersion, encryptionMode: session.encryptionMode,
        encryptedContentAvailability: session.encryptedContentAvailability, access: session.access ?? undefined };
}

/** UI admission stays at its captured Account/content owners; projection is shared with CLI. */
export function projectUsageQueryWorkEvidence(input: Omit<Parameters<typeof projectOpenedUsageQueryWorkEvidence>[0], 'sessions'> & Readonly<{
    scope: ServerAccountScope; currentScope: ServerAccountScope | null; isCurrent: boolean;
    sessions: readonly (OpenedUsageSession & UsageSessionIdentity)[];
}>): UsageHowYouWorkDetailInput {
    if (!input.isCurrent || !areServerAccountScopesEqual(input.scope, input.currentScope)) return { status: 'unknown' };
    const sessions = input.sessions.filter(session => (!session.serverId || session.serverId === input.scope.serverId)
        && session.access?.capabilities.readTranscript !== false
        && isSessionContentReadable(readSessionContentAvailability(session)));
    return projectOpenedUsageQueryWorkEvidence({ ...input, sessions });
}
