import type { BundledVoiceRuntimeContribution, VoiceAdapterController } from '@/voice/session/types';
import { createLocalConversationVoiceAdapter } from './localConversation/localConversationAdapter';
import { createLocalDirectVoiceAdapter } from './localDirect/localDirectAdapter';
import {
  BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES,
  BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES,
} from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import {
  createBundledConversationRuntimes,
  type BundledConversationRuntimeEntry,
} from '@/voice/registry/bundledConversationRuntimes';
import {
  createBundledConversationRuntimeHostLease,
} from '@/voice/registry/bundledConversationRuntimeHost';
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';
import { getExternalVoiceProviderProjectionAuthority } from '@/voice/registry/externalVoiceProviderRegistrations';

export type BuiltinVoiceAdapterAssembly = Readonly<{
  adapters: ReadonlyArray<VoiceAdapterController>;
  activateProvider(providerId: string): Promise<void>;
  dispose: () => Promise<void>;
}>;

export function createBuiltinVoiceAdapterAssembly(input: Readonly<{
  bundledEntries?: readonly BundledConversationRuntimeEntry[];
  currentUiContext?: VoiceCurrentUiToolPort;
}> = {}): BuiltinVoiceAdapterAssembly {
  const bundledEntries =
    input.bundledEntries ?? BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES;
  const hostLease = createBundledConversationRuntimeHostLease({
    ...(input.currentUiContext ? { currentUiContext: input.currentUiContext } : {}),
  });
  const bundled: BundledVoiceRuntimeContribution[] = [];
  const activations = new Map<string, Promise<void>>();
  let disposed = false;
  const localAdapters = Object.freeze([
    createLocalDirectVoiceAdapter(),
    createLocalConversationVoiceAdapter({
      ...(input.currentUiContext ? { currentUiContext: input.currentUiContext } : {}),
    }),
  ]);
  let adapters: readonly VoiceAdapterController[] = localAdapters;
  let disposePromise: Promise<void> | null = null;
  return Object.freeze({
    get adapters() { return adapters; },
    activateProvider(providerId) {
      if (disposed) return Promise.resolve();
      // A daemon projection owns its complete Voice set, including disabled
      // providers. Its existing executable host activates the selected target;
      // the source-only bridge must not load a second copy or bypass absence.
      if (getExternalVoiceProviderProjectionAuthority() !== null) return Promise.resolve();
      const pending = activations.get(providerId);
      if (pending) return pending;
      const entry = bundledEntries.find(candidate => candidate.providerId === providerId);
      if (!entry) return Promise.resolve();
      const activation = (async () => {
        const runtimes = await createBundledConversationRuntimes({
          bundledEntries: [entry],
          hostedConversationEntries: BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES,
          host: hostLease.host,
        });
        if (disposed) {
          await Promise.all(runtimes.map(runtime => runtime.dispose()));
          return;
        }
        bundled.push(...runtimes);
        adapters = Object.freeze([...bundled.map(runtime => runtime.adapter), ...localAdapters]);
        if (runtimes.length === 0) activations.delete(providerId);
      })();
      activations.set(providerId, activation);
      return activation;
    },
    dispose() {
      disposePromise ??= (async () => {
        disposed = true;
        hostLease.revoke();
        await Promise.all(activations.values());
        await Promise.all(bundled.map(async (runtime) => await runtime.dispose()));
      })().catch((error: unknown) => {
        disposePromise = null;
        throw error;
      });
      return disposePromise;
    },
  });
}
