import { describe, expect, it } from 'vitest';

import {
  normalizeNativeSshAuthPromptEvent,
  normalizeNativeSshHostKeyPromptEvent,
  normalizeNativeSshProgressEvent,
} from './events';

describe('native SSH event normalization', () => {
  it('requires host-key prompt events to include the originating request id', () => {
    expect(normalizeNativeSshHostKeyPromptEvent({
      requestId: 'request-1',
      promptId: 'prompt-1',
      host: '10.0.0.5',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:abc',
      status: 'unknown',
    })).toEqual({
      requestId: 'request-1',
      promptId: 'prompt-1',
      host: '10.0.0.5',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:abc',
      status: 'unknown',
    });

    expect(normalizeNativeSshHostKeyPromptEvent({
      promptId: 'prompt-1',
      host: '10.0.0.5',
      port: 22,
      algorithm: 'ssh-ed25519',
      fingerprintSha256: 'SHA256:abc',
      status: 'unknown',
    })).toBeNull();
  });

  it('requires progress events to include the originating request id', () => {
    expect(normalizeNativeSshProgressEvent({
      requestId: 'request-1',
      phase: 'connecting',
      host: '10.0.0.5',
      port: 22,
    })).toEqual({
      requestId: 'request-1',
      phase: 'connecting',
      host: '10.0.0.5',
      port: 22,
    });

    expect(normalizeNativeSshProgressEvent({
      phase: 'connecting',
      host: '10.0.0.5',
      port: 22,
    })).toBeNull();
  });

  it('normalizes private-key passphrase and keyboard-interactive auth prompts', () => {
    expect(normalizeNativeSshAuthPromptEvent({
      requestId: 'request-1',
      promptId: 'auth-1',
      kind: 'private-key-passphrase',
      host: 'example.test',
      port: 22,
      username: 'dev',
      attemptsRemaining: 2,
    })).toEqual({
      requestId: 'request-1',
      promptId: 'auth-1',
      kind: 'private-key-passphrase',
      host: 'example.test',
      port: 22,
      username: 'dev',
      attemptsRemaining: 2,
    });

    expect(normalizeNativeSshAuthPromptEvent({
      requestId: 'request-2',
      promptId: 'auth-2',
      kind: 'keyboard-interactive',
      host: 'example.test',
      port: 22,
      username: 'dev',
      prompts: [
        { id: '0', label: 'OTP', echo: false },
        { id: '', label: 'invalid', echo: false },
      ],
    })).toEqual({
      requestId: 'request-2',
      promptId: 'auth-2',
      kind: 'keyboard-interactive',
      host: 'example.test',
      port: 22,
      username: 'dev',
      prompts: [{ id: '0', label: 'OTP', echo: false }],
    });
  });
});
