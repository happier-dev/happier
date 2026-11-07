import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { captureConnectedAccountInvocationPurposeBinding, type ConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { QualifiedConnectedAccountRequestAuthUseV1Schema } from '@happier-dev/protocol/connect/connected-account-request-auth';
import type { PluginContributionIdentityV1, QualifiedConnectedAccountRequestAuthUseV1 } from '@happier-dev/protocol';

import type {
  ManagedProviderRequestAuthCapabilityPathBinding,
} from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { ensurePrivateConnectedServiceMaterializedRoot } from '../materialize/privateMaterializedRoot';
import type {
  ConnectedAccountRequestAuthSubjectRegistry,
} from '../requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import {
  scopeConnectedAccountPurposeBindingLease,
  type ConnectedAccountPurposeBindingOwner,
} from './ConnectedAccountPurposeBindingOwner';
import type { DaemonConnectedAccountPurposeBindingRuntime } from './createDaemonConnectedAccountPurposeBindingRuntime';

export type ManagedProviderOperationAuthorityActivation = Readonly<{
  exactPurposeBindingSubjectId: string | null;
  requestAuth: ManagedProviderRequestAuthCapabilityPathBinding | null;
  isCurrent(): boolean;
  cleanup(): Promise<void>;
}>;

export type ManagedProviderOperationAuthority = Readonly<{
  forPurposeBindingOwner(owner: Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>): ManagedProviderOperationAuthority;
  listActionFormConnectedAccountOptions?: DaemonConnectedAccountPurposeBindingRuntime['listActionFormConnectedAccountOptions'];
  activate(input: ConnectedAccountInvocationPurposeBinding & Readonly<{
    requestAuthUses: readonly QualifiedConnectedAccountRequestAuthUseV1[];
  }>): Promise<ManagedProviderOperationAuthorityActivation>;
}>;

type RedactionLease = Readonly<{
  add(values: readonly string[]): void;
  close(): void;
}>;

function stableOperationIdentityDigest(input: Readonly<{
  identity: PluginContributionIdentityV1;
  operationId: string;
}>): string {
  return createHash('sha256').update(JSON.stringify([
    'managed-provider-operation-v1',
    input.identity.pluginId,
    input.identity.localId,
    input.operationId,
  ]), 'utf8').digest('hex');
}

async function runAllCleanups(
  cleanups: readonly (() => void | Promise<void>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Managed Provider operation authority cleanup failed',
    );
  }
}

