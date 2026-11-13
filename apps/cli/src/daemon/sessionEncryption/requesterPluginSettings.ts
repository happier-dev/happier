import { waitForObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { createAccountPluginSettingsRecordStorage } from '@/plugins/runtime/context/accountPluginSettingsRecordStorage';
import type { AgentPluginAccountSettingsSource } from '@/plugins/runtime/agentPluginSettings';
import type { AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';

/** Reuses the admitted requester's Account storage authority for Agent settings reads. */
export function createRequesterPluginSettingsSource(input: Readonly<{
  bootstrap: AdmittedRequesterSessionBootstrap;
  isCurrent?: () => Promise<boolean>;
  signal?: AbortSignal;
}>): AgentPluginAccountSettingsSource {
  const { bootstrap } = input;
  return Object.freeze({
    recordAdapter: createAccountPluginSettingsRecordStorage({
      readCredentials: async () => bootstrap.credentials,
      resolveBaseUrl: () => bootstrap.serverHttpBaseUrl,
      isCurrentAccount: async () => {
        input.signal?.throwIfAborted();
        if (input.isCurrent) return await input.isCurrent();
        if (!await bootstrap.ensureAccountSettingsCurrent(input.signal)) return false;
        const current = bootstrap.savedSecretOperationContext.isCurrent(input.signal);
        return await (input.signal ? waitForObservation(current, input.signal) : current);
      },
    }),
    readReleasedAccountSettings: () => bootstrap.savedSecretOperationContext.readSnapshot()?.rawSettings ?? null,
  });
}
