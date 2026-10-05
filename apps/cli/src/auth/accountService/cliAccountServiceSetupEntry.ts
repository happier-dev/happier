import tweetnacl from 'tweetnacl';
import {
  ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1,
  AccountDirectoryCapabilitiesSchema,
  AccountDirectoryHomesResponseV1Schema,
  HomeLoginAssertionResponseV1Schema,
  HomeLoginCredentialPayloadV1Schema,
  HomeLoginRedemptionResultV1Schema,
  HOME_LOGIN_HTTP_PATH_V1,
  buildAccountDirectoryHomeLoginAssertionHttpPathV1,
  decodeBase64,
  encodeBase64,
  formatRecoveryKey,
  normalizeServerIdentityIdCapability,
  type AccountDirectoryHomeEntryV1,
  type HomeSignInServicePolicyV1,
} from '@happier-dev/protocol';
import {
  observeAccountServiceHomeApproval,
  resolveEffectiveSignInService,
  runAccountServiceDirectoryJourney,
  selectAccountServiceAuthenticationMethod,
  type AccountContinuationIntent,
  type AccountServiceDirectoryJourneyResult,
  type AccountServiceHomeApproval,
  type AccountServiceHomeEnrollmentAdapters,
  type AccountServiceHomeEnrollmentResult,
} from '@happier-dev/cli-common/accountService';
import {
  projectAuthenticationMethodCatalog,
  projectAuthenticationMethodCatalogFromAuthEntry,
  type ProjectedAuthenticationCatalog,
} from '@happier-dev/cli-common/authentication/authMethodCatalog';
import type { HomeTargetInput } from '@happier-dev/cli-common/homeTarget';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';
import { createStepPrinter } from '@happier-dev/cli-common/output';

