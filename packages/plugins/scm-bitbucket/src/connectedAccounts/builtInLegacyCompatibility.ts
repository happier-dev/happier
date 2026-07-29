// Dev preactivation basis 877ee97a0df346a1daaa541632dc42643d533120 produced persisted
// Bitbucket credentials. Remove after activation is no longer rollback/coexistence-reachable
// and no persisted Bitbucket row needs migration or reverse projection.
export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY = Object.freeze([
  {
    legacyServiceId: 'bitbucket',
    serviceLocalId: 'bitbucket-account',
    peerOperations: {
      exactV0_2_1: [],
      revisionedV2V3: [],
    },
    exactV0_2_1ReaderQuotaProjection: false,
    defaultAuthenticationModeId: 'manual',
    authenticationModeByCredentialKind: { token: 'manual' },
  },
] as const);
