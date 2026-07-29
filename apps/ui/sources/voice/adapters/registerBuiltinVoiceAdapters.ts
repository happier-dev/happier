import type { VoiceAdapterController } from '@/voice/session/types';
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

export type BuiltinVoiceAdapterAssembly = Readonly<{
  adapters: ReadonlyArray<VoiceAdapterController>;
  dispose: () => Promise<void>;
}>;

export function createBuiltinVoiceAdapterAssembly(input: Readonly<{
  bundledEntries?: readonly BundledConversationRuntimeEntry[];
}> = {}): BuiltinVoiceAdapterAssembly {
  const bundledEntries =
    input.bundledEntries ?? BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES;
  const hostLease = createBundledConversationRuntimeHostLease();
  let bundled: ReturnType<typeof createBundledConversationRuntimes>;
  try {
    bundled = createBundledConversationRuntimes({
      bundledEntries,
      hostedConversationEntries: BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES,
      host: hostLease.host,
    });
  } catch (error) {
    hostLease.revoke();
    throw error;
  }
  let disposePromise: Promise<void> | null = null;
  return Object.freeze({
    adapters: Object.freeze([
      ...bundled.map((runtime) => runtime.adapter),
      createLocalDirectVoiceAdapter(),
      createLocalConversationVoiceAdapter(),
    ]),
    dispose() {
      disposePromise ??= (async () => {
        hostLease.revoke();
        await Promise.allSettled(bundled.map(async (runtime) => await runtime.dispose()));
      })();
      return disposePromise;
    },
  });
}
