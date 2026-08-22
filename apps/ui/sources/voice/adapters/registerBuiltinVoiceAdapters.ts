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
import type { VoiceCurrentUiToolPort } from '@/voice/tools/currentUiContextToolPort';

export type BuiltinVoiceAdapterAssembly = Readonly<{
  adapters: ReadonlyArray<VoiceAdapterController>;
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
  // Composition excludes an unhealthy leaf instead of failing the assembly, so
  // the shell that mounts this assembly keeps booting and every healthy
  // provider stays available.
  const bundled = createBundledConversationRuntimes({
    bundledEntries,
    hostedConversationEntries: BUNDLED_FIRST_PARTY_HOSTED_CONVERSATION_RUNTIME_ENTRIES,
    host: hostLease.host,
  });
  let disposePromise: Promise<void> | null = null;
  return Object.freeze({
    adapters: Object.freeze([
      ...bundled.map((runtime) => runtime.adapter),
      createLocalDirectVoiceAdapter(),
      createLocalConversationVoiceAdapter({
        ...(input.currentUiContext ? { currentUiContext: input.currentUiContext } : {}),
      }),
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
