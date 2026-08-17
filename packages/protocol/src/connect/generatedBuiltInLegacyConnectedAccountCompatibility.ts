/**
 * GENERATED FILE. DO NOT EDIT.
 *
 * Built-in-only host-private compatibility for supported legacy Connected Service ids.
 * Public manifests and external plugins cannot add or claim entries in this projection.
 *
 * Immutable released bases: server-v0.2.1 at 4913c1e533c872a0712ba1c25b3104fd470aacc2
 * and cli-v0.2.1 at b1d15a8a9c241737d1ca9b167459901e6259173a.
 * The prospective Remote at e67f3751f1ab5dc13e40a583a28f3962111154aa is the
 * legacy GitHub credential producer consumed during Dev activation. Dev preactivation at
 * 877ee97a0df346a1daaa541632dc42643d533120 produced persisted Bitbucket credentials.
 * Remove this compatibility projection only after exact 0.2.1 support ends, the Remote
 * predecessor no longer produces a required shape, and persisted legacy rows no longer
 * require migration or reverse projection.
 */

export type BuiltInLegacyConnectedAccountOperation =
  | "account_list"
  | "credential_read"
  | "credential_write"
  | "credential_delete"
  | "credential_health"
  | "refresh_lease"
  | "oauth_refresh"
  | "one_shot_materialization"
  | "request_auth"
  | "quota_read"
  | "quota_refresh"
  | "quota_poll"
  | "recovery_credit_consume"
  | "provider_account_usage_write"
;

export type BuiltInLegacyConnectedAccountCompatibility = Readonly<{
  service: Readonly<{
    pluginId: string;
    localId: string;
  }>;
  peerOperations: Readonly<{
    exactV0_2_1: readonly BuiltInLegacyConnectedAccountOperation[];
    revisionedV2V3: readonly BuiltInLegacyConnectedAccountOperation[];
  }>;
  exactV0_2_1ReaderQuotaProjection: boolean;
  defaultAuthenticationModeId: string;
  authenticationModeByCredentialKind: Readonly<Partial<Record<"oauth" | "token", string>>>;
  unsupportedAuthenticationModeByCredentialKind: Readonly<Partial<Record<"oauth" | "token", string>>>;
}>;

