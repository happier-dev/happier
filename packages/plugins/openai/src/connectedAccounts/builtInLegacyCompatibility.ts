// Exact released producers/readers: server-v0.2.1 (4913c1e533c872a0712ba1c25b3104fd470aacc2)
// and cli-v0.2.1 (b1d15a8a9c241737d1ca9b167459901e6259173a). Remove only after
// that support window ends and persisted legacy credentials no longer need projection.
export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY = Object.freeze([
  {
    legacyServiceId: 'openai',
    serviceLocalId: 'openai',
    peerOperations: {
      exactV0_2_1: [
        'account_list',
        'credential_read',
        'one_shot_materialization',
      ],
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
    exactV0_2_1ReaderQuotaProjection: true,
    defaultAuthenticationModeId: 'api-key',
    authenticationModeByCredentialKind: { token: 'api-key' },
  },
] as const);
