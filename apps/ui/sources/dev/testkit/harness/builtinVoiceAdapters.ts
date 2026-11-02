import type { BundledConversationRuntimeEntry } from '@/voice/registry/bundledConversationRuntimeEntries';
import {
  createBuiltinVoiceAdapterAssembly as createAssembly,
  type BuiltinVoiceAdapterAssembly,
} from '@/voice/adapters/registerBuiltinVoiceAdapters';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';

/** Tests exercising provider operations explicitly demand their fixture providers. */
export async function createBuiltinVoiceAdapterAssembly(
  input: Parameters<typeof createAssembly>[0] = {},
): Promise<BuiltinVoiceAdapterAssembly> {
  const assembly = createAssembly(input);
  for (const entry of input.bundledEntries ?? BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES) {
    await assembly.activateProvider(entry.providerId);
  }
  return assembly;
}

export type { BuiltinVoiceAdapterAssembly };

/** Resolve the real provider module before its synchronous public activation. */
export async function loadBundledVoiceRuntimeActivate(entry: BundledConversationRuntimeEntry) {
  return entry.loadActivate ? await entry.loadActivate() : entry.activate;
}
