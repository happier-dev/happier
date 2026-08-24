/** @moduleRealm daemon */
import type { VoiceProviderCatalogItem } from '@happier-dev/protocol/voice/providerOperations';
import type {
    VoiceSpeechOperationContext as ProtocolVoiceSpeechOperationContext,
    VoiceSpeechSynthesizeRequest,
    VoiceSpeechSynthesizeResult,
    VoiceSpeechTranscribeRequest,
    VoiceSpeechTranscribeResult,
} from '@happier-dev/protocol/voice/speech';

import type { VoiceCredentialAccess } from './projections.js';
import type { HttpService } from '../services/io.js';

export type { VoiceProviderCatalogItem };
export type {
    VoiceSpeechCatalogDeclaration,
    VoiceSpeechInputMimeType,
    VoiceSpeechProviderLimits,
    VoiceSpeechProviderRole,
} from '@happier-dev/protocol/plugins/contributions/voice';

/** Speech runtimes receive only the request authority their V1 contract declares. */
export type VoiceSpeechOperationContext = ProtocolVoiceSpeechOperationContext<
    VoiceCredentialAccess<'speech'>,
    Pick<HttpService, 'request'>
>;
export type {
    VoiceSpeechSynthesizeRequest,
    VoiceSpeechSynthesizeResult,
    VoiceSpeechTranscribeRequest,
    VoiceSpeechTranscribeResult,
};

export type SpeechProviderRuntime = Readonly<{
    kind: 'speech';
    catalog?: Readonly<{
        list(
            request: Readonly<{ catalog: 'voices' | 'models' }>,
            context: VoiceSpeechOperationContext,
        ): Promise<readonly VoiceProviderCatalogItem[]>;
    }>;
    transcribe?(
        request: VoiceSpeechTranscribeRequest,
        context: VoiceSpeechOperationContext,
    ): Promise<VoiceSpeechTranscribeResult>;
    synthesize?(
        request: VoiceSpeechSynthesizeRequest,
        context: VoiceSpeechOperationContext,
    ): Promise<VoiceSpeechSynthesizeResult>;
}>;
