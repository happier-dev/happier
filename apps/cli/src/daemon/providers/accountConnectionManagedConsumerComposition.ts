import type { ExecutionRunManagedProviderSourceOpener } from '@/agent/runtime/bridges/executionRun/runtime/managedProvider';
import { createAccountConnectionManagedConsumerSourceOpen } from '@/providers/broker/accountConnectionSource';
import type { OpenAccountConnectionProviderBrokerAccess } from '@/providers/broker/accountConnectionClient';
import type { ProviderConnectionRegistryReader } from '@/providers/broker/providerConnectionSource';
import type { ManagedProviderExplicitStartCustody } from '@/providers/connections/publicManagedRuntimeStart';
import type { RuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

/** Adapt the actual admitted Run and its issued Account context to the same
 * source owner used by the signed broker. No ambient Account data is read. */
export function createDaemonAccountConnectionManagedConsumerOpen(input: Readonly<{
  homeId: string;
  accountId: string;
  machineId(): string;
  isHomeCurrent(): boolean;
  custody(machineId: string): ManagedProviderExplicitStartCustody;
  withRegistry: ProviderConnectionRegistryReader;
  projectModelsForAccount: RuntimeProviderModelManagementServices['projectModelsForAccount'];
  openRemote(request: Parameters<OpenAccountConnectionProviderBrokerAccess>[0],
    isCurrent: () => Promise<boolean>): Promise<Awaited<ReturnType<OpenAccountConnectionProviderBrokerAccess>> | null>;
}>): ExecutionRunManagedProviderSourceOpener {
  return async context => {
    const machineId = input.machineId();
    const isCurrent = async () => !context.signal.aborted && input.isHomeCurrent()
      && input.machineId() === machineId
      && context.accountId === input.accountId
      && await context.isCurrent();
    let ownedSnapshot: ActiveAccountSettingsSnapshot | null = null;
    const admitConsumer = async () => {
      if (!await isCurrent()) return false;
      const snapshot = await context.readAccountSettingsSnapshot();
      if (!snapshot || snapshot.scopeKey !== context.expectedAccountSettingsScopeKey || !await isCurrent()) {
        ownedSnapshot = null;
        return false;
      }
      ownedSnapshot = snapshot;
      return true;
    };
    if (!await admitConsumer()) return null;
    if (context.targetMachineId !== machineId) {
      const opened = await input.openRemote({
        connectionId: context.request.source.connectionId,
        expectedConnectionSecurityFingerprint: context.request.source.expectedConnectionSecurityFingerprint,
        expectedManagedRuntimeBindingFingerprint: context.request.source.expectedManagedRuntimeBindingFingerprint,
        targetMachineId: context.targetMachineId, consumer: context.request.consumer,
        ...(context.request.executionRunOccurrenceId ? { executionRunOccurrenceId: context.request.executionRunOccurrenceId } : {}),
        application: context.request.application, signal: context.signal,
      }, admitConsumer);
      if (!opened) return null;
      if (!await admitConsumer()) { await opened.cleanup(); return null; }
      return {
        access: opened.access,
        revalidate: async () => {
          if (!await admitConsumer()) return false;
          try { await opened.readHttpBinding(); return await isCurrent(); } catch { return false; }
        },
        cleanup: opened.cleanup,
        retire: opened.cleanup,
      };
    }
    return await createAccountConnectionManagedConsumerSourceOpen({
      homeId: input.homeId, accountId: input.accountId, machineId,
      expectedAccountSettingsScopeKey: context.expectedAccountSettingsScopeKey,
      getAccountSettingsSnapshot: () => ownedSnapshot,
      resolveBindingIntent: context.resolveManagedPurposeBindingIntent,
      admitConsumer,
      custody: input.custody(machineId),
      withRegistry: input.withRegistry,
      projectModels: request => input.projectModelsForAccount(request, {
        getAccountSettingsSnapshot: () => ownedSnapshot,
        resolveManagedPurposeBindingIntent: context.resolveManagedPurposeBindingIntent,
        signal: context.signal, isCurrent,
      }),
    })({ ...context.request, signal: context.signal });
  };
}
