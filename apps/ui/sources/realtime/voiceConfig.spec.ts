import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

describe('VOICE_CONFIG', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...originalEnv };
        delete process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('defaults ENABLE_DEBUG_LOGGING to false', async () => {
        const { VOICE_CONFIG } = await import('./voiceConfig');
        expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });

    it('enables debug logging when the dangerous debug env flag is set', async () => {
        process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '1';
        const { VOICE_CONFIG } = await import('./voiceConfig');
        expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(true);
    });

    it('keeps debug logging disabled when the flag is an empty string', async () => {
        process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '';
        const { VOICE_CONFIG } = await import('./voiceConfig');
        expect(VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(false);
    });

    it('treats non-empty flag strings as enabled (including "0" and "false")', async () => {
        process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = '0';
        const first = await import('./voiceConfig');
        expect(first.VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(true);

        vi.resetModules();
        process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING = 'false';
        const second = await import('./voiceConfig');
        expect(second.VOICE_CONFIG.ENABLE_DEBUG_LOGGING).toBe(true);
    });
});
