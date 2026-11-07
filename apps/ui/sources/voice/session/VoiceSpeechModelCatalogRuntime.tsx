import { useSetting } from '@/sync/domains/state/storage';
import { useSelectedVoiceSpeechModelCatalog } from '@/voice/settings/useSelectedVoiceSpeechModelCatalog';

/** The app observes selected speech models once; revealed message actions only consume the facts. */
export function VoiceSpeechModelCatalogRuntime() {
    const voice = useSetting('voice');
    useSelectedVoiceSpeechModelCatalog(voice, { purpose: 'conversation', probeMachine: true });
    return null;
}
