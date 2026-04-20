import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('RealtimeProvider provider ownership', () => {
    it('does not hard-couple the app shell to the ElevenLabs React Native SDK', async () => {
        const source = await readFile('sources/realtime/RealtimeProvider.tsx', 'utf8');

        expect(source).not.toContain('@elevenlabs/react-native');
        expect(source).not.toContain('ElevenLabsProvider');
    });
});
