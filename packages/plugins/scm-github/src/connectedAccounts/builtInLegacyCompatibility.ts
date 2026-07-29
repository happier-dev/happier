// Prospective Remote basis e67f3751f1ab5dc13e40a583a28f3962111154aa produces legacy
// GitHub credentials consumed by Dev activation. Remove after the predecessor stops producing
// that shape and no persisted GitHub row needs migration or reverse projection.
export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY = Object.freeze([
  {
    legacyServiceId: 'github',
    serviceLocalId: 'github-account',
    peerOperations: {
      exactV0_2_1: [],
      revisionedV2V3: [
        'account_list',
        'credential_read',
        'credential_write',
        'credential_delete',
        'credential_health',
        'refresh_lease',
        'one_shot_materialization',
        'quota_read',
        'quota_refresh',
        'quota_poll',
        'provider_account_usage_write',
      ],
    },
    exactV0_2_1ReaderQuotaProjection: false,
    defaultAuthenticationModeId: 'fine-grained-pat',
    authenticationModeByCredentialKind: { token: 'fine-grained-pat' },
  },
] as const);