export const BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID = Object.freeze({
  "openai-codex": Object.freeze({
    service: Object.freeze({
      pluginId: "happier.agent.codex",
      localId: "openai-codex",
    }),
    peerOperations: Object.freeze({
      exactV0_2_1: Object.freeze(["account_list","credential_read","one_shot_materialization"] as const),
      revisionedV2V3: Object.freeze(["account_list","credential_read","credential_write","credential_delete","credential_health","refresh_lease","oauth_refresh","one_shot_materialization","request_auth","quota_read","quota_refresh","quota_poll","recovery_credit_consume","provider_account_usage_write"] as const),
    }),
    exactV0_2_1ReaderQuotaProjection: true,
    defaultAuthenticationModeId: "oauth",
    authenticationModeByCredentialKind: Object.freeze({
      oauth: "oauth",
    }),
    unsupportedAuthenticationModeByCredentialKind: Object.freeze({
      token: "legacy-token-unsupported",
    }),
  }),
  "openai": Object.freeze({
    service: Object.freeze({
      pluginId: "happier.voice.openai",
      localId: "openai",
    }),
    peerOperations: Object.freeze({
      exactV0_2_1: Object.freeze(["account_list","credential_read","one_shot_materialization"] as const),
      revisionedV2V3: Object.freeze(["account_list","credential_read","credential_write","credential_delete","credential_health","refresh_lease","one_shot_materialization","quota_read","quota_refresh","quota_poll","provider_account_usage_write"] as const),
    }),
    exactV0_2_1ReaderQuotaProjection: true,
    defaultAuthenticationModeId: "api-key",
    authenticationModeByCredentialKind: Object.freeze({
      token: "api-key",
    }),
    unsupportedAuthenticationModeByCredentialKind: Object.freeze({
    }),
  }),
  "anthropic": Object.freeze({
    service: Object.freeze({
      pluginId: "happier.agent.claude",
      localId: "anthropic",
    }),
    peerOperations: Object.freeze({
      exactV0_2_1: Object.freeze(["account_list","credential_read","one_shot_materialization"] as const),
      revisionedV2V3: Object.freeze(["account_list","credential_read","credential_write","credential_delete","credential_health","refresh_lease","one_shot_materialization","quota_read","quota_refresh","quota_poll","provider_account_usage_write"] as const),
    }),
    exactV0_2_1ReaderQuotaProjection: true,
    defaultAuthenticationModeId: "api-key",
    authenticationModeByCredentialKind: Object.freeze({
      token: "api-key",
    }),
    unsupportedAuthenticationModeByCredentialKind: Object.freeze({
    }),
  }),
  "claude-subscription": Object.freeze({
    service: Object.freeze({
      pluginId: "happier.agent.claude",
      localId: "claude-subscription",
    }),
    peerOperations: Object.freeze({
      exactV0_2_1: Object.freeze(["account_list","credential_read","one_shot_materialization"] as const),
      revisionedV2V3: Object.freeze(["account_list","credential_read","credential_write","credential_delete","credential_health","refresh_lease","oauth_refresh","one_shot_materialization","request_auth","quota_read","quota_refresh","quota_poll","provider_account_usage_write"] as const),
    }),
    exactV0_2_1ReaderQuotaProjection: true,
    defaultAuthenticationModeId: "setup-token",
    authenticationModeByCredentialKind: Object.freeze({
      oauth: "oauth",
      token: "setup-token",
    }),
    unsupportedAuthenticationModeByCredentialKind: Object.freeze({
    }),
  }),
  "gemini": Object.freeze({
    service: Object.freeze({
      pluginId: "happier.agent.gemini",
      localId: "gemini-account",
    }),
    peerOperations: Object.freeze({
      exactV0_2_1: Object.freeze(["account_list","credential_read","one_shot_materialization"] as const),
      revisionedV2V3: Object.freeze(["account_list","credential_read","credential_write","credential_delete","credential_health","refresh_lease","one_shot_materialization","quota_read","quota_refresh","quota_poll","provider_account_usage_write"] as const),
    }),
    exactV0_2_1ReaderQuotaProjection: true,
    defaultAuthenticationModeId: "api-key",
    authenticationModeByCredentialKind: Object.freeze({
      token: "api-key",
    }),
    unsupportedAuthenticationModeByCredentialKind: Object.freeze({
      oauth: "legacy-oauth-unsupported",
    }),
  }),
  "github": Object.freeze({
    service: Object.freeze({
      pluginId: "happier.scm.forge.github",
      localId: "github-account",
    }),
    peerOperations: Object.freeze({
      exactV0_2_1: Object.freeze([] as const),
      revisionedV2V3: Object.freeze(["account_list","credential_read","credential_write","credential_delete","credential_health","refresh_lease","one_shot_materialization","quota_read","quota_refresh","quota_poll","provider_account_usage_write"] as const),
    }),
    exactV0_2_1ReaderQuotaProjection: false,
    defaultAuthenticationModeId: "fine-grained-pat",
    authenticationModeByCredentialKind: Object.freeze({
      token: "fine-grained-pat",
    }),
    unsupportedAuthenticationModeByCredentialKind: Object.freeze({
    }),
  }),
  "bitbucket": Object.freeze({
    service: Object.freeze({
      pluginId: "happier.scm.forge.bitbucket",
      localId: "bitbucket-account",
    }),
    peerOperations: Object.freeze({
      exactV0_2_1: Object.freeze([] as const),
      revisionedV2V3: Object.freeze([] as const),
    }),
    exactV0_2_1ReaderQuotaProjection: false,
    defaultAuthenticationModeId: "manual",
    authenticationModeByCredentialKind: Object.freeze({
      token: "manual",
    }),
    unsupportedAuthenticationModeByCredentialKind: Object.freeze({
    }),
  }),
} as const satisfies Readonly<Record<string, BuiltInLegacyConnectedAccountCompatibility>>);

export type BuiltInLegacyConnectedServiceId =
  keyof typeof BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID;
