import { describe, expect, it } from 'vitest';

import { resolveDaemonSpeechPcmCaptureAvailability } from './resolveDaemonSpeechPcmCaptureAvailability.web';

describe('resolveDaemonSpeechPcmCaptureAvailability (web)', () => {
    it('keeps passive daemon PCM capture availability open for web', () => {
        expect(resolveDaemonSpeechPcmCaptureAvailability()).toBe('available');
    });
});
