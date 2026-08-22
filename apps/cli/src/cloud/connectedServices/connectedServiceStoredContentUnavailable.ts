export type ConnectedServiceStoredContentKind =
  | 'credential'
  | 'quota_snapshot'
  | 'provider_account_usage_snapshot';

export type ConnectedServiceStoredContentUnavailableReason =
  | 'account_mode_unavailable'
  | 'encryption_material_unavailable'
  | 'stored_content_corrupt';

export class ConnectedServiceStoredContentUnavailableError extends Error {
  readonly code = 'connected_service_stored_content_unavailable' as const;

  constructor(
    readonly contentKind: ConnectedServiceStoredContentKind,
    readonly reason: ConnectedServiceStoredContentUnavailableReason,
    readonly identity: Readonly<{
      serviceId?: string;
      profileId?: string;
      recordId?: string;
    }> = {},
  ) {
    super(`Connected service ${contentKind} is unavailable (${reason})`);
    this.name = 'ConnectedServiceStoredContentUnavailableError';
  }

  get serviceId(): string | undefined {
    return this.identity.serviceId;
  }

  get profileId(): string | undefined {
    return this.identity.profileId;
  }

  get recordId(): string | undefined {
    return this.identity.recordId;
  }
}

export function isConnectedServiceStoredContentUnavailableError(
  error: unknown,
): error is ConnectedServiceStoredContentUnavailableError {
  return error instanceof ConnectedServiceStoredContentUnavailableError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code
        === 'connected_service_stored_content_unavailable'
    );
}
