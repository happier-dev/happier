import {
  qualifiedPurposeKey,
  type ProviderWireProtocol,
  type QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';
import type {
  ExecOutputTeeV1,
  ExecRuntimeServiceV1,
  LocalServiceDeclarationV1,
} from '@/plugins/runtime/exec/privateContract';

import type {
  ConnectedAccountRequestAuthSubject,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import type {
  LocalServicesDaemonRuntime,
  TrustedManagedLocalServiceOwnerContext,
  TrustedManagedLocalServiceOwnedRun,
} from '@/daemon/local/services/runtime';
import type {
  ManagedLocalServiceRunAttachmentV1,
} from '@/daemon/sessionRegistry';
import type { ResolvedProviderContribution } from '@/plugins/projection/registry/types';
import type { ResolvedFirstPartyManagedProviderFacet } from '@/providers/managed/types';
import type { ProviderSpawnAuthorizationAttempt } from '@/providers/spawn/authorize';

import type {
  ProviderLaunchCleanup,
  ProviderLaunchResourceScope,
} from './resourceScope';
import { managedPurposeBindingsMatchFacet } from './managedPurposeBindingAuthorization';
import { resolveManagedProviderRuntimeLaunch } from './resolveManagedProviderRuntimeLaunch';

export type ManagedProviderEndpointLaunchFailureCode =
  | 'managed_provider_execution_denied'
  | 'managed_provider_runtime_preparation_failed'
  | 'managed_provider_runtime_unavailable'
  | 'managed_provider_start_failed'
  | 'managed_provider_run_invalid'
  | 'managed_provider_readiness_invalid'
  | 'managed_provider_activation_failed'
  | 'managed_provider_materialization_failed';

export type ManagedProviderEndpointLaunchFailure = Readonly<{
  ok: false;
  code: ManagedProviderEndpointLaunchFailureCode;
}>;

export type ManagedProviderEndpointReadiness = Readonly<{
  contractVersion: string;
  sdkVersion: string;
  protocols: readonly ProviderWireProtocol[];
  purposes: readonly QualifiedConnectedAccountPurposeBindingV1['purpose'][];
}>;

export type ManagedProviderRuntimePreparation<TPrepared = unknown> = Readonly<{
  materializedRootDir: string;
  materializationId: string;
  privateConfigPath: string;
  outputTee?: ExecOutputTeeV1;
  expectedReadiness: Readonly<{
    contractVersion: string;
    sdkVersion: string;
  }>;
  prepared: TPrepared;
  cleanup: ProviderLaunchCleanup;
}>;

export type ManagedProviderEndpointLaunchResult<TMaterialization> =
  | Readonly<{
      ok: true;
      materialization: TMaterialization;
      run: TrustedManagedLocalServiceOwnedRun;
      runAttachment: ManagedLocalServiceRunAttachmentV1;
      isCurrent: () => boolean;
      /**
       * Creates the wrapper's broker capability only after the caller has established the
       * canonical session lease and supplied its managed-purpose scoped view.
       */
      activateRequestAuth(
        subject: ConnectedAccountRequestAuthSubject,
      ): Promise<void>;
    }>
  | ManagedProviderEndpointLaunchFailure;

type TrustedManagedLocalServices = Pick<
  LocalServicesDaemonRuntime['trustedManagedLocalServices'],
  'startOwned' | 'readOwnedRun' | 'registerOwnedCleanup' | 'stopOwned'
>;

type ManagedProviderSpawnAuthorizationAttempt = Extract<
  ProviderSpawnAuthorizationAttempt,
  { deployment: { kind: 'managedLocal' } }
>;

function bindingKey(binding: QualifiedConnectedAccountPurposeBindingV1): string {
  const target = binding.target.kind === 'account'
    ? [
        'account',
        binding.target.account.service.pluginId,
        binding.target.account.service.localId,
        binding.target.account.accountId,
      ]
    : [
        'group',
        binding.target.service.pluginId,
        binding.target.service.localId,
        binding.target.groupId,
      ];
  return JSON.stringify([qualifiedPurposeKey(binding.purpose), ...target]);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  if (leftSet.size !== left.length || rightSet.size !== right.length) return false;
  return [...leftSet].every((value) => rightSet.has(value));
}

function exactOnceCleanup(cleanup: ProviderLaunchCleanup): ProviderLaunchCleanup {
  let promise: Promise<void> | null = null;
  return async () => {
    promise ??= Promise.resolve().then(async () => {
      await cleanup();
    });
    await promise;
  };
}

function exactBindingSet(
  left: readonly QualifiedConnectedAccountPurposeBindingV1[],
  right: readonly QualifiedConnectedAccountPurposeBindingV1[],
): boolean {
  return sameStringSet(left.map(bindingKey), right.map(bindingKey));
}

function isAuthorizedPurposeSnapshot(input: Readonly<{
  contribution: Extract<ResolvedProviderContribution, { provenance: 'first_party' }>;
  facet: ResolvedFirstPartyManagedProviderFacet;
  bindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
  requestAuth: Pick<
    ConnectedAccountRequestAuthSubject,
    'resolvePurposeUse' | 'listPurposeUses'
  >;
}>): boolean {
  if (
    !managedPurposeBindingsMatchFacet({
      identity: input.contribution.identity,
      facet: input.facet,
      bindings: input.bindings,
    })
    || !exactBindingSet(
      input.bindings,
      input.requestAuth.listPurposeUses().map((purposeUse) => purposeUse.binding),
    )
  ) {
    return false;
  }
  for (const binding of input.bindings) {
    const resolved = input.requestAuth.resolvePurposeUse(binding.purpose);
    if (!resolved || bindingKey(resolved.binding) !== bindingKey(binding)) return false;
  }
  return true;
}

function exactOwnedRun(
  left: TrustedManagedLocalServiceOwnedRun,
  right: TrustedManagedLocalServiceOwnedRun | null,
): boolean {
  return right !== null
    && right.serviceKey === left.serviceKey
    && right.runId === left.runId
    && right.process.pid === left.process.pid
    && right.process.startedAt === left.process.startedAt
    && right.host === left.host
    && right.port === left.port
    && right.snapshot.phase === 'running';
}

function isAttachmentLoopbackHost(
  host: TrustedManagedLocalServiceOwnedRun['host'],
): host is ManagedLocalServiceRunAttachmentV1['endpoint']['host'] {
  return host === '127.0.0.1' || host === '::1';
}

function validOwnedRun(run: TrustedManagedLocalServiceOwnedRun): boolean {
  return run.snapshot.phase === 'running'
    && isAttachmentLoopbackHost(run.host)
    && Number.isInteger(run.port)
    && (run.port ?? 0) >= 1
    && (run.port ?? 0) <= 65_535
    && run.snapshot.port === run.port
    && Number.isInteger(run.process.pid)
    && run.process.pid > 0
    && Number.isInteger(run.runId)
    && run.runId > 0
    && Number.isInteger(run.process.processStartTimeMs)
    && (run.process.processStartTimeMs ?? -1) >= 0
    && typeof run.process.processCommandHash === 'string'
    && /^[a-f0-9]{64}$/u.test(run.process.processCommandHash);
}

function readinessMatches(input: Readonly<{
  readiness: ManagedProviderEndpointReadiness;
  preparation: ManagedProviderRuntimePreparation;
  protocols: readonly ProviderWireProtocol[];
  purposes: readonly QualifiedConnectedAccountPurposeBindingV1['purpose'][];
}>): boolean {
  const expected = input.preparation.expectedReadiness;
  return input.readiness.contractVersion === expected.contractVersion
    && input.readiness.sdkVersion === expected.sdkVersion
    && sameStringSet(input.readiness.protocols, input.protocols)
    && sameStringSet(
      input.readiness.purposes.map(qualifiedPurposeKey),
      input.purposes.map(qualifiedPurposeKey),
    );
}

export type AuthorizedManagedProviderRuntimeStartResult<TPrepared> =
  | Readonly<{
      ok: true;
      preparation: ManagedProviderRuntimePreparation<TPrepared>;
      run: TrustedManagedLocalServiceOwnedRun;
      isCurrent: () => boolean;
    }>
  | ManagedProviderEndpointLaunchFailure;

/**
 * One post-logical-authorization owner for managed Provider preparation,
 * packaged-asset resolution, SVC09 run ownership, readiness, and exact
 * cleanup. Session launches and bounded catalog probes compose their
 * distinct authority above this primitive; it never creates broker authority.
 */
export async function startAuthorizedManagedProviderRuntime<TPrepared>(
  input: Readonly<{
    context: TrustedManagedLocalServiceOwnerContext;
    declaration: ResolvedFirstPartyManagedProviderFacet['managedEndpoint']['localService'];
    protocols: readonly ProviderWireProtocol[];
    purposes: readonly QualifiedConnectedAccountPurposeBindingV1['purpose'][];
    managedLocalServicesEnabled: boolean;
    isAuthorizationCurrent: () => boolean;
    revalidateBeforeEffect: () => Promise<boolean>;
    localServices: TrustedManagedLocalServices;
    exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
    launchResourceScope: ProviderLaunchResourceScope;
  }>,
  dependencies: Readonly<{
    prepareRuntime: () => Promise<ManagedProviderRuntimePreparation<TPrepared>>;
    resolveRuntimeLaunch?: (
      declaration: ResolvedFirstPartyManagedProviderFacet['managedEndpoint']['localService'],
      preparation: ManagedProviderRuntimePreparation<TPrepared>,
    ) => Promise<LocalServiceDeclarationV1 | null>;
    validateReadiness: (input: Readonly<{
      preparation: ManagedProviderRuntimePreparation<TPrepared>;
      run: TrustedManagedLocalServiceOwnedRun;
      signal: AbortSignal;
    }>) => Promise<ManagedProviderEndpointReadiness>;
    readinessTimeoutMs?: number;
  }>,
): Promise<AuthorizedManagedProviderRuntimeStartResult<TPrepared>> {
  if (!input.managedLocalServicesEnabled || !input.isAuthorizationCurrent()) {
    return { ok: false, code: 'managed_provider_execution_denied' };
  }
  let effectAuthorized = false;
  try {
    effectAuthorized = await input.revalidateBeforeEffect();
  } catch {
    effectAuthorized = false;
  }
  if (!effectAuthorized || !input.isAuthorizationCurrent()) {
    return { ok: false, code: 'managed_provider_execution_denied' };
  }

  let preparation: ManagedProviderRuntimePreparation<TPrepared>;
  try {
    preparation = await dependencies.prepareRuntime();
  } catch {
    return { ok: false, code: 'managed_provider_runtime_preparation_failed' };
  }
  const preparationCleanup = exactOnceCleanup(preparation.cleanup);
  let preparationCleanupOwnedByRun = false;
  input.launchResourceScope.register(async () => {
    if (!preparationCleanupOwnedByRun) {
      await preparationCleanup();
    }
  });

  let declaration: LocalServiceDeclarationV1 | null;
  try {
    declaration = await (
      dependencies.resolveRuntimeLaunch ?? resolveManagedProviderRuntimeLaunch
    )(input.declaration, preparation);
  } catch {
    return { ok: false, code: 'managed_provider_runtime_unavailable' };
  }
  if (!declaration) {
    return { ok: false, code: 'managed_provider_runtime_unavailable' };
  }

  let run: TrustedManagedLocalServiceOwnedRun | null;
  try {
    const managedExec: Pick<ExecRuntimeServiceV1, 'spawn'> = preparation.outputTee
      ? {
          spawn: (launch, options) => input.exec.spawn(launch, {
            ...options,
            outputTee: preparation.outputTee,
          }),
        }
      : input.exec;
    run = await input.localServices.startOwned({
      context: input.context,
      declaration,
      exec: managedExec,
    });
  } catch {
    return { ok: false, code: 'managed_provider_start_failed' };
  }
  if (!run) return { ok: false, code: 'managed_provider_start_failed' };

  input.launchResourceScope.register(async () => {
    const result = await input.localServices.stopOwned(run);
    if (result.status !== 'stopped') {
      throw new Error(`managed_provider_stop_${result.status}`);
    }
  });
  if (!input.localServices.registerOwnedCleanup(run, preparationCleanup)) {
    return { ok: false, code: 'managed_provider_run_invalid' };
  }
  preparationCleanupOwnedByRun = true;
  const isCurrent = (): boolean => (
    input.isAuthorizationCurrent()
    && exactOwnedRun(
      run,
      input.localServices.readOwnedRun({
        context: input.context,
        serviceId: declaration.id,
      }),
    )
  );
  if (!validOwnedRun(run) || !isCurrent()) {
    return { ok: false, code: 'managed_provider_run_invalid' };
  }

  let readiness: ManagedProviderEndpointReadiness;
  const readinessAbortController = new AbortController();
  input.launchResourceScope.register(() => readinessAbortController.abort());
  const readinessTimeout = setTimeout(
    () => readinessAbortController.abort(),
    Math.max(1, dependencies.readinessTimeoutMs ?? 30_000),
  );
  readinessTimeout.unref?.();
  try {
    readiness = await dependencies.validateReadiness({
      preparation,
      run,
      signal: readinessAbortController.signal,
    });
  } catch {
    return { ok: false, code: 'managed_provider_readiness_invalid' };
  } finally {
    clearTimeout(readinessTimeout);
  }
  if (
    !isCurrent()
    || !readinessMatches({
      readiness,
      preparation,
      protocols: input.protocols,
      purposes: input.purposes,
    })
  ) {
    return { ok: false, code: 'managed_provider_readiness_invalid' };
  }

  return Object.freeze({
    ok: true,
    preparation,
    run,
    isCurrent,
  });
}

export async function prepareManagedProviderEndpointLaunch<
  TPrepared,
  TCapability,
  TMaterialization,
>(input: Readonly<{
  context: TrustedManagedLocalServiceOwnerContext;
  authorizationAttempt: ManagedProviderSpawnAuthorizationAttempt;
  managedLocalServicesEnabled: boolean;
  requestAuthHttpPort: number;
  purposeBindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
  requestAuth: Pick<
    ConnectedAccountRequestAuthSubject,
    'resolvePurposeUse' | 'listPurposeUses'
  >;
  /** Known-session mode only: activate this canonical scoped subject before Agent materialization. */
  requestAuthSubject?: ConnectedAccountRequestAuthSubject;
  localServices: TrustedManagedLocalServices;
  exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
  launchResourceScope: ProviderLaunchResourceScope;
}>, dependencies: Readonly<{
  prepareRuntime: (input: Readonly<{
    context: TrustedManagedLocalServiceOwnerContext;
    facet: ResolvedFirstPartyManagedProviderFacet;
    purposeBindings: readonly QualifiedConnectedAccountPurposeBindingV1[];
  }>) => Promise<ManagedProviderRuntimePreparation<TPrepared>>;
  resolveRuntimeLaunch?: (
    declaration: ResolvedFirstPartyManagedProviderFacet['managedEndpoint']['localService'],
    preparation: ManagedProviderRuntimePreparation<TPrepared>,
  ) => Promise<LocalServiceDeclarationV1 | null>;
  validateReadiness: (input: Readonly<{
    preparation: ManagedProviderRuntimePreparation<TPrepared>;
    run: TrustedManagedLocalServiceOwnedRun;
    signal: AbortSignal;
  }>) => Promise<ManagedProviderEndpointReadiness>;
  readinessTimeoutMs?: number;
  validateRequestAuth: (input: Readonly<{
    subject: ConnectedAccountRequestAuthSubject;
    purpose: QualifiedConnectedAccountPurposeBindingV1['purpose'];
  }>) => void;
  activateRequestAuth: (input: Readonly<{
    subject: ConnectedAccountRequestAuthSubject;
    materializedRootDir: string;
    materializationId: string;
    httpPort: number;
  }>) => Promise<TCapability>;
  retireRequestAuth: (capability: TCapability) => Promise<void>;
  materializeAgentBinding: (input: Readonly<{
    preparation: ManagedProviderRuntimePreparation<TPrepared>;
    run: TrustedManagedLocalServiceOwnedRun;
  }>) => Promise<Readonly<{
    materialization: TMaterialization;
    cleanup: ProviderLaunchCleanup;
  }>>;
}>): Promise<ManagedProviderEndpointLaunchResult<TMaterialization>> {
  const attempt = input.authorizationAttempt;
  const contribution = attempt.authorization.deployment.contribution;
  const deployment = attempt.authorization.deployment.implementation;
  const ownerScopeId = typeof input.context.sessionId === 'string'
    ? input.context.sessionId.trim()
    : input.context.operationId.trim();
  if (
    !input.managedLocalServicesEnabled
    || !attempt.isAuthorizationCurrent()
    || !Number.isSafeInteger(input.requestAuthHttpPort)
    || input.requestAuthHttpPort < 1
    || input.requestAuthHttpPort > 65_535
    || contribution.provenance !== 'first_party'
    || contribution.source.kind !== 'bundled'
    || !contribution.managed
    || deployment.implementationIdentity.pluginId !== contribution.identity.pluginId
    || deployment.implementationIdentity.localId !== contribution.identity.localId
    || input.context.pluginId !== contribution.identity.pluginId
    || input.context.contributionId !== contribution.identity.localId
    || !ownerScopeId
    || JSON.stringify(deployment.facet) !== JSON.stringify(contribution.managed)
    || !deployment.facet.managedEndpoint.protocols.includes(
      attempt.authorization.binding.endpoint.protocol,
    )
    || !exactBindingSet(
      deployment.purposeBindings.bindings,
      input.purposeBindings,
    )
    || !isAuthorizedPurposeSnapshot({
      contribution,
      facet: contribution.managed,
      bindings: input.purposeBindings,
      requestAuth: input.requestAuth,
    })
  ) {
    return { ok: false, code: 'managed_provider_execution_denied' };
  }
  const facet = contribution.managed;
  const preLaunchSubject: ConnectedAccountRequestAuthSubject = Object.freeze({
    subjectId:
      `managed-provider-prelaunch-validation:${attempt.authorization.ticket.connectionId}`,
    isCurrent: attempt.isAuthorizationCurrent,
    registerRedaction: () => {
      throw new Error('managed_provider_request_auth_not_active');
    },
    resolvePurposeUse: input.requestAuth.resolvePurposeUse,
    listPurposeUses: input.requestAuth.listPurposeUses,
  });
  const context = input.context;
  const started = await startAuthorizedManagedProviderRuntime({
    context,
    declaration: facet.managedEndpoint.localService,
    protocols: [attempt.authorization.binding.endpoint.protocol],
    purposes: input.purposeBindings.map((binding) => binding.purpose),
    managedLocalServicesEnabled: input.managedLocalServicesEnabled,
    isAuthorizationCurrent: attempt.isAuthorizationCurrent,
    revalidateBeforeEffect: async () => {
      if (!(await attempt.revalidateBeforeEffect()).ok) return false;
      try {
        for (const binding of input.purposeBindings) {
          dependencies.validateRequestAuth({
            subject: preLaunchSubject,
            purpose: binding.purpose,
          });
        }
      } catch {
        return false;
      }
      return attempt.isAuthorizationCurrent();
    },
    localServices: input.localServices,
    exec: input.exec,
    launchResourceScope: input.launchResourceScope,
  }, {
    prepareRuntime: async () => await dependencies.prepareRuntime({
      context,
      facet,
      purposeBindings: input.purposeBindings,
    }),
    ...(dependencies.resolveRuntimeLaunch
      ? { resolveRuntimeLaunch: dependencies.resolveRuntimeLaunch }
      : {}),
    validateReadiness: dependencies.validateReadiness,
    ...(dependencies.readinessTimeoutMs === undefined
      ? {}
      : { readinessTimeoutMs: dependencies.readinessTimeoutMs }),
  });
  if (!started.ok) return started;
  const { preparation, run, isCurrent } = started;
  if (
    run.process.processStartTimeMs === undefined
    || run.process.processCommandHash === undefined
    || !isAttachmentLoopbackHost(run.host)
    || run.port === null
  ) {
    return { ok: false, code: 'managed_provider_run_invalid' };
  }
  const runAttachment: ManagedLocalServiceRunAttachmentV1 = Object.freeze({
    v: 1,
    process: Object.freeze({
      pid: run.process.pid,
      processStartTimeMs: run.process.processStartTimeMs,
      processCommandHash: run.process.processCommandHash,
    }),
    endpoint: Object.freeze({
      host: run.host,
      port: run.port,
    }),
    materialization: Object.freeze({
      rootDir: preparation.materializedRootDir,
      materializationId: preparation.materializationId,
    }),
  });

  let activationPromise: Promise<void> | null = null;
  const activateRequestAuth = (
    subject: ConnectedAccountRequestAuthSubject,
  ): Promise<void> => {
    activationPromise ??= (async () => {
      const isSubjectCurrent = (): boolean => (
        isCurrent() && subject.isCurrent()
      );
      const managedSubject: ConnectedAccountRequestAuthSubject = Object.freeze({
        subjectId: `${subject.subjectId}/run:${run.runId}`,
        isCurrent: isSubjectCurrent,
        registerRedaction: (values) => {
          if (!isSubjectCurrent()) {
            throw new Error('managed_provider_request_auth_not_active');
          }
          subject.registerRedaction(values);
        },
        resolvePurposeUse: (purpose) => (
          isSubjectCurrent() ? subject.resolvePurposeUse(purpose) : null
        ),
        listPurposeUses: () => (
          isSubjectCurrent() ? subject.listPurposeUses() : Object.freeze([])
        ),
      });
      if (
        !isSubjectCurrent()
        || !isAuthorizedPurposeSnapshot({
          contribution,
          facet,
          bindings: input.purposeBindings,
          requestAuth: managedSubject,
        })
      ) {
        throw new Error('managed_provider_activation_failed');
      }
      for (const binding of input.purposeBindings) {
        dependencies.validateRequestAuth({
          subject: managedSubject,
          purpose: binding.purpose,
        });
      }
      const capability = await dependencies.activateRequestAuth({
        subject: managedSubject,
        materializedRootDir: preparation.materializedRootDir,
        materializationId: preparation.materializationId,
        httpPort: input.requestAuthHttpPort,
      });
      const retireCapability = exactOnceCleanup(async () => {
        await dependencies.retireRequestAuth(capability);
      });
      if (!input.localServices.registerOwnedCleanup(run, retireCapability, {
        phase: 'beforeProcessStop',
      })) {
        await retireCapability();
        throw new Error('managed_provider_activation_failed');
      }
      if (!isSubjectCurrent()) {
        await retireCapability();
        throw new Error('managed_provider_activation_failed');
      }
    })();
    return activationPromise;
  };
  if (input.requestAuthSubject) {
    try {
      await activateRequestAuth(input.requestAuthSubject);
    } catch {
      return { ok: false, code: 'managed_provider_activation_failed' };
    }
  }

  let materialized: Readonly<{
    materialization: TMaterialization;
    cleanup: ProviderLaunchCleanup;
  }>;
  try {
    materialized = await dependencies.materializeAgentBinding({
      preparation,
      run,
    });
  } catch {
    return { ok: false, code: 'managed_provider_materialization_failed' };
  }
  const cleanupMaterialization = exactOnceCleanup(materialized.cleanup);
  if (!input.localServices.registerOwnedCleanup(run, cleanupMaterialization)) {
    await cleanupMaterialization();
    return { ok: false, code: 'managed_provider_run_invalid' };
  }
  if (!isCurrent()) return { ok: false, code: 'managed_provider_run_invalid' };
  return Object.freeze({
    ok: true,
    materialization: materialized.materialization,
    run,
    runAttachment,
    isCurrent,
    activateRequestAuth,
  });
}
