import type {
  BundledVoiceRuntimeContribution,
  VoiceAdapterController,
} from '@/voice/session/types';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import {
  readSafeVoiceRuntimeFailureCode,
  recordVoiceRuntimeFailure,
} from '@/voice/runtime/voiceRuntimeFailureCode';

import {
  createBundledHostedConversationService,
  getCurrentBundledConversationRuntimeHost,
  type BundledConversationRuntimeHost,
} from './bundledConversationRuntimeHost';
import {
  createExternalVoiceProviderActivationScope,
} from './externalVoiceProviderActivation';
import {
  getExternalVoiceProviderRegistration,
} from './externalVoiceProviderRegistrations';
import type { BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';

export type { BundledConversationRuntimeEntry } from './bundledConversationRuntimeEntries';

function excluded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export function isBundledHostedConversationEntryAuthorized(
  entry: BundledConversationRuntimeEntry,
  authorizedEntries: readonly BundledConversationRuntimeEntry[],
): boolean {
  return authorizedEntries.includes(entry);
}

function isAdapter(value: VoiceAdapterController | null, providerId: string): value is VoiceAdapterController {
  return value !== null
    && value.id === providerId
    && value.engineKind === 'realtime'
    && typeof value.start === 'function'
    && typeof value.stop === 'function';
}

/**
 * Compose generated first-party modules through the installed/public activation
 * owner.
 *
 * Composition is per-entry isolated: a leaf that throws while being composed is
 * excluded and named, and every healthy leaf still registers. A shared abort
 * would let one plugin leaf's import or activation error withdraw Voice from
 * every other provider and take down the shell that mounts this composition,
 * which the plugin platform's activation isolation contract forbids.
 */
export function createBundledConversationRuntimes(input: Readonly<{
  bundledEntries: readonly BundledConversationRuntimeEntry[];
  hostedConversationEntries?: readonly BundledConversationRuntimeEntry[];
  host: BundledConversationRuntimeHost;
}>): readonly BundledVoiceRuntimeContribution[] {
  const runtimes: BundledVoiceRuntimeContribution[] = [];
  const seen = new Set<string>();
  for (const entry of input.bundledEntries) {
    let scope: ReturnType<typeof createExternalVoiceProviderActivationScope> | null = null;
    try {
      const providerId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
        pluginId: entry.pluginId,
        localId: entry.declaration.id,
      }));
      // Identity and duplicate denial precede activation, so an excluded entry
      // never registers, never observes a host binding, and never displaces the
      // leaf that already owns the identity.
      if (providerId !== entry.providerId) {
        throw excluded('voice_bundled_runtime_identity_mismatch');
      }
      if (seen.has(providerId)) {
        throw excluded('voice_bundled_runtime_duplicate_identity');
      }
      if (getCurrentBundledConversationRuntimeHost() !== input.host) {
        throw excluded('voice_runtime_host_unavailable');
      }
      const recipientContract = createBundledVoiceRecipientContract({
        pluginId: entry.pluginId,
        declaration: entry.declaration,
      });
      scope = createExternalVoiceProviderActivationScope({
        pluginId: entry.pluginId,
        declarations: [entry.declaration],
        hostPlatform: input.host.getPlatform(),
        hostBindingsByLocalId: Object.freeze({
          [entry.declaration.id]: Object.freeze({
            recipientContract,
            descriptor: 'bundled' as const,
            ...(input.hostedConversationEntries
              && isBundledHostedConversationEntryAuthorized(
                entry,
                input.hostedConversationEntries,
              )
              ? {
                  createInvocationHostedConversation(
                    signal: AbortSignal,
                    isCurrent: () => boolean,
                  ) {
                    return createBundledHostedConversationService({ signal, isCurrent });
                  },
                }
              : {}),
          }),
        }),
      });
      entry.activate(scope.api as Parameters<typeof entry.activate>[0]);
      const commit = scope.commit();
      if (commit) {
        void commit.catch(() => undefined);
      }
      const registration = getExternalVoiceProviderRegistration(providerId);
      if (!registration || !isAdapter(registration.adapter, providerId)) {
        throw excluded('voice_bundled_runtime_invalid_registration');
      }
      seen.add(providerId);
      const committedScope = scope;
      runtimes.push(Object.freeze({
        adapter: registration.adapter,
        async dispose() {
          await committedScope.unwind();
        },
      }));
    } catch (error) {
      // The excluded leaf is otherwise indistinguishable from a provider the
      // user never configured: Start becomes a no-op with no request, no
      // microphone, and no other observer.
      recordVoiceRuntimeFailure(
        entry.providerId,
        'unregistered',
        'adapter_unavailable',
        readSafeVoiceRuntimeFailureCode(error) ?? 'voice_bundled_runtime_activation_failed',
      );
      void Promise.resolve(scope?.unwind()).catch(() => undefined);
    }
  }
  return Object.freeze(runtimes);
}
