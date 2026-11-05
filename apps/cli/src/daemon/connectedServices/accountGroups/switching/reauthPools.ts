import type { QualifiedConnectedAccountRef, ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';

export type ConnectedAccountReauthEvent = Readonly<{
    account: QualifiedConnectedAccountRef;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
}>;
