import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

const temporaryHomes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const path of temporaryHomes.splice(0)) removeTempDirSync(path);
});

describe('Voice response lifetime configuration', () => {
  it.each([undefined, '240000'])('uses only an explicit operator response deadline (%s)', async override => {
    const path = createTempDirSync('voice-response-lifetime-');
    temporaryHomes.push(path);
    vi.stubEnv('HAPPIER_HOME_DIR', path);
    vi.stubEnv('HAPPIER_VOICE_AGENT_RESPONSE_TIMEOUT_MS', override);
    const { configuration, reloadConfiguration } = await import('./configuration');
    reloadConfiguration();
    expect(configuration.voiceAgentResponseTimeoutMs).toBe(override === undefined ? null : 240_000);
  });
});
