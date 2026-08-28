import { join } from 'node:path';

import {
  BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
  parseQualifiedConnectedAccountCredentialPlaintextV1,
  qualifiedPurposeKey,
  sameQualifiedConnectedAccountRef,
  type BuiltInLegacyConnectedServiceId,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
  type QualifiedConnectedAccountPurposeBindingV1,
  type QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';
import type {
  ConnectedAccountMaterialization,
  ConnectedAccountMaterializationRequest,
  ConnectedAccountRuntimeConfiguration,
} from '@happier-dev/plugin-sdk/connected-accounts';

import type {
  ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
  resolveFirstPartyLegacyAgentConnectedAccountServiceId,
} from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';
import type {
  StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { CatalogAgentId } from '@/agent/catalog/ids';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const EXACT_V021_UNFENCED_REVISION_BASIS = 'legacy_unfenced';

type ExactV021OauthCredentialRecord = Extract<
  ConnectedServiceCredentialRecordV1,
  Readonly<{ kind: 'oauth' }>
>;

function requireOauthRecord(
  record: ConnectedServiceCredentialRecordV1,
): ExactV021OauthCredentialRecord {
  if (record.kind !== 'oauth') {
    throw new Error(
      `Exact v0.2.1 Connected Service '${record.serviceId}' requires OAuth credentials`,
    );
  }
  return record;
}

function requireOauthRecordWithExpiry(
  record: ConnectedServiceCredentialRecordV1,
): ExactV021OauthCredentialRecord & Readonly<{ expiresAt: number }> {
  const oauth = requireOauthRecord(record);
  if (typeof oauth.expiresAt !== 'number') {
    throw new Error(
      `Exact v0.2.1 Connected Service '${record.serviceId}' requires OAuth expiry`,
    );
  }
  return oauth as ExactV021OauthCredentialRecord & Readonly<{
    expiresAt: number;
  }>;
}

function requireTokenRecord(
  record: ConnectedServiceCredentialRecordV1,
): Extract<ConnectedServiceCredentialRecordV1, Readonly<{ kind: 'token' }>> {
  if (record.kind !== 'token') {
    throw new Error(
      `Exact v0.2.1 Connected Service '${record.serviceId}' requires token credentials`,
    );
  }
  return record;
}

function buildReleasedOauthAuthEntry(
  record: ConnectedServiceCredentialRecordV1,
): Readonly<Record<string, unknown>> {
  const oauth = requireOauthRecordWithExpiry(record);
  return Object.freeze({
    type: 'oauth',
    refresh: oauth.oauth.refreshToken,
    access: oauth.oauth.accessToken,
    expires: oauth.expiresAt,
    ...(oauth.oauth.providerAccountId
      ? { accountId: oauth.oauth.providerAccountId }
      : {}),
  });
}

/**
 * The exact cli-v0.2.1 Gemini reader accepted persisted OAuth even though the current Gemini
 * Connected Account runtime intentionally exposes only API-key authentication. Keep this fact
 * inside the released compatibility owner; it is not a current authentication mode. Remove it
 * with exact-v0.2.1 persisted credential support.
 */
export function isExactV021GeminiOauthLaunchProjection(input: Readonly<{
  agentId: CatalogAgentId;
  record: ConnectedServiceCredentialRecordV1;
}>): boolean {
  return input.agentId === 'gemini'
    && input.record.serviceId === 'gemini'
    && input.record.kind === 'oauth';
}

function sameService(
  left: QualifiedConnectedAccountRef['service'],
  right: QualifiedConnectedAccountRef['service'],
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function requireExactV021ServiceId(
  service: QualifiedConnectedAccountRef['service'],
): BuiltInLegacyConnectedServiceId {
  const serviceId =
    resolveFirstPartyLegacyAgentConnectedAccountServiceId(service);
  if (
    !serviceId
    || !Object.prototype.hasOwnProperty.call(
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID,
      serviceId,
    )
  ) {
    throw new Error(
      'Exact v0.2.1 Connected Service identity is unsupported',
    );
  }
  return serviceId as BuiltInLegacyConnectedServiceId;
}

/**
 * Host-owned compatibility seam for the credential records emitted by server-v0.2.1
 * (4913c1e533c872a0712ba1c25b3104fd470aacc2) and consumed by cli-v0.2.1
 * (b1d15a8a9c241737d1ca9b167459901e6259173a). Those released responses carry no
 * credential revision, so they can support only the historical one-shot launch materialization.
 *
 * The adapter owns no Agent or credential codec. It validates the generated released-service
 * mapping, translates the historical record to the canonical credential reader, and invokes the
 * current qualified Connected Account runtime's focused `materialize` callback. Remove it when
 * exact v0.2.1 server support ends and persisted no-revision credentials no longer need launch
 * compatibility.
 */
export async function materializeExactV021ConnectedServiceCredential(input: Readonly<{
  registry: Pick<
    ResolvedExecutablePluginRuntimeRegistry,
    'connectedAccountRuntimeInvoker' | 'resolveConnectedAccountRuntime'
  >;
  serviceId: BuiltInLegacyConnectedServiceId;
  account: QualifiedConnectedAccountRef;
  record: ConnectedServiceCredentialRecordV1;
  request: ConnectedAccountMaterializationRequest;
  signal?: AbortSignal;
}>): Promise<ConnectedAccountMaterialization> {
  input.signal?.throwIfAborted();
  const compatibility =
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[
      input.serviceId
    ];
  if (
    !compatibility.peerOperations.exactV0_2_1.some(
      (operation) => operation === 'one_shot_materialization',
    )
    || !sameService(compatibility.service, input.account.service)
    || input.record.serviceId !== input.serviceId
    || input.record.profileId !== input.account.accountId
  ) {
    throw new Error(
      'Exact v0.2.1 Connected Service materialization identity mismatch',
    );
  }

  const authenticationModeId = Object.entries(
    compatibility.authenticationModeByCredentialKind,
  ).find(([credentialKind]) => credentialKind === input.record.kind)?.[1];
  if (!authenticationModeId) {
    throw new Error(
      'Exact v0.2.1 Connected Service authentication mode is unsupported',
    );
  }

  const runtimeLease = await input.registry.resolveConnectedAccountRuntime?.(
    input.account.service,
  );
  const invoker = input.registry.connectedAccountRuntimeInvoker;
  if (!runtimeLease || !invoker || !runtimeLease.isCurrent()) {
    throw new Error(
      'Exact v0.2.1 Connected Service runtime is unavailable',
    );
  }
  const mode = runtimeLease.descriptor.authentication.modes.find(
    (candidate) => candidate.id === authenticationModeId,
  );
  if (!mode) {
    throw new Error(
      'Exact v0.2.1 Connected Service authentication mode is unavailable',
    );
  }
  if ('configuration' in mode && mode.configuration !== undefined) {
    throw new Error(
      'Exact v0.2.1 Connected Service cannot satisfy runtime configuration',
    );
  }

  const credential = parseQualifiedConnectedAccountCredentialPlaintextV1({
    ref: input.account,
    authenticationModeId,
    plaintext: input.record,
  });
  const configuration: ConnectedAccountRuntimeConfiguration = Object.freeze({
    target: Object.freeze({
      kind: 'service',
      service: input.account.service,
      modeId: authenticationModeId,
    }),
    revision: 'unconfigured',
    values: Object.freeze({}),
    getSecret: async () => null,
  });
  const credentials = Object.freeze({
    async get(key: string, options?: Readonly<{ signal?: AbortSignal }>) {
      (options?.signal ?? input.signal)?.throwIfAborted();
      return credential.values[key] ?? null;
    },
  });

  return await invoker.invokeEstablished({
    target: Object.freeze({
      account: input.account,
      // The invoker's opaque target slot is not exposed to the plugin. This canonical boundary
      // label records that the released response supplied no revision; currentness below is
      // intentionally limited to the runtime generation and the one callback.
      expectedCredentialRevision: EXACT_V021_UNFENCED_REVISION_BASIS,
      expectedRuntimeConfigurationRevision: configuration.revision,
    }),
    operation: Object.freeze({
      kind: 'materialize',
      request: input.request,
    }),
    context: Object.freeze({
      account: input.account,
      configuration,
      credentials,
    }),
    isConfigurationCurrent: async (candidate) => (
      candidate === configuration && runtimeLease.isCurrent()
    ),
    // The released peer supplied no revision to re-read. Exact-v0.2.1 admission limits this
    // unfenced fact to the one callback; the runtime generation and cancellation remain fenced.
    isCredentialRevisionCurrent: async () => runtimeLease.isCurrent(),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/**
 * Purpose-bound view used only while adapting the exact-v0.2.1 launch. The immutable spawn
 * snapshot remains the selection authority; this view adds no durable binding, selection,
 * refresh, request-auth, watch, or runtime-registration capability.
 */
export function createExactV021ConnectedServiceMaterializationOwner(input: Readonly<{
  registry: Pick<
    ResolvedExecutablePluginRuntimeRegistry,
    'connectedAccountRuntimeInvoker' | 'resolveConnectedAccountRuntime'
  >;
  purposeBindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
  recordsByServiceId: ReadonlyMap<
    ConnectedServiceId,
    ConnectedServiceCredentialRecordV1
  >;
}>): Pick<StablePluginConnectedAccountsOwner, 'getBinding' | 'materialize'> {
  const accountByPurposeKey = new Map(
    input.purposeBindings.flatMap((binding) => (
      binding.target.kind === 'account'
        ? [[qualifiedPurposeKey(binding.purpose), binding.target.account] as const]
        : binding.target.kind === 'group'
          ? (() => {
              const serviceId = requireExactV021ServiceId(binding.target.service);
              const record = input.recordsByServiceId.get(serviceId);
              return record
                ? [[
                    qualifiedPurposeKey(binding.purpose),
                    Object.freeze({
                      service: binding.target.service,
                      accountId: record.profileId,
                    }),
                  ] as const]
                : [];
            })()
          : []
    )),
  );
  const resolveAccount = (
    purpose: Parameters<StablePluginConnectedAccountsOwner['getBinding']>[0]['purpose'],
    serviceRefs: Parameters<StablePluginConnectedAccountsOwner['getBinding']>[0]['serviceRefs'],
  ): QualifiedConnectedAccountRef | null => {
    const account = accountByPurposeKey.get(qualifiedPurposeKey(purpose));
    if (
      !account
      || !serviceRefs.some((service) => sameService(service, account.service))
    ) {
      return null;
    }
    return account;
  };

  return Object.freeze({
    async getBinding(params) {
      params.signal.throwIfAborted();
      const account = resolveAccount(params.purpose, params.serviceRefs);
      if (!account) return null;
      return Object.freeze({
        purpose: params.purpose.purpose,
        service: account.service,
        account,
        target: Object.freeze({
          kind: 'account' as const,
          displayName: account.accountId,
        }),
      });
    },
    async materialize(params) {
      params.signal.throwIfAborted();
      const account = resolveAccount(params.purpose, params.serviceRefs);
      if (
        !account
        || (
          params.expectedAccount
          && !sameQualifiedConnectedAccountRef(
            params.expectedAccount,
            account,
          )
        )
      ) {
        throw new Error(
          'Exact v0.2.1 Connected Service purpose binding is unavailable',
        );
      }
      const serviceId = requireExactV021ServiceId(account.service);
      const record = input.recordsByServiceId.get(serviceId);
      if (!record) {
        throw new Error(
          'Exact v0.2.1 Connected Service credential is unavailable',
        );
      }
      return await materializeExactV021ConnectedServiceCredential({
        registry: input.registry,
        serviceId,
        account,
        record,
        request: params.request,
        signal: params.signal,
      });
    },
  });
}

/**
 * Closed launch-output projection retained only for Agent compositions that cannot be expressed
 * by one current Connected Account runtime callback. The recipes below are the exact aggregate
 * outputs shipped by cli-v0.2.1 at b1d15a8a9c241737d1ca9b167459901e6259173a:
 * OpenCode's isolated XDG auth file and Pi's isolated Agent auth file.
 *
 * This is deliberately not a generic composer or plugin callback: the input records have already
 * passed the exact-v0.2.1 one-shot admission, the closed Agent/service precedence is immutable,
 * and the result owns no selection, persistence, refresh, request-auth, or runtime lifecycle.
 * Remove each branch with the exact-v0.2.1 compatibility frontier documented above.
 */
export async function materializeExactV021AgentLaunchProjection(input: Readonly<{
  agentId: CatalogAgentId;
  rootDir: string;
  recordsByServiceId: ReadonlyMap<
    ConnectedServiceId,
    ConnectedServiceCredentialRecordV1
  >;
  signal?: AbortSignal;
}>): Promise<Readonly<{ env: Readonly<Record<string, string>> }> | null> {
  input.signal?.throwIfAborted();
  const record = (serviceId: BuiltInLegacyConnectedServiceId) => {
    const candidate = input.recordsByServiceId.get(serviceId) ?? null;
    const compatibility =
      BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID[serviceId];
    if (
      candidate
      && (
        candidate.serviceId !== serviceId
        || !compatibility.peerOperations.exactV0_2_1.some(
          (operation) => operation === 'one_shot_materialization',
        )
      )
    ) {
      throw new Error(
        'Exact v0.2.1 Connected Service launch record identity mismatch',
      );
    }
    return candidate;
  };

  if (input.agentId === 'opencode') {
    const openaiCodex = record('openai-codex');
    const openai = record('openai');
    const anthropic = record('anthropic');
    if (!openaiCodex && !openai && !anthropic) return null;

    const auth: Record<string, unknown> = {};
    if (openaiCodex) {
      auth.openai = buildReleasedOauthAuthEntry(openaiCodex);
    } else if (openai) {
      auth.openai = Object.freeze({
        type: 'api',
        key: requireTokenRecord(openai).token.token,
      });
    }
    if (anthropic) {
      auth.anthropic = Object.freeze({
        type: 'api',
        key: requireTokenRecord(anthropic).token.token,
      });
    }

    const homeDir = join(input.rootDir, 'home');
    const xdgDataHome = join(input.rootDir, 'xdg', 'data');
    const xdgCacheHome = join(input.rootDir, 'xdg', 'cache');
    const xdgConfigHome = join(input.rootDir, 'xdg', 'config');
    const xdgStateHome = join(input.rootDir, 'xdg', 'state');
    input.signal?.throwIfAborted();
    await writeJsonAtomic(join(xdgDataHome, 'opencode', 'auth.json'), auth);
    input.signal?.throwIfAborted();
    return Object.freeze({
      env: Object.freeze({
        HOME: homeDir,
        ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
        XDG_DATA_HOME: xdgDataHome,
        XDG_CACHE_HOME: xdgCacheHome,
        XDG_CONFIG_HOME: xdgConfigHome,
        XDG_STATE_HOME: xdgStateHome,
        OPENCODE_TEST_HOME: homeDir,
      }),
    });
  }

  if (input.agentId === 'pi') {
    const openaiCodex = record('openai-codex');
    const openai = record('openai');
    const subscription = record('claude-subscription');
    const anthropic = record('anthropic');
    if (!openaiCodex && !openai && !subscription && !anthropic) return null;

    const auth: Record<string, unknown> = {};
    const env: Record<string, string> = {};
    if (openaiCodex) {
      auth['openai-codex'] = buildReleasedOauthAuthEntry(openaiCodex);
    }
    if (openai) {
      auth.openai = Object.freeze({
        type: 'api_key',
        key: requireTokenRecord(openai).token.token,
      });
    }
    if (subscription) {
      env.ANTHROPIC_OAUTH_TOKEN = requireTokenRecord(subscription).token.token;
    }
    if (anthropic) {
      env.ANTHROPIC_API_KEY = requireTokenRecord(anthropic).token.token;
    }

    const agentDir = join(input.rootDir, 'pi-agent-dir');
    input.signal?.throwIfAborted();
    await writeJsonAtomic(join(agentDir, 'auth.json'), auth);
    input.signal?.throwIfAborted();
    env.PI_CODING_AGENT_DIR = agentDir;
    return Object.freeze({ env: Object.freeze(env) });
  }

  if (input.agentId === 'gemini') {
    const gemini = record('gemini');
    if (!gemini || !isExactV021GeminiOauthLaunchProjection({
      agentId: input.agentId,
      record: gemini,
    })) {
      return Object.freeze({ env: Object.freeze({}) });
    }
    const oauth = requireOauthRecord(gemini);
    const homeDir = join(input.rootDir, 'home');
    input.signal?.throwIfAborted();
    await writeJsonAtomic(join(homeDir, '.gemini', 'oauth_creds.json'), {
      access_token: oauth.oauth.accessToken,
      token_type: oauth.oauth.tokenType ?? 'Bearer',
      scope:
        oauth.oauth.scope
        ?? 'https://www.googleapis.com/auth/cloud-platform',
      ...(oauth.oauth.refreshToken
        ? { refresh_token: oauth.oauth.refreshToken }
        : {}),
      ...(oauth.oauth.idToken ? { id_token: oauth.oauth.idToken } : {}),
      ...(typeof oauth.expiresAt === 'number'
        ? { expires_at: oauth.expiresAt }
        : {}),
    });
    input.signal?.throwIfAborted();
    return Object.freeze({
      env: Object.freeze({
        HOME: homeDir,
        ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
      }),
    });
  }

  // Other released Agents are covered by the focused per-service runtime path. Keeping the
  // no-op inside this exact seam avoids teaching the generic launch owner a built-in Agent list.
  return Object.freeze({ env: Object.freeze({}) });
}
