import type {
  ConnectedServiceCredentialKind,
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

export type ScmHostingTokenMaterializationRequest = Readonly<{
  kind: 'scm_hosting_token';
  providerId: string;
  host: string;
  profileId?: string | null;
  records: readonly ConnectedServiceCredentialRecordV1[];
}>;

export type ScmHostingTokenMaterializationAvailable = Readonly<{
  kind: 'available';
  token: string;
  profileId: string;
  serviceId: ConnectedServiceId;
  credentialKind: ConnectedServiceCredentialKind;
  providerAccountId: string | null;
  providerEmail: string | null;
}>;

export type ScmHostingTokenMaterializationMissingReason =
  | 'unsupported_materialization'
  | 'unsupported_provider'
  | 'unsupported_host'
  | 'credential_unavailable';

export type ScmHostingTokenMaterializationMissing = Readonly<{
  kind: 'missing';
  reason: ScmHostingTokenMaterializationMissingReason;
}>;

export type ScmHostingTokenMaterializationResult =
  | ScmHostingTokenMaterializationAvailable
  | ScmHostingTokenMaterializationMissing;

export type ScmHostingTokenMaterializer = Readonly<{
  serviceId: ConnectedServiceId;
  materialize(request: ScmHostingTokenMaterializationRequest): ScmHostingTokenMaterializationResult;
}>;

export type ScmHostingBasicAuthMaterializationRequest = Readonly<{
  kind: 'scm_hosting_basic_auth';
  providerId: string;
  host: string;
  profileId?: string | null;
  records: readonly ConnectedServiceCredentialRecordV1[];
}>;

export type ScmHostingBasicAuthMaterializationAvailable = Readonly<{
  kind: 'available';
  username: string;
  password: string;
  profileId: string;
  serviceId: ConnectedServiceId;
  credentialKind: 'bitbucket_basic_auth';
  providerAccountId: string | null;
  providerEmail: string | null;
}>;

export type ScmHostingBasicAuthMaterializationMissingReason =
  | 'unsupported_materialization'
  | 'unsupported_provider'
  | 'unsupported_host'
  | 'credential_unavailable';

export type ScmHostingBasicAuthMaterializationMissing = Readonly<{
  kind: 'missing';
  reason: ScmHostingBasicAuthMaterializationMissingReason;
}>;

export type ScmHostingBasicAuthMaterializationResult =
  | ScmHostingBasicAuthMaterializationAvailable
  | ScmHostingBasicAuthMaterializationMissing;

export type ScmHostingBasicAuthMaterializer = Readonly<{
  serviceId: ConnectedServiceId;
  materialize(request: ScmHostingBasicAuthMaterializationRequest): ScmHostingBasicAuthMaterializationResult;
}>;
