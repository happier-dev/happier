import type { LocalUploadSource } from '@/sync/runtime/files/localUploadSourceReader';
import type { DaemonVoiceInferenceNormalizationDecision } from '@happier-dev/protocol';

import { DaemonVoiceInferenceClient } from './DaemonVoiceInferenceClient';
import type { DaemonVoiceInferenceMachineTarget } from './DaemonVoiceInferenceClient';

export type DaemonSttControllerDeps = Readonly<{
    client: Pick<DaemonVoiceInferenceClient, 'transcribeRecordedAudio'>;
}>;

export class DaemonSttController {
    private readonly deps: DaemonSttControllerDeps;

    constructor(deps?: Partial<DaemonSttControllerDeps>) {
        this.deps = {
            client: new DaemonVoiceInferenceClient(),
            ...deps,
        };
    }

    async transcribeRecordedAudio(params: Readonly<{
        sessionId?: string | null;
        machineTarget?: DaemonVoiceInferenceMachineTarget | null;
        source: LocalUploadSource;
        inputMimeType: string;
        packId: string | null;
        language: string | null;
        normalization?: DaemonVoiceInferenceNormalizationDecision | null;
        signal?: AbortSignal | null;
    }>): Promise<Readonly<{
        text: string;
        language: string | null;
        modelPackId: string | null;
    }>> {
        return await this.deps.client.transcribeRecordedAudio(params);
    }
}
