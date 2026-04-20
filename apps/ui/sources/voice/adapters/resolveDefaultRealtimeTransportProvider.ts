import { createRealtimeElevenLabsTransportProvider } from './realtimeElevenLabs/realtimeElevenLabsTransportProvider';

import type { RealtimeTransportProvider } from '@/voice/runtime/realtime/realtimeTransportProvider';

export function resolveDefaultRealtimeTransportProvider(): RealtimeTransportProvider {
    return createRealtimeElevenLabsTransportProvider();
}
