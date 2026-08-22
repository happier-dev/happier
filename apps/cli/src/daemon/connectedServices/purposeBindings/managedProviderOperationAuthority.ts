import { createHash } from 'node:crypto';
import { join } from 'node:path';

import {
  QualifiedConnectedAccountPurposeBindingsV1Schema,
  QualifiedConnectedAccountPurposeV1Schema,
  QualifiedConnectedAccountRequestAuthUseV1Schema,
  qualifiedPurposeKey,
  type PluginContributionIdentityV1,
  type QualifiedConnectedAccountPurposeBindingsV1,
  type QualifiedConnectedAccountPurposeV1,
  type QualifiedConnectedAccountRequestAuthUseV1,
} from '@happier-dev/protocol';

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

export type ManagedProviderOperationAuthorityActivation = Readonly<{
  exactPurposeBindingSubjectId: string | null;
  requestAuth: ManagedProviderRequestAuthCapabilityPathBinding | null;
  cleanup(): Promise<void>;
}>;

export type ManagedProviderOperationAuthority = Readonly<{
  activate(input: Readonly<{
    identity: PluginContributionIdentityV1;
    operationId: string;
    purposes: readonly QualifiedConnectedAccountPurposeV1[];
    purposeBindings: QualifiedConnectedAccountPurposeBindingsV1;
    requestAuthUses: readonly QualifiedConnectedAccountRequestAuthUseV1[];
    isCurrent(): boolean;
  }>): Promise<ManagedProviderOperationAuthorityActivation>;
}>;

type RedactionLease = Readonly<{
  add(values: readonly string[]): void;
  close(): void;
}>;

function readsCurrent(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

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
  requestAuthRegistry: Pick<
    ConnectedAccountRequestAuthSubjectRegistry,
    'activate' | 'retire'
  >;
  resolveRequestAuthHttpPort(): number;
  createRedactionLease(): RedactionLease;
}>): ManagedProviderOperationAuthority {
  return Object.freeze({
    async activate(operationInput) {
      const identity = Object.freeze({
        pluginId: operationInput.identity.pluginId.trim(),
        localId: operationInput.identity.localId.trim(),
      });
      const operationId = operationInput.operationId.trim();
      if (!identity.pluginId || !identity.localId || !operationId) {
        throw new Error('managed_provider_operation_authority_identity_invalid');
      }
      const purposes = Object.freeze(operationInput.purposes.map((purposeLike) => {
        const purpose = QualifiedConnectedAccountPurposeV1Schema.parse(purposeLike);
        if (
          purpose.consumer.pluginId !== identity.pluginId
          || purpose.consumer.localId !== identity.localId
        ) {
          throw new Error('managed_provider_operation_authority_consumer_mismatch');
        }
        return Object.freeze({
          consumer: Object.freeze({ ...purpose.consumer }),
          purpose: purpose.purpose,
        });
      }));
      const purposeKeys = new Set(purposes.map(qualifiedPurposeKey));
      if (purposeKeys.size !== purposes.length) {
        throw new Error('managed_provider_operation_authority_duplicate_purpose');
      }
      const bindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse(
        operationInput.purposeBindings,
      ).bindings;
      const bindingKeys = new Set<string>();
      for (const binding of bindings) {
        const key = qualifiedPurposeKey(binding.purpose);
        if (!purposeKeys.has(key) || bindingKeys.has(key)) {
          throw new Error('managed_provider_operation_authority_binding_invalid');
        }
        bindingKeys.add(key);
      }
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
      if (!readsCurrent(operationInput.isCurrent)) {
        throw new Error('managed_provider_operation_authority_not_current');
      }

      const purposeLease = purposes.length > 0
        ? input.purposeBindingOwner.activatePurposeBindings({
            subject: {
              kind: 'managed_provider_operation',
              operationId,
              pluginId: identity.pluginId,
              providerLocalId: identity.localId,
              isCurrent: operationInput.isCurrent,
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
        if (requestAuthUses.length > 0) {
          if (!purposeLease?.isCurrent()) {
            throw new Error('managed_provider_operation_authority_not_current');
          }
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
          if (!subject.isCurrent()) {
            throw new Error('managed_provider_operation_authority_not_current');
          }
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
              isCurrent: () => (
                !cleanupStarted
                && readsCurrent(operationInput.isCurrent)
                && purposeLease?.isCurrent() === true
              ),
            })
          : null;
        return Object.freeze({
          exactPurposeBindingSubjectId:
            purposeLease?.subjectId ?? null,
          requestAuth,
          cleanup,
        });
      } catch (error) {
        await cleanup().catch(() => undefined);
        throw error;
      }
    },
  });
}
