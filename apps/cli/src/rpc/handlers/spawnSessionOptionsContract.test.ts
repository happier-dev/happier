import { describe, expect, it } from 'vitest';

import { SpawnDaemonSessionRequestSchema } from './spawnSessionOptionsContract';

describe('SpawnDaemonSessionRequestSchema', () => {
  it('canonicalizes legacy built-in agent field into backendTarget when backendTarget is missing', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      agent: 'codex',
    });

    expect(parsed.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'codex',
      sourceKind: 'built_in',
    });
  });

  it('rejects unknown legacy built-in agent field when backendTarget is missing', () => {
    expect(() =>
      SpawnDaemonSessionRequestSchema.parse({
        directory: '/tmp',
        agent: 'not-a-real-agent',
      }),
    ).toThrow();
  });

  it('rejects legacy customAcp built-in agent field when backendTarget is missing', () => {
    expect(() =>
      SpawnDaemonSessionRequestSchema.parse({
        directory: '/tmp',
        agent: 'customAcp',
      }),
    ).toThrow();
  });

  it('rejects built-in backendTarget when agentId is customAcp', () => {
    expect(() =>
      SpawnDaemonSessionRequestSchema.parse({
        directory: '/tmp',
        backendTarget: { kind: 'builtInAgent', agentId: 'customAcp' },
      }),
    ).toThrow();
  });

  it('accepts V2 backendTarget input and preserves the canonical backend transport shape', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        configuredBackendId: 'review-bot',
        sourceKind: 'configured',
      },
    });

    expect(parsed.backendTarget).toEqual({
      kind: 'backend',
      backendId: 'review-bot',
      configuredBackendId: 'review-bot',
      sourceKind: 'configured',
    });
  });

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
