import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('bootstrapMachineSyncRuntime passive startup', () => {
  it('reconstructs usage-limit state without arming recovery timers', async () => {
    const source = await readFile(new URL('./bootstrapMachineSyncRuntime.ts', import.meta.url), 'utf8');
    expect(source).toContain('inactiveUsageLimitRecoveryScheduler.hydratePassive()');
    expect(source).not.toContain('inactiveUsageLimitRecoveryScheduler.hydrate();');
  });

  it('keeps the speech-transcription peer media consumer wired into the relay terminator', async () => {
    const source = await readFile(new URL('./bootstrapMachineSyncRuntime.ts', import.meta.url), 'utf8');
    expect(source).toContain('voiceBinaryAppendConsumer');
  });
});
