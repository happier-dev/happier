import type { SessionStoredContentContext } from '@happier-dev/sync-client';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { SessionBoardCapabilities } from '@/sync/domains/session/board';
import type { ServerCredentialAccountScopeResolution } from '@/sync/domains/scope/serverCredentialAccountScope';
import type { SessionSystemRecordRepository } from './repository';
import type { SessionSystemRecordFetchResult } from './transport';

export type SessionSystemRecordUnavailableReason = Exclude<SessionSystemRecordFetchResult<never>, { status: 'ok' }>['status']
    | 'invalid_address' | Exclude<ServerCredentialAccountScopeResolution['kind'], 'bound' | 'resolving'>;
export type SessionSystemRecordObservationBase = Readonly<{
    session: SessionAddress;
    repository: SessionSystemRecordRepository;
    readCapabilities: () => SessionBoardCapabilities | null;
    readContentContext: () => SessionStoredContentContext | null;
    isCurrent: () => boolean;
}>;
