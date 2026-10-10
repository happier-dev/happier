export { applyVoiceDictationEngineChoice, selectVoiceSpeechProvider, selectVoiceProviderOption, projectVoiceProviderSelectionRows, projectSelectedUnavailableVoiceProvider, resolveSelectedVoiceProviderTitleKey } from '@happier-dev/protocol/voice/settings/providerSelection';
import type { VoiceProviderRegistryEntry } from './providerRegistry';
import type { VoiceProviderSelectionRow as PortableRow, SelectedUnavailableVoiceProvider as PortableUnavailable } from '@happier-dev/protocol/voice/settings/providerSelection';
export type VoiceProviderSelectionRow = PortableRow<VoiceProviderRegistryEntry>;
export type SelectedUnavailableVoiceProvider = PortableUnavailable<VoiceProviderRegistryEntry>;
