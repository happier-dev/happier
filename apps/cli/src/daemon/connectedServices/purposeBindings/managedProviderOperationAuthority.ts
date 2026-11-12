import { PluginError } from '@happier-dev/plugin-sdk';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
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

type ManagedOperationPurposeOwner = Pick<ConnectedAccountPurposeBindingOwner, 'activatePurposeBindings'>
  & Partial<Pick<DaemonConnectedAccountPurposeBindingRuntime, 'admitActionPurposeBindings'>>;
type ActionPurposeAdmission = Awaited<ReturnType<DaemonConnectedAccountPurposeBindingRuntime['admitActionPurposeBindings']>>;

function teamActionUnavailable(): PluginError {
  return new PluginError({ code: 'plugin_connected_account_team_resource_unavailable',
    message: 'The selected Team credential cannot be used for this Action', details: { reason: 'action_binding_unavailable' } });
}

export type ManagedProviderOperationAuthorityActivation = Readonly<{
  executeBrokeredAction?: Extract<ActionPurposeAdmission, { kind: 'brokered' }>['execute'];
  exactPurposeBindingSubjectId: string | null;
  requestAuth: ManagedProviderRequestAuthCapabilityPathBinding | null;
  isCurrent(): boolean;
  cleanup(): Promise<void>;
}>;

export type ManagedProviderOperationAuthority = Readonly<{
  forPurposeBindingOwner(owner: ManagedOperationPurposeOwner): ManagedProviderOperationAuthority;
  listActionFormConnectedAccountOptions?: DaemonConnectedAccountPurposeBindingRuntime['listActionFormConnectedAccountOptions'];
  activate(input: ConnectedAccountInvocationPurposeBinding & Readonly<{
    requestAuthUses: readonly QualifiedConnectedAccountRequestAuthUseV1[];
    recordOperationCredentialUse?: Parameters<ConnectedAccountPurposeBindingOwner['activatePurposeBindings']>[0]['recordOperationCredentialUse'];
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

type ManagedProviderRequestAuthHost = Readonly<{
  materializationBaseDir: string;
  requestAuthRegistry: Pick<ConnectedAccountRequestAuthSubjectRegistry, 'activate' | 'retire'>;
  resolveRequestAuthHttpPort(): number;
  createRedactionLease(): RedactionLease;
}>;

export function createManagedProviderOperationAuthority(input: Readonly<{
  purposeBindingOwner: ManagedOperationPurposeOwner;
  listActionFormConnectedAccountOptions?: DaemonConnectedAccountPurposeBindingRuntime['listActionFormConnectedAccountOptions'];
}> & (ManagedProviderRequestAuthHost | Readonly<{ [K in keyof ManagedProviderRequestAuthHost]?: never }>)): ManagedProviderOperationAuthority {
  // Finite Account Actions consume exact purpose custody without issuing process request-auth.
  const requestAuthHost = input.requestAuthRegistry === undefined ? undefined : input;

  return Object.freeze({
    forPurposeBindingOwner: (purposeBindingOwner: ManagedOperationPurposeOwner) =>
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
      let actionAdmission: ActionPurposeAdmission | null = null;
      if (captured.purposeBindings.teamResourceSelections?.length) {
        if (!captured.actionOperation || !input.purposeBindingOwner.admitActionPurposeBindings) throw teamActionUnavailable();
        actionAdmission = await input.purposeBindingOwner.admitActionPurposeBindings({
          subject: { kind: 'action_operation', operationId, actionId: formatQualifiedPluginActionId(identity),
            pluginVersion: captured.actionOperation.pluginVersion, consumer: identity, isCurrent },
          purposes, bindings, teamResourceSelections: captured.purposeBindings.teamResourceSelections,
          signal: captured.actionOperation.signal,
          ...(captured.actionOperation.resolveRequestHeaders ? { resolveRequestHeaders: captured.actionOperation.resolveRequestHeaders } : {}),
          ...(operationInput.recordOperationCredentialUse ? { recordOperationCredentialUse: operationInput.recordOperationCredentialUse } : {}),
        });
      }
      const purposeLease = actionAdmission !== null ? actionAdmission.kind === 'local' ? actionAdmission.lease : null
        : purposes.length > 0 || managedOperation !== undefined
        ? input.purposeBindingOwner.activatePurposeBindings({
            subject: {
              kind: 'managed_provider_operation', operationId, pluginId: identity.pluginId,
              providerLocalId: identity.localId,
              ...(managedOperation?.credentialConfigurations === undefined ? {} : { credentialConfigurations: managedOperation.credentialConfigurations }),
              isCurrent,
            }, purposes, bindings,
            ...(operationInput.recordOperationCredentialUse ? { recordOperationCredentialUse: operationInput.recordOperationCredentialUse } : {}),
          }) : null;
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
              await requestAuthHost?.requestAuthRegistry.retire(descriptor, {
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
          if (!requestAuthHost) throw new PluginError({ code: 'plugin_connected_account_binding_unavailable',
            details: { reasonCode: 'request_auth_host_unavailable' } });
          await ensurePrivateConnectedServiceMaterializedRoot(
            requestAuthHost.materializationBaseDir,
          );
          const operationIdentityDigest = stableOperationIdentityDigest({
            identity,
            operationId,
          });
          materializedRootDir = join(
            requestAuthHost.materializationBaseDir,
            `provider-operation-${operationIdentityDigest}`,
          );
          await ensurePrivateConnectedServiceMaterializedRoot(
            materializedRootDir,
          );
          redactionLease = requestAuthHost.createRedactionLease();
          const subject = scopeConnectedAccountPurposeBindingLease({
            lease: purposeLease,
            subjectId: purposeLease.subjectId,
            uses: requestAuthUses,
            registerRedaction: redactionLease.add,
          });
          descriptor = await requestAuthHost.requestAuthRegistry.activate({
            subject,
            materializedRootDir,
            materializationId:
              `managed-provider-operation-${operationIdentityDigest}`,
            httpPort: requestAuthHost.resolveRequestAuthHttpPort(),
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
        const brokeredAction = actionAdmission?.kind === 'brokered' ? actionAdmission : null;
        return Object.freeze({
          ...(brokeredAction ? {
            executeBrokeredAction: async (actionInput: Parameters<Extract<ActionPurposeAdmission, { kind: 'brokered' }>['execute']>[0]) => {
              if (cleanupStarted) throw teamActionUnavailable();
              return await brokeredAction.execute(actionInput);
            },
          } : {}),
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
