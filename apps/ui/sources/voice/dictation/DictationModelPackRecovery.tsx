import * as React from 'react';

import { getDefaultModelPackId } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { parseLocalVoiceSttSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';
import { resolveLocalNeuralExecutionPolicy } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { SelectedDaemonModelPackRow } from '@/voice/settings/panels/modelCatalog/DaemonModelPackRow';
import { DaemonVoiceModelCatalogProvider } from '@/voice/settings/panels/modelCatalog/DaemonVoiceModelCatalogContext';
import { useDaemonVoiceModelCatalogState } from '@/voice/settings/panels/modelCatalog/useDaemonVoiceModelCatalogState';
import { createVoiceDictationRuntimeSettingsSnapshot } from './voiceDictationRuntimeSettings';

function DaemonDictationModelPackRecovery(props: Readonly<{ packId: string }>): React.ReactElement {
    const controller = useDaemonVoiceModelCatalogState();
    return <DaemonVoiceModelCatalogProvider value={controller}>
        <SelectedDaemonModelPackRow packId={props.packId} kind="stt_sherpa" />
    </DaemonVoiceModelCatalogProvider>;
}

/** Mounted only for a missing model, so setup stays beside the retained recording and its Retry. */
export function DictationModelPackRecovery(): React.ReactElement | null {
    const voice = useSetting('voice');
    const runtimeSettings = createVoiceDictationRuntimeSettingsSnapshot({ voice });
    const stt = parseLocalVoiceSttSettings(resolveLocalVoiceAdapterSettings(runtimeSettings).config.stt);
    if (stt.provider !== 'local_neural' || resolveLocalNeuralExecutionPolicy({
        requestedExecution: stt.localNeural.execution,
    }).preferredExecution !== 'daemon') return null;
    return <DaemonDictationModelPackRecovery
        packId={stt.localNeural.assetId ?? getDefaultModelPackId('stt_sherpa')!} />;
}