export function createManagedProviderOperationAuthority(input: Readonly<{
  materializationBaseDir: string;
  purposeBindingOwner: Pick<
    ConnectedAccountPurposeBindingOwner,
    'activatePurposeBindings'
  >;
  listActionFormConnectedAccountOptions?: DaemonConnectedAccountPurposeBindingRuntime['listActionFormConnectedAccountOptions'];
  requestAuthRegistry: Pick<
    ConnectedAccountRequestAuthSubjectRegistry,
    'activate' | 'retire'
  >;
  resolveRequestAuthHttpPort(): number;
  createRedactionLease(): RedactionLease;
}>): ManagedProviderOperationAuthority {
  return Object.freeze({
    forPurposeBindingOwner: (purposeBindingOwner: Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>) =>
      createManagedProviderOperationAuthority({ ...input, purposeBindingOwner }),
    ...(input.listActionFormConnectedAccountOptions ? { listActionFormConnectedAccountOptions: input.listActionFormConnectedAccountOptions } : {}),
    async activate(operationInput) {
      const captured = captureConnectedAccountInvocationPurposeBinding(operationInput);
      const { managedOperation, isCurrent, identity, operationId, purposes } = captured;
      const purposeKeys = new Set(purposes.map(qualifiedPurposeKey));
      const bindings = captured.purposeBindings.bindings;
      const requestAuthUses = Object.freeze(operationInput.requestAuthUses.map((useLike) => {
        const use = QualifiedConnectedAccountRequestAuthUseV1Schema.parse(useLike);
        const key = qualifiedPurposeKey(use.purpose);
        if (!purposeKeys.has(key)) {
          throw new Error('managed_provider_operation_authority_request_auth_undeclared');
        }
        return Object.freeze({
          purpose: Object.freeze({
            consumer: Object.freeze({ ...use.purpose.consumer }),
            purpose: use.purpose.purpose,
          }),
          materialization: Object.freeze({
            ...use.materialization,
            headerNames: Object.freeze([...use.materialization.headerNames]),
          }),
        });
      }));
      if (!isCurrent()) {
        throw new Error('managed_provider_operation_authority_not_current');
      }

      // Native managed operations retain absence as well as a selected account;
      // an empty exact lease must never fall through to mutable user defaults.
      const purposeLease = purposes.length > 0 || managedOperation !== undefined
        ? input.purposeBindingOwner.activatePurposeBindings({
            subject: {
              kind: 'managed_provider_operation',
              operationId,
              pluginId: identity.pluginId,
              providerLocalId: identity.localId,
              ...(managedOperation?.credentialConfigurations === undefined ? {} : {
                credentialConfigurations: managedOperation.credentialConfigurations,
              }),
              isCurrent,
            },
            purposes,
            bindings,
          })
        : null;
      let redactionLease: RedactionLease | null = null;
      let materializedRootDir: string | null = null;
      let descriptor: Awaited<ReturnType<
        ConnectedAccountRequestAuthSubjectRegistry['activate']
      >> | null = null;
      let cleanupStarted = false;
      let cleaned = false;
      let cleanupPromise: Promise<void> | null = null;
      let requestAuthRetired = false;
      let purposeLeaseDisposed = false;
      let redactionLeaseClosed = false;
      const cleanup = async (): Promise<void> => {
        if (cleaned) return;
        if (cleanupPromise) return await cleanupPromise;
        cleanupStarted = true;
        const attempt = runAllCleanups([
          async () => {
            if (requestAuthRetired) return;
            if (descriptor) {
              await input.requestAuthRegistry.retire(descriptor, {
                removeMaterializedRoot: true,
              });
            }
            requestAuthRetired = true;
          },
          () => {
            if (purposeLeaseDisposed) return;
            purposeLease?.dispose();
            purposeLeaseDisposed = true;
          },
          () => {
            if (redactionLeaseClosed) return;
            redactionLease?.close();
            redactionLeaseClosed = true;
          },
        ]).then(() => {
          cleaned = true;
        });
        cleanupPromise = attempt;
        try {
          await attempt;
        } finally {
          if (!cleaned && cleanupPromise === attempt) {
            cleanupPromise = null;
          }
        }
      };

      try {
        if (requestAuthUses.length > 0 && purposeLease) {
          await ensurePrivateConnectedServiceMaterializedRoot(
            input.materializationBaseDir,
          );
          const operationIdentityDigest = stableOperationIdentityDigest({
            identity,
            operationId,
          });
          materializedRootDir = join(
            input.materializationBaseDir,
            `provider-operation-${operationIdentityDigest}`,
          );
          await ensurePrivateConnectedServiceMaterializedRoot(
            materializedRootDir,
          );
          redactionLease = input.createRedactionLease();
          const subject = scopeConnectedAccountPurposeBindingLease({
            lease: purposeLease,
            subjectId: purposeLease.subjectId,
            uses: requestAuthUses,
            registerRedaction: redactionLease.add,
          });
          descriptor = await input.requestAuthRegistry.activate({
            subject,
            materializedRootDir,
            materializationId:
              `managed-provider-operation-${operationIdentityDigest}`,
            httpPort: input.resolveRequestAuthHttpPort(),
          });
        }
        const requestAuth = descriptor
          ? Object.freeze({
              realm: 'managedProviderStart' as const,
              capabilityPath: descriptor.path,
              requestAuthUses: Object.freeze(requestAuthUses.map((use) =>
                Object.freeze({
                  purpose: use.purpose.purpose,
                  materialization: use.materialization,
                }))),
              qualifiedRequestAuthUses: Object.freeze(requestAuthUses.filter((use) => (
                purposeLease !== null && purposeLease.resolvePurposeBinding(use.purpose) !== null
              ))),
              isCurrent: () => (
                !cleanupStarted
                && isCurrent()
                && purposeLease?.isCurrent() === true
              ),
            })
          : null;
        return Object.freeze({
          exactPurposeBindingSubjectId:
            purposeLease?.subjectId ?? null,
          requestAuth,
          isCurrent: () => !cleanupStarted && isCurrent()
            && (purposeLease === null || purposeLease.isCurrent()),
          cleanup,
        });
      } catch (error) {
        await cleanup().catch(() => undefined);
        throw error;
      }
    },
  });
}
