import { describe, expect, it } from 'vitest';

import { SpawnDaemonSessionRequestSchema } from './spawnSessionOptionsContract';

describe('SpawnDaemonSessionRequestSchema', () => {
  it('accepts Windows terminal modes in the terminal payload', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
    });

    expect(parsed.terminal?.mode).toBe('windows_terminal');
    expect(parsed.windowsRemoteSessionLaunchMode).toBe('windows_terminal');
  });

  it('maps legacy experimentalCodexAcp requests onto canonical codexBackendMode', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: true,
    });

    expect(parsed.codexBackendMode).toBe('acp');
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('drops legacy experimentalCodexAcp when false', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      experimentalCodexAcp: false,
    });

    expect(parsed.codexBackendMode).toBeUndefined();
    expect(parsed).not.toHaveProperty('experimentalCodexAcp');
  });

  it('preserves canonical codex backend mode from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      codexBackendMode: 'appServer',
    });

    expect(parsed.codexBackendMode).toBe('appServer');
  });

  it('accepts attach metadata identity policy from the transport request', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
    });

    expect(parsed.attachMetadataIdentityPolicy).toBe('replace_with_runtime_identity');
  });
});
