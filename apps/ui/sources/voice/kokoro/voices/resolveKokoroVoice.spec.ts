import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { KOKORO_WEB_DEFAULT_VOICE_ID, resolveKokoroWebVoiceId } from './resolveKokoroVoice';

describe('resolveKokoroWebVoiceId', () => {
  it('keeps catalog voices and falls back to the kokoro-js default otherwise', () => {
    expect(resolveKokoroWebVoiceId('af_bella', ['af_heart', 'af_bella'])).toBe('af_bella');
    expect(resolveKokoroWebVoiceId('af_maple', ['af_heart', 'af_bella'])).toBe(KOKORO_WEB_DEFAULT_VOICE_ID);
    expect(resolveKokoroWebVoiceId(null, ['af_heart'])).toBe(KOKORO_WEB_DEFAULT_VOICE_ID);
  });

  it('shares its voice selection policy with the vendored web worker', async () => {
    const workerUrl = new URL('../../../../public/vendor/kokoro/kokoroTtsWorker.js', import.meta.url);
    const workerSource = fs.readFileSync(workerUrl, 'utf8');
    const sharedImport = workerSource.match(/import\s*\{\s*resolveKokoroWebVoiceId\s*\}\s*from\s*['"]([^'"]+)['"]/);
    expect(sharedImport).not.toBeNull();
    if (!sharedImport) return;

    // Follow the worker's actual dependency, rather than accepting a second matching default.
    const sharedUrl = new URL(sharedImport[1]!, workerUrl);
    const sharedPolicy: Pick<typeof import('./resolveKokoroVoice'), 'resolveKokoroWebVoiceId'> = await import(/* @vite-ignore */ sharedUrl.href);
    expect(sharedPolicy.resolveKokoroWebVoiceId).toBe(resolveKokoroWebVoiceId);
  });
});