import { libsodiumDecryptForSecretKey } from '@/api/encryption';
import { registerMachineWithAuthenticatedHomeRuntime } from '@/ui/auth';
import { promptInput, promptSecretInput } from '@/terminal/prompts/promptInput';
import { promptMultipleChoice } from '@/terminal/prompts/promptMultipleChoice';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { buildTerminalAuthorityCeilingHttpHeaders } from '@/settings/accountSettings/resolveEffectiveTerminalPresentUserPolicy';
import { acquireTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentRuntime';
import { verifyTerminalAuthEnrollmentRuntime } from '@/auth/terminalAuthEnrollmentClient';
import {
  adoptServerProfileHomeConnectionDescriptor,
  useServerProfile,
} from '@/server/serverProfiles';
import {
  readStoredCredentialsForServerId,
  writeStoredCredentialsForServerId,
} from '@/persistence';
import { runWithServerProfileSelection } from '@/server/serverSelection';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { resolveAccountSettingsCachePath } from '@/settings/accountSettings/accountSettingsCache';
import { hasUsableAccountSettingsEncryptionMaterial } from '@/settings/accountSettings/accountSettingsEncryptionMaterial';
import { createCliAccountServiceSessionOwner, type CliAccountServiceSelection } from './cliAccountServiceSession';
import {
  runCliAccountServiceHomeEntry,
  type CliAccountServiceAuthenticationOutcome,
  type CliAccountServiceDirectoryAttemptOutcome,
  type CliAccountServiceHomeEntryOutcome,
  type CliAccountServiceHomeEntryPorts,
  type CliAccountServiceRequestedMethod,
} from './cliAccountServiceHomeEntry';
import {
  authenticateCliAccountService,
  parseCliAccountServiceRecoveryKey,
} from './cliAccountServiceAuth';
import { fetchCliHomeAuthEntry } from './cliAuthEntryClient';

type CliHomeEnrollmentTransport = Extract<
  Awaited<ReturnType<typeof acquireTerminalAuthEnrollmentRuntime>>,
  { ok: true }
>;
type CliHomeEnrollmentCredential = ReturnType<typeof HomeLoginCredentialPayloadV1Schema.parse>;
type CliHomeEnrollmentCommit = Readonly<{
  profileId: string;
  material: 'ready' | 'missing' | 'invalid';
  machineRegistered: boolean;
}>;
type CliHomeEnrollmentAdapters = AccountServiceHomeEnrollmentAdapters<
  Uint8Array,
  CliHomeEnrollmentTransport,
  CliHomeEnrollmentCredential,
  CliHomeEnrollmentCommit
>;

export type CliAccountServiceSetupEntryInput = Readonly<{
  /** Explicit override. When absent, the persisted selection remains authoritative. */
  endpoint?: string;
  expectedServerIdentityId?: string;
  promptInputFn?: typeof promptInput;
  promptSecretInputFn?: typeof promptSecretInput;
  signal?: AbortSignal;
  timeoutMs?: number;
  context?:
    | Readonly<{ kind: 'explicit'; target: HomeTargetInput; policy?: HomeSignInServicePolicyV1 }>
    | Readonly<{ kind: 'selected'; target: Extract<HomeTargetInput, { kind: 'saved_profile' }>; policy?: HomeSignInServicePolicyV1 }>
    | Readonly<{ kind: 'none' }>;
  intent?: Exclude<AccountContinuationIntent, Readonly<{ kind: 'refresh' }>>;
  deviceSelection?: Readonly<{ endpoint: string; expectedServerIdentityId?: string }>;
  builtInNoTargetDefault?: Readonly<{ endpoint: string; expectedServerIdentityId?: string }>;
  continueMachineAndService?: CliAccountServiceHomeEntryPorts['continueMachineAndService'];
  /**
   * `sign_in` stops once the sign-in service credential is committed: no Home
   * directory read, no Home entered, and the active Home is left unchanged.
   */
  stopAfter?: 'sign_in';
}>;

export type CliAccountServiceSetupEntryOutcome =
  | CliAccountServiceHomeEntryOutcome
  | Readonly<{ kind: 'signed_in'; endpoint: string }>;

function endpointUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/u, '')}${path}`;
}

function readCommittedMaterialStageError(error: unknown): Readonly<{
  profileId: string;
  retryMaterial: () => Promise<CliHomeEnrollmentCommit>;
}> | null {
  if (typeof error !== 'object' || error === null) return null;
  if (!('stage' in error) || error.stage !== 'material') return null;
  if (!('homeCredentialCommitted' in error) || error.homeCredentialCommitted !== true) return null;
  if (!('profileId' in error) || typeof error.profileId !== 'string' || !error.profileId.trim()) return null;
  if (!('retryMaterial' in error) || typeof error.retryMaterial !== 'function') return null;
  return {
    profileId: error.profileId,
    retryMaterial: error.retryMaterial as () => Promise<CliHomeEnrollmentCommit>,
  };
}

async function jsonRequest(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return await response.json();
}

type StoredAccountServiceCredentialValidation =
  | Readonly<{ kind: 'valid' }>
  | Readonly<{ kind: 'rejected' }>
  | Readonly<{ kind: 'account_service_unavailable' }>
  | Readonly<{ kind: 'cancelled' }>;

async function validateStoredAccountServiceCredential(input: Readonly<{
  service: CliAccountServiceSelection;
  requestOrigin: string;
  credential: Readonly<{ token: string }>;
  signal?: AbortSignal;
}>): Promise<StoredAccountServiceCredentialValidation> {
  if (input.signal?.aborted) return { kind: 'cancelled' };
  try {
    const response = await fetch(endpointUrl(input.requestOrigin, '/v1/account-directory/me'), {
      headers: { Authorization: `Bearer ${input.credential.token}`, ...buildTerminalAuthorityCeilingHttpHeaders({ token: input.credential.token, serverHttpBaseUrl: input.requestOrigin }) },
      signal: input.signal,
    });
    if (response.ok) return { kind: 'valid' };
    if (response.status === 401 || response.status === 403) return { kind: 'rejected' };
    return { kind: 'account_service_unavailable' };
  } catch {
    return input.signal?.aborted
      ? { kind: 'cancelled' }
      : { kind: 'account_service_unavailable' };
  }
}

function discoverMethods(catalog: ProjectedAuthenticationCatalog) {
  const keyMethods = catalog.methods
    .flatMap((method, methodIndex) => method.id === 'key_challenge'
      ? method.enabledActions.flatMap((action, actionIndex) => (
      (action.id === 'login' || action.id === 'provision')
        && (action.mode === 'keyed' || action.mode === 'either')
        ? [{ action: action.id, mode: 'keyed' as const, catalogOrder: [methodIndex, actionIndex] as const }]
        : []
      ))
      : []);
  const oauthMethods = catalog.methods.flatMap((method, methodIndex) => {
    // Native email/password has its own secret-safe CLI command surface. This
    // coordinator cannot execute it, so never treat it as generic OAuth.
    if (method.id === 'key_challenge' || method.id === 'mtls' || method.id === 'email_password') return [];
    return method.enabledActions.flatMap((action, actionIndex) => {
      if (action.id !== 'login' && action.id !== 'provision') return [];
      const mode = action.mode === 'either'
        ? action.id === 'provision' ? 'keyed' : 'keyless'
        : action.mode;
      return [{
        providerId: method.id,
        displayName: method.presentation?.displayName ?? method.id,
        action: action.id,
        mode,
        catalogOrder: [methodIndex, actionIndex] as const,
      }];
    });
  });
  const oauthProviderIds = [...new Set(oauthMethods.map((method) => method.providerId))];
  return {
    advertisedMethods: {
      keyLoginAvailable: keyMethods.some((method) => method.action === 'login'),
      oauthProviderIds,
      preferredProvisionProviderId: oauthMethods.find((method) => method.action === 'provision')?.providerId ?? null,
    },
    keyMethods,
    oauthMethods,
  };
}

type CliAccountServiceDiscoveryResult =
  | Readonly<{
      kind: 'ready';
      service: CliAccountServiceSelection;
      /** The service endpoint also publishes a Home, i.e. the dual-role deployment. */
      serviceIsAlsoHome: boolean;
      keyMethods: readonly Readonly<{ action: 'login' | 'provision'; mode: 'keyed'; catalogOrder: readonly [number, number] }>[];
      oauthMethods: readonly Readonly<{
        providerId: string;
        displayName: string;
        action: 'login' | 'provision';
        mode: 'keyed' | 'keyless';
        catalogOrder: readonly [number, number];
      }>[];
    }>
  | Readonly<{ kind: 'account_service_unavailable' }>
  | Readonly<{ kind: 'identity_mismatch' }>;

async function discoverService(
  input: CliAccountServiceSetupEntryInput & Readonly<{
    endpoint: string;
    requestOrigin: string;
    selfTarget?: Awaited<ReturnType<typeof resolveCliHomeTarget>>;
    selfRuntime?: CliHomeEnrollmentTransport['runtime'];
  }>,
): Promise<CliAccountServiceDiscoveryResult> {
  const endpoint = input.endpoint.trim().replace(/\/+$/u, '');
  const snapshot = await fetchServerFeaturesSnapshot({ serverUrl: input.requestOrigin, signal: input.signal, timeoutMs: input.timeoutMs });
  if (snapshot.status !== 'ready') return { kind: 'account_service_unavailable' };
  if (input.selfTarget && input.selfRuntime) {
    try {
      verifyTerminalAuthEnrollmentRuntime({ target: input.selfTarget, runtime: input.selfRuntime, snapshot });
    } catch {
      return { kind: 'identity_mismatch' };
    }
  }
  const capability = AccountDirectoryCapabilitiesSchema.safeParse(snapshot.features.capabilities.accountDirectory);
  const serverIdentityId = normalizeServerIdentityIdCapability(
    snapshot.features.capabilities.serverIdentity.serverIdentityId,
  );
  const canonicalServerUrl = snapshot.features.capabilities.server.canonicalServerUrl?.replace(/\/+$/u, '');
  if (!capability.success || !capability.data.homeDirectory || !serverIdentityId || !canonicalServerUrl) {
    return { kind: 'account_service_unavailable' };
  }
  if (input.expectedServerIdentityId && input.expectedServerIdentityId !== serverIdentityId) {
    return { kind: 'identity_mismatch' };
  }
  const entry = await fetchCliHomeAuthEntry({
    serverUrl: input.requestOrigin,
    purpose: 'account_service',
    signal: input.signal,
    timeoutMs: input.timeoutMs,
  });
  const catalog = entry.kind === 'ready' && entry.projection.state === 'ready'
    ? projectAuthenticationMethodCatalogFromAuthEntry(entry.projection)
    : entry.kind === 'unsupported'
      ? projectAuthenticationMethodCatalog(snapshot.features)
      : null;
  if (!catalog) return { kind: 'account_service_unavailable' };
  const methods = discoverMethods(catalog);
  return {
    kind: 'ready',
    service: { endpoint, serverIdentityId, canonicalServerUrl, advertisedMethods: methods.advertisedMethods },
    serviceIsAlsoHome: Boolean(snapshot.features.homeConnectionDescriptor),
    oauthMethods: methods.oauthMethods,
    keyMethods: methods.keyMethods,
  };
}

async function chooseMethod(
  service: CliAccountServiceSelection,
  keyMethods: readonly Readonly<{ action: 'login' | 'provision'; mode: 'keyed'; catalogOrder: readonly [number, number] }>[],
  oauthMethods: readonly Readonly<{
    providerId: string;
    displayName: string;
    action: 'login' | 'provision';
    mode: 'keyed' | 'keyless';
    catalogOrder: readonly [number, number];
  }>[],
  input: CliAccountServiceSetupEntryInput,
): Promise<Readonly<{ method: CliAccountServiceRequestedMethod; key?: Uint8Array }> | null> {
  const presentedMethods = [
    ...oauthMethods.map((method, index) => ({ kind: 'oauth' as const, method, displayIndex: index + 1 })),
    ...keyMethods.map((method) => ({ kind: 'key' as const, method })),
  ].sort((left, right) => left.method.catalogOrder[0] - right.method.catalogOrder[0]
    || left.method.catalogOrder[1] - right.method.catalogOrder[1]);
  const choices = [
    ...presentedMethods.map((entry) => entry.kind === 'oauth'
      ? {
          id: `provider:${entry.method.providerId}:${entry.method.action}:${entry.method.mode}`,
          keys: [String(entry.displayIndex), ...(oauthMethods.findIndex((candidate) => candidate.providerId === entry.method.providerId) === entry.displayIndex - 1
            ? [entry.method.providerId]
            : [])],
          short: String(entry.displayIndex),
        }
      : {
          id: `key:${entry.method.action}:keyed`,
          keys: entry.method.action === 'login' ? ['k', 'key'] : ['n', 'new'],
          short: entry.method.action === 'login' ? 'k' : 'n',
        }),
    { id: 'cancel', keys: ['x', 'cancel'], short: 'x' },
  ];
  if (choices.length === 1) return null;
  const promptInputFn = input.promptInputFn;
  if (!promptInputFn) return null;
  const selected = await promptMultipleChoice(
    [
      'How would you like to find your Homes?',
      ...presentedMethods.map((entry) => entry.kind === 'oauth'
        ? entry.method.action === 'provision'
          ? `  ${entry.displayIndex}) New here? Continue with ${entry.method.displayName}`
          : `  ${entry.displayIndex}) Continue with ${entry.method.displayName}`
        : entry.method.action === 'login'
          ? '  k) Use an account key'
          : '  n) New here? Create an account key'),
      '  x) Cancel',
    ].join('\n'),
    choices,
    { defaultId: choices[0]!.id, maxAttempts: 3, promptInputFn },
  );
  if (selected === 'cancel') return null;
  const exactKeyMethod = keyMethods.find((method) => selected === `key:${method.action}:keyed`) ?? null;
  const exactOauthMethod = exactKeyMethod
    ? null
    : oauthMethods.find((method) => selected
      === `provider:${method.providerId}:${method.action}:${method.mode}`) ?? null;
  if (exactKeyMethod?.action === 'provision') {
    return { method: { kind: 'key', action: 'provision', mode: 'keyed' } };
  }
  const methodSelection = selectAccountServiceAuthenticationMethod({
    advertised: service.advertisedMethods,
    requested: exactKeyMethod
      ? { kind: 'key' }
      : { kind: 'oauth', providerId: exactOauthMethod?.providerId },
  });
  if (methodSelection.kind !== 'selected') return null;
  if (methodSelection.method.kind === 'oauth') {
    return exactOauthMethod
      ? {
          method: {
            kind: 'provider',
            providerId: exactOauthMethod.providerId,
            action: exactOauthMethod.action,
            mode: exactOauthMethod.mode,
          },
        }
      : null;
  }
  const raw = await (input.promptSecretInputFn ?? promptSecretInput)('Account key: ');
  const key = parseCliAccountServiceRecoveryKey(raw);
  return key ? { method: { kind: 'key', action: 'login', mode: 'keyed' }, key } : null;
}

export async function runCliAccountServiceSetupEntry(
  input: CliAccountServiceSetupEntryInput,
): Promise<CliAccountServiceSetupEntryOutcome> {
  if (input.signal?.aborted) return { kind: 'cancelled' };
  const session = createCliAccountServiceSessionOwner({ happyHomeDir: resolveHappyHomeDirFromEnvironment(process.env) });
  const persistedSelection = input.endpoint === undefined
    ? await session.readSelection()
    : null;
  const context = input.context ?? { kind: 'none' };
  const builtInNoTargetDefault = input.builtInNoTargetDefault;
  let contextTarget: Awaited<ReturnType<typeof resolveCliHomeTarget>> | null = null;
  let contextPolicy = context.kind === 'none' ? undefined : context.policy;
  let selfTransport: CliHomeEnrollmentTransport | null = null;
  let selfTarget: Awaited<ReturnType<typeof resolveCliHomeTarget>> | null = null;
  if (context.kind !== 'none') {
    try {
      contextTarget = await resolveCliHomeTarget(context.target);
      if (contextPolicy === undefined) {
        const acquired = await acquireTerminalAuthEnrollmentRuntime(
          contextTarget.descriptor ?? contextTarget,
          contextTarget.preferredTransport,
          input.signal,
        );
        if (!acquired.ok) {
          return input.signal?.aborted
            ? { kind: 'cancelled' }
            : { kind: 'account_service_unavailable' };
        }
        selfTransport = acquired;
        const snapshot = await fetchServerFeaturesSnapshot({
          serverUrl: acquired.runtime.runtimeOrigin,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        });
        if (snapshot.status !== 'ready') {
          await acquired.close();
          selfTransport = null;
          return input.signal?.aborted
            ? { kind: 'cancelled' }
            : { kind: 'account_service_unavailable' };
        }
        verifyTerminalAuthEnrollmentRuntime({ target: contextTarget, runtime: acquired.runtime, snapshot });
        const entry = await fetchCliHomeAuthEntry({
          serverUrl: acquired.runtime.runtimeOrigin,
          purpose: 'home',
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        });
        if (entry.kind === 'ready') {
          contextPolicy = entry.projection.signInService;
        } else if (entry.kind === 'unsupported') {
          contextPolicy = snapshot.features.signInService;
        } else {
          await acquired.close();
          selfTransport = null;
          return { kind: 'account_service_unavailable' };
        }
        if (contextPolicy?.mode !== 'self') {
          await acquired.close();
          selfTransport = null;
        }
      }
    } catch {
      if (selfTransport) await selfTransport.close().catch(() => undefined);
      return input.signal?.aborted
        ? { kind: 'cancelled' }
        : { kind: 'account_service_unavailable' };
    }
  }
  const effectiveService = input.endpoint
    ? { kind: 'no_target_default' as const, endpoint: input.endpoint, ...(input.expectedServerIdentityId ? { expectedServerIdentityId: input.expectedServerIdentityId } : {}) }
    : resolveEffectiveSignInService({
        targetContext: context.kind === 'none'
          ? { kind: 'none' }
          : { kind: 'home', target: context.target, ...(contextPolicy ? { policy: contextPolicy } : {}) },
        ...(persistedSelection
          ? { deviceSelection: { endpoint: persistedSelection.endpoint, expectedServerIdentityId: persistedSelection.serverIdentityId } }
          : input.deviceSelection ? { deviceSelection: input.deviceSelection } : {}),
        ...(builtInNoTargetDefault ? { builtInNoTargetDefault } : {}),
      });
  if (effectiveService.kind === 'not_offered') {
    return { kind: context.kind === 'none' ? 'home_unavailable' : 'account_service_unavailable' };
  }
  if (context.kind !== 'none') {
    if (!input.promptInputFn) return { kind: 'cancelled' };
    const selectedEntry = await promptMultipleChoice(
      [
        'How would you like to continue?',
        '  d) Sign in directly to this Home',
        '  s) Use the recommended sign-in service',
        '  x) Cancel',
      ].join('\n'),
      [
        { id: 'direct', keys: ['d', 'direct', ''], short: 'd' },
        { id: 'service', keys: ['s', 'service'], short: 's' },
        { id: 'cancel', keys: ['x', 'cancel'], short: 'x' },
      ] as const,
      { defaultId: 'direct', maxAttempts: 3, promptInputFn: input.promptInputFn },
    );
    if (selectedEntry !== 'service') {
      if (selfTransport) await selfTransport.close().catch(() => undefined);
      return { kind: selectedEntry === 'direct' ? 'direct_home_selected' : 'cancelled' };
    }
  }
  if (effectiveService.kind === 'self') {
    try {
      selfTarget = contextTarget ?? await resolveCliHomeTarget(effectiveService.target);
      if (!selfTransport) {
        const acquired = await acquireTerminalAuthEnrollmentRuntime(
          selfTarget.descriptor ?? selfTarget,
          selfTarget.preferredTransport,
          input.signal,
        );
        if (!acquired.ok) {
          return input.signal?.aborted
            ? { kind: 'cancelled' }
            : { kind: 'home_unavailable' };
        }
        selfTransport = acquired;
      }
    } catch {
      return input.signal?.aborted
        ? { kind: 'cancelled' }
        : { kind: 'home_unavailable' };
    }
  }
  const requestOrigin = selfTransport?.runtime.runtimeOrigin
    ?? (effectiveService.kind === 'self' ? selfTarget!.applicationUrl : effectiveService.endpoint);
  const canonicalEndpoint = effectiveService.kind === 'self'
    ? selfTarget!.canonicalAuthUrl
    : effectiveService.endpoint;
  const expectedServerIdentityId = effectiveService.kind === 'self'
    ? selfTarget!.homeServerIdentityId ?? undefined
    : effectiveService.expectedServerIdentityId;
  try {
    const discovery = await discoverService({
      ...input,
      endpoint: canonicalEndpoint,
      requestOrigin,
      ...(expectedServerIdentityId ? { expectedServerIdentityId } : {}),
      ...(selfTarget && selfTransport
        ? { selfTarget, selfRuntime: selfTransport.runtime }
        : {}),
    });
  if (discovery.kind !== 'ready') {
    return input.signal?.aborted ? { kind: 'cancelled' } : { kind: discovery.kind };
  }
  const service = discovery.service;
  const usesTargetDerivedService = context.kind !== 'none' && input.endpoint === undefined;
  if (!usesTargetDerivedService) await session.selectService(service);
  const storedCredential = await session.readCredential(service);
  let existingAuthentication: Extract<
    CliAccountServiceAuthenticationOutcome,
    { kind: 'authenticated' }
  > | null = null;
  if (storedCredential) {
    const validation = await validateStoredAccountServiceCredential({
      service,
      requestOrigin,
      credential: storedCredential,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (validation.kind === 'valid') {
      existingAuthentication = {
        kind: 'authenticated',
        target: { endpoint: service.endpoint, serverIdentityId: service.serverIdentityId },
        credential: storedCredential,
      };
    } else if (validation.kind === 'rejected') {
      await session.rejectCredential(service);
    } else {
      return { kind: validation.kind };
    }
  }
  const selected = existingAuthentication
    ? null
    : await chooseMethod(service, discovery.keyMethods, discovery.oauthMethods, input);
  const authenticationInput = existingAuthentication
    ? { existingAuthentication } as const
    : selected
      ? {
          method: selected.method,
          ...(selected.key ? { key: selected.key } : {}),
        } as const
      : null;
  if (!authenticationInput) return { kind: 'cancelled' };
  if (input.stopAfter === 'sign_in' && 'existingAuthentication' in authenticationInput) {
    return { kind: 'signed_in', endpoint: service.endpoint };
  }
  const profileIds = new Map<string, string>();
  const homeLabels = new Map<string, string>();
  const progress = createStepPrinter({ appearance: 'planet' });
  // The animated step printer owns its own terminal rows and redraws over
  // anything written under it. Every message and prompt this entry emits goes
  // through `announce`/`withoutProgress`, which yield the terminal first and
  // resume the current step afterwards.
  let currentStage = input.stopAfter === 'sign_in' ? 'Signing in' : 'Signing in and finding linked Homes';
  const showStage = (label: string): void => {
    currentStage = label;
    progress.start(label);
  };
  const announce = (line: string): void => {
    progress.info(line);
    progress.start(currentStage);
  };
  const withoutProgress = async <T>(run: () => Promise<T>): Promise<T> => {
    progress.pause();
    try {
      return await run();
    } finally {
      progress.start(currentStage);
    }
  };
  showStage(currentStage);
  const openSelectedHome: CliAccountServiceHomeEntryPorts['openSelectedHome'] = async ({ profileId }) => {
    try { await useServerProfile(profileId); return { kind: 'opened' }; } catch { return { kind: 'home_unavailable' }; }
  };
  // Enrollment commits the credential and machine registration while its
  // authenticated carrier is still alive. The composing setup command owns
  // the post-focus service/agent continuation. Missing composition must fail
  // closed rather than reporting a Home entry that has not finished setup.
  const continueMachineAndService: CliAccountServiceHomeEntryPorts['continueMachineAndService'] = input.continueMachineAndService
    ?? (async () => ({ kind: 'failed' as const }));

  const authenticateExactMethod: CliAccountServiceHomeEntryPorts['authenticateExactMethod'] = async ({ method, key, signal, timeoutMs }) => {
    const auth = await session.authenticate({
      service,
      timeoutMs: timeoutMs ?? 300_000,
      credentialCustody: usesTargetDerivedService ? 'transient' : 'selected_service',
      ...(signal ? { signal } : {}),
      acquireCredential: async (authSignal) => {
        const result = await authenticateCliAccountService(
          { service, method, ...(key ? { key } : {}), signal: authSignal, timeoutMs },
          {
            request: async (path, init) => await fetch(endpointUrl(requestOrigin, path), init),
            write: announce,
          },
        );
        if (result.kind !== 'authenticated') throw Object.assign(new Error(result.kind), { outcome: result.kind });
        if (result.recoveryKey) {
          announce(`Account recovery key: ${formatRecoveryKey(result.recoveryKey)}`);
          announce('Store this recovery key somewhere safe. It is required to recover this Account.');
        }
        return result.credential;
      },
    });
    if (auth.kind !== 'authenticated') {
      if (auth.kind === 'timed_out') return { kind: 'timed_out' };
      if (auth.kind === 'cancelled') return { kind: 'cancelled' };
      const outcome = typeof auth.error === 'object' && auth.error !== null && 'outcome' in auth.error
        ? (auth.error as { outcome?: unknown }).outcome
        : null;
      if (outcome === 'key_required') return { kind: 'key_required' };
      if (outcome === 'update_required') return { kind: 'update_required' };
      if (outcome === 'account_service_unavailable') return { kind: 'account_service_unavailable' };
      if (outcome === 'identity_mismatch') return { kind: 'identity_mismatch' };
      if (outcome === 'destination_mismatch') return { kind: 'destination_mismatch' };
      return { kind: 'failed' };
    }
    return { kind: 'authenticated', target: service, credential: auth.credential };
  };

  if (input.stopAfter === 'sign_in' && 'method' in authenticationInput) {
    try {
      const signedIn = await authenticateExactMethod({
        service: { endpoint: service.endpoint, expectedServerIdentityId: service.serverIdentityId },
        method: authenticationInput.method,
        ...(authenticationInput.key ? { key: authenticationInput.key } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
      return signedIn.kind === 'authenticated' ? { kind: 'signed_in', endpoint: service.endpoint } : signedIn;
    } finally {
      progress.pause();
    }
  }

  return await runCliAccountServiceHomeEntry({
    service: { endpoint: service.endpoint, expectedServerIdentityId: service.serverIdentityId },
    ...authenticationInput,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  }, {
    authenticateExactMethod,
    runDirectoryJourney: async ({ credential, signal }) => {
      try {
        const directory = AccountDirectoryHomesResponseV1Schema.parse(await jsonRequest(
          endpointUrl(requestOrigin, ACCOUNT_DIRECTORY_HOMES_HTTP_PATH_V1),
          { headers: { Authorization: `Bearer ${credential.token}`, ...buildTerminalAuthorityCeilingHttpHeaders({ token: credential.token, serverHttpBaseUrl: requestOrigin }) }, signal },
        ));
        const completeCommittedHomeCredential = async (inputValue: Readonly<{
          runtimeOrigin: string;
          profileId: string;
          credential: CliHomeEnrollmentCredential;
          materialConflict: boolean;
          signal?: AbortSignal;
        }>): Promise<CliHomeEnrollmentCommit> => {
          let mode: Awaited<ReturnType<typeof readAccountEncryptionModeOnce>>;
          try {
            mode = await readAccountEncryptionModeOnce({
              request: async () => {
                const response = await fetch(endpointUrl(inputValue.runtimeOrigin, '/v1/account/encryption'), {
                  headers: { Authorization: `Bearer ${inputValue.credential.token}`, ...buildTerminalAuthorityCeilingHttpHeaders({ token: inputValue.credential.token, serverHttpBaseUrl: inputValue.runtimeOrigin }) },
                  signal: inputValue.signal,
                });
                return { status: response.status, data: await response.json().catch(() => null) };
              },
            });
          } catch (cause) {
            throw Object.assign(new Error('Home encryption mode unavailable', { cause }), { stage: 'material' });
          }
          if (mode.kind !== 'resolved') {
            throw Object.assign(new Error('Home encryption mode unavailable'), { stage: 'material' });
          }

          const committed = await readStoredCredentialsForServerId(inputValue.profileId);
          if (!committed || committed.token !== inputValue.credential.token) {
            throw new Error('Committed Home credential is unavailable');
          }
          const material = mode.mode === 'e2ee'
            ? hasUsableAccountSettingsEncryptionMaterial(committed)
              ? 'ready'
              : committed.encryption || inputValue.materialConflict
                ? 'invalid'
                : 'missing'
            : 'ready';
          const storedCredential = mode.mode === 'plain' && committed.encryption
            ? { token: committed.token, encryption: null } as const
            : committed;
          if (storedCredential !== committed) {
            await writeStoredCredentialsForServerId(inputValue.profileId, storedCredential);
          }
          if (material !== 'ready') {
            return { profileId: inputValue.profileId, material, machineRegistered: false };
          }
          try {
            await runWithServerProfileSelection(inputValue.profileId, async () => {
              await registerMachineWithAuthenticatedHomeRuntime({
                credentials: storedCredential,
                forceNew: true,
                runtimeOrigin: inputValue.runtimeOrigin,
              });
            });
            return { profileId: inputValue.profileId, material: 'ready', machineRegistered: true };
          } catch {
            return { profileId: inputValue.profileId, material: 'ready', machineRegistered: false };
          }
        };
        const retryCommittedHomeMaterial = async (inputValue: Readonly<{
          homeServerIdentityId: string;
          profileId: string;
          credential: CliHomeEnrollmentCredential;
          materialConflict: boolean;
        }>): Promise<CliHomeEnrollmentCommit> => {
          const target = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: inputValue.profileId });
          if (target.homeServerIdentityId !== inputValue.homeServerIdentityId || !target.descriptor) {
            throw new Error('Committed Home target identity is unavailable');
          }
          const acquired = await acquireTerminalAuthEnrollmentRuntime(
            target.descriptor,
            target.preferredTransport,
            signal,
          );
          if (!acquired.ok) throw acquired.error;
          try {
            const snapshot = await fetchServerFeaturesSnapshot({
              serverUrl: acquired.runtime.runtimeOrigin,
              token: inputValue.credential.token,
              signal,
            });
            verifyTerminalAuthEnrollmentRuntime({ target, runtime: acquired.runtime, snapshot });
            try {
              return await completeCommittedHomeCredential({
                runtimeOrigin: acquired.runtime.runtimeOrigin,
                profileId: inputValue.profileId,
                credential: inputValue.credential,
                materialConflict: inputValue.materialConflict,
                ...(signal ? { signal } : {}),
              });
            } catch (cause) {
              if (typeof cause !== 'object' || cause === null || !('stage' in cause) || cause.stage !== 'material') throw cause;
              throw Object.assign(new Error('Home encryption mode unavailable', { cause }), {
                stage: 'material',
                homeCredentialCommitted: true,
                profileId: inputValue.profileId,
                retryMaterial: async () => await retryCommittedHomeMaterial(inputValue),
              });
            }
          } finally {
            await acquired.close();
          }
        };
        const createEnrollmentAdapters = (
          operationSignal?: AbortSignal,
        ): CliHomeEnrollmentAdapters => ({
            createRequesterKeyPair: async () => {
              const pair = tweetnacl.box.keyPair();
              return { publicKeyBase64: encodeBase64(pair.publicKey), secretKey: pair.secretKey };
            },
            requestAssertion: async ({ homeServerIdentityId, clientBoxPublicKeyBase64 }) => HomeLoginAssertionResponseV1Schema.parse(await jsonRequest(
              endpointUrl(requestOrigin, buildAccountDirectoryHomeLoginAssertionHttpPathV1(homeServerIdentityId)),
              { method: 'POST', headers: { Authorization: `Bearer ${credential.token}`, ...buildTerminalAuthorityCeilingHttpHeaders({ token: credential.token, serverHttpBaseUrl: requestOrigin }), 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, homeServerIdentityId, clientBoxPublicKeyBase64 }), signal: operationSignal },
            )),
            openHomeTransport: async (home) => {
              const acquired = await acquireTerminalAuthEnrollmentRuntime(
                home.connectionDescriptor,
                undefined,
                operationSignal,
              );
              if (!acquired.ok) throw acquired.error;
              return { transport: acquired, authenticatedCredentialDestination: acquired.runtime.authenticatedCredentialDestination! };
            },
            observeHomeBeforeRedemption: async ({ transport, home }) => {
              const observed = await fetchServerFeaturesSnapshot({ serverUrl: transport.runtime.runtimeOrigin, signal: operationSignal });
              if (observed.status !== 'ready' || !observed.features.homeConnectionDescriptor) throw new Error('Home observation unavailable');
              return {
                homeServerIdentityId: observed.features.capabilities.serverIdentity.serverIdentityId!,
                connectionDescriptor: observed.features.homeConnectionDescriptor,
                provenance: observed.provenance ?? 'public',
              };
            },
            redeemAssertion: async ({ transport, assertion, approvalId }) => HomeLoginRedemptionResultV1Schema.parse(await jsonRequest(
              endpointUrl(transport.runtime.runtimeOrigin, HOME_LOGIN_HTTP_PATH_V1),
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 1, assertion, ...(approvalId ? { approvalId } : {}) }), signal: operationSignal },
            )),
            decodeHomeCredential: async ({ redemption, secretKey }) => {
              const opened = libsodiumDecryptForSecretKey(decodeBase64(redemption.sealedHomeTokenBase64Url, 'base64url'), secretKey);
              if (!opened) return null;
              try { return HomeLoginCredentialPayloadV1Schema.parse(JSON.parse(new TextDecoder().decode(opened))); } catch { return null; }
            },
            observeAuthenticatedHome: async ({ transport, credential }) => {
              const observed = await fetchServerFeaturesSnapshot({ serverUrl: transport.runtime.runtimeOrigin, token: credential.token, signal: operationSignal });
              if (observed.status !== 'ready' || !observed.features.homeConnectionDescriptor) throw new Error('Authenticated Home observation unavailable');
              return {
                homeServerIdentityId: observed.features.capabilities.serverIdentity.serverIdentityId!,
                connectionDescriptor: observed.features.homeConnectionDescriptor,
                provenance: observed.provenance ?? 'public',
              };
            },
            commitHomeCredential: async ({ transport, home, credential }) => {
              const profileId = profileIds.get(home.homeServerIdentityId);
              if (!profileId) throw new Error('Home profile was not adopted');
              const existing = await readStoredCredentialsForServerId(profileId);
              const existingMaterialMatchesAccount = existing?.encryption
                ? resolveAccountSettingsCachePath({ token: existing.token })
                  === resolveAccountSettingsCachePath({ token: credential.token })
                : false;
              const materialConflict = Boolean(existing?.encryption && !existingMaterialMatchesAccount);
              await writeStoredCredentialsForServerId(
                profileId,
                existingMaterialMatchesAccount && existing?.encryption
                  ? { token: credential.token, encryption: existing.encryption }
                  : { token: credential.token, encryption: null },
              );
              try {
                return await completeCommittedHomeCredential({
                  runtimeOrigin: transport.runtime.runtimeOrigin,
                  profileId,
                  credential,
                  materialConflict,
                  ...(operationSignal ? { signal: operationSignal } : {}),
                });
              } catch (cause) {
                if (typeof cause !== 'object' || cause === null || !('stage' in cause) || cause.stage !== 'material') throw cause;
                const retryInput = {
                  homeServerIdentityId: home.homeServerIdentityId,
                  profileId,
                  credential,
                  materialConflict,
                };
                throw Object.assign(new Error('Home encryption mode unavailable', { cause }), {
                  stage: 'material',
                  homeCredentialCommitted: true,
                  profileId,
                  retryMaterial: async () => await retryCommittedHomeMaterial(retryInput),
                });
              }
            },
            reconcileAuthenticatedHome: async ({ home, observation }) => {
              const profileId = profileIds.get(home.homeServerIdentityId);
              if (!profileId) throw new Error('Home profile was not adopted');
              const reconciliation = await adoptServerProfileHomeConnectionDescriptor({
                descriptor: observation.connectionDescriptor,
                expectedProfileId: profileId,
                observation: observation.provenance === 'authenticated' ? 'exact' : 'advisory',
              });
              if (observation.provenance === 'authenticated'
                && reconciliation.outcome !== 'updated'
                && reconciliation.outcome !== 'unchanged') {
                throw new Error(`Authenticated Home reconciliation was not applied: ${reconciliation.outcome}`);
              }
            },
            closeHomeTransport: async (transport) => await transport.close(),
          });
        const enrollmentAdapters = createEnrollmentAdapters(signal);
        const mapCommit = async (
          homeServerIdentityId: string,
          commit: CliHomeEnrollmentCommit,
          selection: 'explicit' | 'preferred' | 'sole',
          directoryAdoptionFailures: readonly Readonly<{ homeServerIdentityId: string; label: string }>[],
        ): Promise<CliAccountServiceDirectoryAttemptOutcome> => {
          if (commit.material !== 'ready') {
            return {
              kind: 'home_material_required',
              homeServerIdentityId,
              profileId: commit.profileId,
              reason: commit.material === 'invalid' ? 'invalid_material' : 'missing_material',
            };
          }
          if (!commit.machineRegistered) {
            return {
              kind: 'failure',
              stage: 'enter',
              homeServerIdentityId,
              profileId: commit.profileId,
              homeCredentialCommitted: true,
              recovery: 'retry_stage',
            };
          }
          return {
            kind: 'home_entered',
            homeServerIdentityId,
            profileId: commit.profileId,
            selection,
            ...(directoryAdoptionFailures.length > 0 ? { directoryAdoptionFailures } : {}),
          };
        };
        const mapCommittedMaterialFailure = (
          homeServerIdentityId: string,
          error: unknown,
          selection: 'explicit' | 'preferred' | 'sole',
          directoryAdoptionFailures: readonly Readonly<{ homeServerIdentityId: string; label: string }>[],
        ): Extract<CliAccountServiceHomeEntryOutcome, { kind: 'failure' }> | null => {
          const failure = readCommittedMaterialStageError(error);
          if (!failure) return null;
          return {
            kind: 'failure',
            stage: 'material',
            homeServerIdentityId,
            profileId: failure.profileId,
            homeCredentialCommitted: true,
            recovery: 'retry_stage',
            retry: async () => {
              let commit: CliHomeEnrollmentCommit;
              try {
                commit = await failure.retryMaterial();
              } catch (retryError) {
                return mapCommittedMaterialFailure(homeServerIdentityId, retryError, selection, directoryAdoptionFailures)
                  ?? { kind: 'home_unavailable' };
              }
              return await mapCommit(homeServerIdentityId, commit, selection, directoryAdoptionFailures);
            },
          };
        };
        const mapEnrollment = async (
          homeServerIdentityId: string,
          enrollment: AccountServiceHomeEnrollmentResult<Uint8Array, CliHomeEnrollmentCommit>,
          selection: 'explicit' | 'preferred' | 'sole',
          directoryAdoptionFailures: readonly Readonly<{ homeServerIdentityId: string; label: string }>[],
        ): Promise<CliAccountServiceDirectoryAttemptOutcome> => {
          if (enrollment.kind === 'enrolled') {
            return await mapCommit(homeServerIdentityId, enrollment.commit, selection, directoryAdoptionFailures);
          }
          if (enrollment.kind === 'approval_required') {
            const approval: AccountServiceHomeApproval<Uint8Array> = enrollment.approval;
            return {
              kind: 'awaiting_approval',
              homeServerIdentityId,
              expiresAtMs: approval.expiresAtMs,
              resume: async ({ signal: resumeSignal }) => await mapEnrollment(
                homeServerIdentityId,
                await observeAccountServiceHomeApproval({
                  approval,
                  adapters: createEnrollmentAdapters(resumeSignal),
                  nowMs: Date.now(),
                  shouldCancel: () => resumeSignal.aborted,
                }),
                selection,
                directoryAdoptionFailures,
              ),
            };
          }
          if (enrollment.kind === 'cancelled') return { kind: 'cancelled' };
          if (enrollment.kind === 'verification_failed') {
            const reason: string = enrollment.reason;
            if ('stage' in enrollment && enrollment.stage === 'post_redemption') {
              const retry = enrollment.retry;
              return {
                kind: 'failure',
                stage: 'enter',
                homeServerIdentityId,
                homeCredentialCommitted: false,
                recovery: 'retry_stage',
                ...(retry ? {
                  retry: async () => await mapEnrollment(
                    homeServerIdentityId,
                    await retry({
                      nowMs: Date.now(),
                      shouldCancel: () => signal?.aborted === true,
                    }),
                    selection,
                    directoryAdoptionFailures,
                  ),
                } : {}),
              };
            }
            return {
              kind: reason.includes('identity')
                ? 'identity_mismatch'
                : reason.includes('destination')
                  ? 'destination_mismatch'
                  : 'failed',
            };
          }
          if (enrollment.kind === 'unavailable') {
            const materialFailure = mapCommittedMaterialFailure(
              homeServerIdentityId,
              enrollment.error,
              selection,
              directoryAdoptionFailures,
            );
            if (materialFailure) return materialFailure;
          }
          return { kind: 'home_unavailable' };
        };
        const adoptDirectoryHome = async (home: AccountDirectoryHomeEntryV1) => {
          const adopted = await adoptServerProfileHomeConnectionDescriptor({
            descriptor: home.connectionDescriptor, suggestedName: home.label, observation: 'advisory',
          });
          profileIds.set(home.homeServerIdentityId, adopted.profile.id);
          homeLabels.set(home.homeServerIdentityId, home.label);
        };
        const mapJourney = async (
          journey: AccountServiceDirectoryJourneyResult<Uint8Array, CliHomeEnrollmentCommit>,
        ): Promise<CliAccountServiceDirectoryAttemptOutcome> => {
          const adoptionFailures = journey.adoption.failures.map(({ homeServerIdentityId, label }) => ({
            homeServerIdentityId,
            label,
          }));
          if (journey.kind === 'home_adoption_failed') {
            return {
              kind: 'failure',
              stage: 'refresh',
              homeServerIdentityId: journey.homeServerIdentityId,
              homeCredentialCommitted: false,
              recovery: 'retry_stage',
            };
          }
          if (journey.kind === 'home_enrolled' || journey.kind === 'home_awaiting_approval') {
            return await mapEnrollment(
              journey.homeServerIdentityId,
              journey.enrollment,
              journey.selection,
              adoptionFailures,
            );
          }
          if (journey.kind === 'no_linked_homes') {
            return {
              kind: 'account_connected_no_homes',
              // A dual-role service is a Home as well, so the no-Homes state can
              // offer that Home instead of dead-ending the journey.
              ...(discovery.serviceIsAlsoHome
                ? { availableHome: { canonicalServerUrl: service.canonicalServerUrl } }
                : {}),
            };
          }
          if (journey.kind === 'explicit_target_not_linked') {
            return { kind: 'explicit_target_not_linked', homeServerIdentityId: journey.homeServerIdentityId };
          }
          if (journey.kind === 'choose_home') {
            const promptInputFn = input.promptInputFn;
            if (!promptInputFn) {
              return {
                kind: 'choose_home',
                homes: journey.homes.map(({ homeServerIdentityId, label }) => ({ homeServerIdentityId, label })),
                ...(adoptionFailures.length > 0 ? { directoryAdoptionFailures: adoptionFailures } : {}),
              };
            }
            const selectedIdentity = await withoutProgress(async () => await promptMultipleChoice(
              [
                'Choose a Home',
                ...journey.homes.map((candidate, index) => (
                  `  ${index + 1}) ${candidate.label}${candidate.preferred ? ' · preferred' : ''}\n       ${candidate.canonicalServerUrl}`
                )),
                '  x) Cancel',
              ].join('\n'),
              [...journey.homes.map((candidate, index) => ({ id: candidate.homeServerIdentityId, keys: [String(index + 1)], short: String(index + 1) })), { id: 'cancel', keys: ['x', 'cancel'], short: 'x' }],
              { defaultId: 'cancel', maxAttempts: 3, promptInputFn },
            ));
            if (selectedIdentity === 'cancel') return { kind: 'cancelled' };
            // The chosen Home re-enters the shared journey as an explicit target, so its outcome is
            // mapped by exactly the branches below — including committed-material recovery.
            return await mapJourney(await runAccountServiceDirectoryJourney({
              directory,
              explicitHomeServerIdentityId: selectedIdentity,
              issuerServerIdentityId: service.serverIdentityId,
              shouldCancel: () => signal?.aborted === true,
              adoptHome: adoptDirectoryHome,
              enrollmentAdapters,
            }));
          }
          if (journey.kind === 'cancelled') return { kind: 'cancelled' };
          if (journey.kind === 'invalid_directory') return { kind: 'identity_mismatch' };
          if (!journey.homeServerIdentityId) return { kind: 'home_unavailable' };
          return await mapEnrollment(
            journey.homeServerIdentityId,
            journey.enrollment,
            journey.selection,
            adoptionFailures,
          );
        };
        return await mapJourney(await runAccountServiceDirectoryJourney({
          directory,
          ...(input.intent?.kind === 'enter' && input.intent.target.kind === 'explicit'
            ? { explicitHomeServerIdentityId: input.intent.target.homeServerIdentityId }
            : contextTarget?.homeServerIdentityId
              ? { explicitHomeServerIdentityId: contextTarget.homeServerIdentityId }
            : {}),
          issuerServerIdentityId: service.serverIdentityId,
          shouldCancel: () => signal?.aborted === true,
          adoptHome: adoptDirectoryHome,
          enrollmentAdapters,
        }));
      } catch {
        return { kind: 'account_service_unavailable' };
      }
    },
    openSelectedHome,
    reportApprovalWait: ({ homeServerIdentityId, expiresAtMs }) => {
      const home = homeLabels.get(homeServerIdentityId) ?? homeServerIdentityId;
      showStage(`Approve ${home} on your other signed-in device — this request expires at ${new Date(expiresAtMs).toLocaleTimeString()}`);
    },
    continueMachineAndService,
  }).finally(() => {
    progress.pause();
  });
  } finally {
    if (selfTransport) await selfTransport.close().catch(() => undefined);
  }
}
