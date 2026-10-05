import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { renderStructuredMessage } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { getDeviceAnalyticsId } from '@/track/settingsAnalytics/deviceAnalyticsIdentity';
import { buildVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { voiceMomentsTranslations } from '@/text/translations/voiceMomentsTranslations';

describe('Voice note in the ordinary session transcript', () => {
    it('renders provenance in the viewer’s language and viewpoint instead of an unavailable plugin card or persisted author prose', () => {
        const deviceId = getDeviceAnalyticsId();
        if (!deviceId) throw new Error('Expected the existing installation identity');
        for (const [continuingDevice, expected] of [
            ['other-device', voiceMomentsTranslations.en.continuedOn({ device: 'Alice’s phone' })],
            [deviceId, voiceMomentsTranslations.en.continuedHere],
        ]) {
            const element = renderStructuredMessage({ sessionId: 'conversation',
                onJumpToAnchor: undefined,
                interaction: deriveTranscriptInteraction({ kind: 'public' }),
                message: { kind: 'agent-text', id: 'note', localId: null, createdAt: 1,
                    text: 'Voice continued on this device.',
                    meta: buildVoiceTranscriptNoteMeta({ continuation: { v: 1, deviceId: continuingDevice,
                        deviceDisplayName: 'Alice’s phone', conversation: { serverId: 'home', sessionId: 'conversation' } } }),
                } });
            expect((element as ReactElement<{ children?: unknown }> | null)?.props.children).toBe(expected);
        }
    });
});
