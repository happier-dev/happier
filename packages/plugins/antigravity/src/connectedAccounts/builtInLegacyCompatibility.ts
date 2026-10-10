// Forward storage ingress for 0.2 Antigravity profiles, bindings and OAuth records.
// Antigravity was never understood by the supported closed legacy peer service enums.
// Retire when persisted 0.2 rows no longer need qualified-service normalization.
export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY = Object.freeze([
  {
    legacyServiceId: 'antigravity',
    serviceLocalId: 'antigravity-account',
    peerOperations: { exactV0_2_1: [], revisionedV2V3: [] },
    exactV0_2_1ReaderQuotaProjection: false,
    defaultAuthenticationModeId: 'oauth-personal',
    authenticationModeByCredentialKind: { oauth: 'oauth-personal' },
    unsupportedAuthenticationModeByCredentialKind: { token: 'legacy-token-unsupported' },
  },
] as const);
