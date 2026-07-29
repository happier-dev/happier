import {
  qualifiedPurposeKey,
  type QualifiedConnectedAccountPurposeBindingV1,
} from '@happier-dev/protocol';

import type {
  ConnectedAccountRequestAuthCapabilityDescriptor,
} from '@/daemon/connectedServices/requestAuth/capabilityFile';
import type {
  ConnectedAccountRequestAuthService,
  ConnectedAccountRequestAuthSubject,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import type {
  ConnectedAccountRequestAuthSubjectRegistry,
} from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import type {
  LocalServicesDaemonRuntime,
  TrustedManagedLocalServiceOwnedRun,
} from '@/daemon/local/services/runtime';
import type {
  ManagedLocalServiceRunAttachmentV1,
} from '@/daemon/sessionRegistry';
import type {
  ProviderSpawnAuthorizationAttempt,
} from '@/providers/spawn/authorize';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';

import {
  inspectManagedProviderRuntimeAdapterRecovery,
  verifyManagedProviderRuntimeRecoveryHealth,
  type ManagedProviderRuntimeRecoveryFacts,
} from './managedRuntimeAdapterRecovery';
import { managedPurposeBindingsMatchFacet } from './managedPurposeBindingAuthorization';
import { resolveManagedProviderRuntimeLaunch } from './resolveManagedProviderRuntimeLaunch';
import { verifyRetainedManagedProviderRuntimeArtifact } from './retainedManagedRuntimeArtifact';

type ManagedAttempt = Extract<
  ProviderSpawnAuthorizationAttempt,
  { deployment: { kind: 'managedLocal' } }
>;

type RecoveryLocalServices = Pick<
  LocalServicesDaemonRuntime['trustedManagedLocalServices'],
  | 'readOwnedRun'
  | 'reattachVerifiedRun'
  | 'finalizeReattachedAuthority'
  | 'registerOwnedCleanup'
  | 'transferOwned'
>;

export type ManagedProviderEndpointRecoveryFailureCode =
  | 'authorization_invalid'
  | 'runtime_inspection_failed'
  | 'runtime_declaration_invalid'
  | 'runtime_reattach_failed'
  | 'request_auth_activation_failed'
  | 'cleanup_registration_failed';

export type ManagedProviderEndpointRecoveryResult =
  | Readonly<{
      ok: true;
      run: TrustedManagedLocalServiceOwnedRun;
      capability: ConnectedAccountRequestAuthCapabilityDescriptor;
      facts: ManagedProviderRuntimeRecoveryFacts;
    }>
  | Readonly<{
      ok: false;
      code: ManagedProviderEndpointRecoveryFailureCode;
      detail?: string;
    }>;

function exactRun(
  expected: TrustedManagedLocalServiceOwnedRun,
  current: TrustedManagedLocalServiceOwnedRun | null,
): boolean {
  return current !== null
    && current.serviceKey === expected.serviceKey
    && current.runId === expected.runId
    && current.process.pid === expected.process.pid
    && current.process.processStartTimeMs
      === expected.process.processStartTimeMs
    && current.process.processCommandHash
      === expected.process.processCommandHash
    && current.host === expected.host
    && current.port === expected.port
    && current.snapshot.phase === 'running';
}

function validAuthorization(attempt: ManagedAttempt): boolean {
  const contribution = attempt.authorization.deployment.contribution;
  const implementation = attempt.authorization.deployment.implementation;
  const bindings = implementation.purposeBindings.bindings;
  return attempt.isAuthorizationCurrent()
    && contribution.provenance === 'first_party'
    && contribution.source.kind === 'bundled'
    && contribution.managed !== undefined
    && contribution.managedRuntimeAdapter !== undefined
    && implementation.implementationIdentity.pluginId
      === contribution.identity.pluginId
    && implementation.implementationIdentity.localId
      === contribution.identity.localId
    && JSON.stringify(implementation.facet)
      === JSON.stringify(contribution.managed)
    && contribution.managed.managedEndpoint.protocols.includes(
      attempt.authorization.binding.endpoint.protocol,
    )
    && managedPurposeBindingsMatchFacet({
      identity: contribution.identity,
      facet: contribution.managed,
      bindings,
    });
}

function exactFacts(
  left: ManagedProviderRuntimeRecoveryFacts,
  right: ManagedProviderRuntimeRecoveryFacts | null,
): boolean {
  return right !== null && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Reconstructs daemon-local authority around one surviving managed Provider
 * endpoint. It never spawns, restarts, prompts, replays, or performs Provider
 * work. Proof failure leaves the process and marker intact while request-auth
 * remains unavailable, so a later passive startup can retry from the same
 * evidence.
 */
export async function recoverManagedProviderEndpoint(input: Readonly<{
  sessionId: string;
  attachment: ManagedLocalServiceRunAttachmentV1;
  attempt: ManagedAttempt;
  requestAuthHttpPort: number;
  processEnv?: NodeJS.ProcessEnv;
  localServices: RecoveryLocalServices;
  requestAuthRegistry: Pick<
    ConnectedAccountRequestAuthSubjectRegistry,
    'activate' | 'retire'
  >;
  validateRequestAuth:
    ConnectedAccountRequestAuthService['validateRequestAuth'];
  clearMarkerAttachment: () => Promise<void>;
  cleanupMaterialization: () => Promise<void>;
  cleanupAuthorization?: () => void | Promise<void>;
}>, dependencies: Readonly<{
  inspectRecovery?: typeof inspectManagedProviderRuntimeAdapterRecovery;
  resolveRuntimeLaunch?: typeof resolveManagedProviderRuntimeLaunch;
  verifyArtifact?: typeof verifyRetainedManagedProviderRuntimeArtifact;
  verifyHealth?: typeof verifyManagedProviderRuntimeRecoveryHealth;
}> = {}): Promise<ManagedProviderEndpointRecoveryResult> {
  const authorization = input.attempt.authorization;
  const cleanupAuthorization = input.cleanupAuthorization
    ?? input.attempt.cleanupOnFailure;
  if (!validAuthorization(input.attempt)) {
    await cleanupAuthorization();
    return { ok: false, code: 'authorization_invalid' };
  }
  if (
    !Number.isSafeInteger(input.requestAuthHttpPort)
    || input.requestAuthHttpPort < 1
    || input.requestAuthHttpPort > 65_535
  ) {
    await cleanupAuthorization();
    return { ok: false, code: 'authorization_invalid' };
  }

  const contribution = authorization.deployment.contribution;
  const facet = contribution.managed!;
  const runtimeAdapter = contribution.managedRuntimeAdapter!;
  const bindings = authorization.deployment.implementation
    .purposeBindings.bindings;
  const purposes = bindings.map((binding) => binding.purpose);
  const protocols = [authorization.binding.endpoint.protocol];
  const inspect = async () => (
    await (
      dependencies.inspectRecovery
        ?? inspectManagedProviderRuntimeAdapterRecovery
    )({
      runtimeAdapter,
      attachment: input.attachment,
      purposes,
      protocols,
      modelListEnabled: false,
    })
  );
  const facts = await inspect();
  if (!facts) {
    await cleanupAuthorization();
    return { ok: false, code: 'runtime_inspection_failed' };
  }
  const declaration = await (
    dependencies.resolveRuntimeLaunch ?? resolveManagedProviderRuntimeLaunch
  )(
    facet.managedEndpoint.localService,
    facts,
  );
  if (!declaration) {
    await cleanupAuthorization();
    return { ok: false, code: 'runtime_declaration_invalid' };
  }
  const context = Object.freeze({
    pluginId: contribution.identity.pluginId,
    contributionId: contribution.identity.localId,
    sessionId: input.sessionId,
    title: contribution.definition.name,
  });
  const reattached = await input.localServices.reattachVerifiedRun({
    context,
    declaration,
    attachment: input.attachment,
    verifyMaterialization: async () => (
      input.attempt.isAuthorizationCurrent()
      && exactFacts(facts, await inspect())
    ),
    verifyExecutableArtifact: async ({ observedExecutablePath }) => (
      await (
        dependencies.verifyArtifact
          ?? verifyRetainedManagedProviderRuntimeArtifact
      )({
        wrapperBuildVersion: facts.expectedHealth.wrapperBuildVersion,
        observedExecutablePath,
        declaration: facet.managedEndpoint.localService,
        processEnv: input.processEnv,
      })
    ),
    verifyReadiness: async () => (
      input.attempt.isAuthorizationCurrent()
      && await (
        dependencies.verifyHealth
          ?? verifyManagedProviderRuntimeRecoveryHealth
      )({
        runtimeAdapter,
        facts,
        host: input.attachment.endpoint.host,
        port: input.attachment.endpoint.port,
        path: declaration.healthCheck.kind === 'http'
          ? declaration.healthCheck.path ?? '/'
          : '/',
      })
    ),
  });
  if (!reattached.ok) {
    await cleanupAuthorization();
    return {
      ok: false,
      code: 'runtime_reattach_failed',
      detail: reattached.reasonCode,
    };
  }

  const run = reattached.ownedRun;
  const redactionLease = createProviderRedactionLease({ values: [] });
  let subjectCurrent = true;
  const bindingByPurposeKey = new Map(
    bindings.map((binding) => [
      qualifiedPurposeKey(binding.purpose),
      binding,
    ]),
  );
  const requestAuthUseByPurpose = new Map(
    facet.requestAuthUses.map((use) => [use.purpose, use]),
  );
  const isCurrent = (): boolean => (
    subjectCurrent
    && input.attempt.isAuthorizationCurrent()
    && exactRun(
      run,
      input.localServices.readOwnedRun({
        context,
        serviceId: declaration.id,
      }),
    )
  );
  const subject: ConnectedAccountRequestAuthSubject = Object.freeze({
    subjectId: JSON.stringify([
      'managed-provider-recovery',
      authorization.ticket.connectionId,
      input.sessionId,
      run.runId,
    ]),
    isCurrent,
    registerRedaction: (values) => {
      if (!isCurrent()) {
        throw new Error('managed_provider_request_auth_not_active');
      }
      redactionLease.add(values);
    },
    resolvePurposeUse: (purpose) => {
      if (!isCurrent()) return null;
      const binding = bindingByPurposeKey.get(qualifiedPurposeKey(purpose));
      const use = requestAuthUseByPurpose.get(purpose.purpose);
      return binding && use
        ? Object.freeze({
            binding,
            use: Object.freeze({
              purpose: binding.purpose,
              materialization: use.materialization,
            }),
          })
        : null;
    },
    listPurposeUses: () => (
      isCurrent()
        ? bindings.flatMap((binding) => {
            const use = requestAuthUseByPurpose.get(binding.purpose.purpose);
            return use
              ? [Object.freeze({
                  binding,
                  use: Object.freeze({
                    purpose: binding.purpose,
                    materialization: use.materialization,
                  }),
                })]
              : [];
          })
        : []
    ),
  });
  let capability: ConnectedAccountRequestAuthCapabilityDescriptor | null = null;
  const failAfterReattach = async (
    code: ManagedProviderEndpointRecoveryFailureCode,
  ): Promise<ManagedProviderEndpointRecoveryResult> => {
    subjectCurrent = false;
    redactionLease.close();
    // A published capability file is also passive-recovery evidence.
    // `subjectCurrent = false` makes this daemon reject it, while a later
    // daemon can inspect and atomically rotate it.
    await input.localServices.transferOwned(run).catch(() => undefined);
    await cleanupAuthorization();
    return { ok: false, code };
  };

  const cleanupCapability = async (): Promise<void> => {
    subjectCurrent = false;
    try {
      if (capability) {
        await input.requestAuthRegistry.retire(capability);
      }
    } finally {
      redactionLease.close();
    }
  };
  const registered = [
    input.localServices.registerOwnedCleanup(
      run,
      cleanupCapability,
      { phase: 'beforeProcessStop' },
    ),
    input.localServices.registerOwnedCleanup(
      run,
      input.clearMarkerAttachment,
    ),
    input.localServices.registerOwnedCleanup(
      run,
      input.cleanupMaterialization,
    ),
    input.localServices.registerOwnedCleanup(
      run,
      cleanupAuthorization,
    ),
  ];
  if (registered.some((value) => !value) || !isCurrent()) {
    return await failAfterReattach('cleanup_registration_failed');
  }

  // Request-auth activation is the final authority commit. Every process,
  // cleanup, marker, materialization, and authorization control above is
  // already owned before the replacement daemon can authenticate a request.
  try {
    for (const binding of bindings) {
      input.validateRequestAuth({
        subject,
        purpose: binding.purpose,
      });
    }
    capability = await input.requestAuthRegistry.activate({
      subject,
      materializedRootDir: facts.materializedRootDir,
      materializationId: facts.materializationId,
      httpPort: input.requestAuthHttpPort,
      finalizeStagedAuthorityCommit: async (
        stagedCapability,
        commit,
      ) => {
        capability = stagedCapability;
        const finalized =
          await input.localServices.finalizeReattachedAuthority(run, commit);
        if (!finalized.ok || !isCurrent()) {
          throw new Error(
            `managed_provider_final_authority_proof_failed:${
              finalized.ok ? 'owner_not_current' : finalized.reasonCode
            }`,
          );
        }
      },
    });
  } catch {
    return await failAfterReattach('request_auth_activation_failed');
  }
  return Object.freeze({
    ok: true,
    run,
    capability,
    facts,
  });
}
