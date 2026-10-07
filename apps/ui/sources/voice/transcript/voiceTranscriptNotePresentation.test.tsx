import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { renderStructuredMessage } from '@/components/sessions/transcript/structured/StructuredMessageBlock';
import { deriveTranscriptInteraction } from '@/utils/sessions/deriveTranscriptInteraction';
import { getDeviceAnalyticsId } from '@/track/settingsAnalytics/deviceAnalyticsIdentity';
import { buildVoiceTranscriptNoteMeta } from './voiceTranscriptNoteMeta';
import { voiceMomentsTranslations } from '@/text/translations/voiceMomentsTranslations';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

describe('Voice note in the ordinary session transcript', () => {
    it('renders provenance in the viewer’s language and viewpoint instead of an unavailable plugin card or persisted author prose', async () => {
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
            if (!element) throw new Error('Voice continuation note was not presented');
            const screen = await renderScreen(element);
            expect(screen.getTextContent()).toContain(expected);
            expect(screen.getTextContent()).not.toContain('Voice continued on this device.');
        }
    });
});
