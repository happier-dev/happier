import { describe, expect, it } from 'vitest';

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';

import { buildInactiveSessionResumeSpawnOptions } from './buildInactiveSessionResumeSpawnOptions';

function rawSession(overrides: Partial<RawSessionRecord> = {}): RawSessionRecord {
  // RawSessionRecord is a protocol fixture; this builder only reads path and machineId.
  return {
    id: 'session-1',
    path: '/repo/session',
    machineId: 'machine-1',
    ...overrides,
  } as RawSessionRecord;
}

function build(metadata: Record<string, unknown>) {
  return buildInactiveSessionResumeSpawnOptions({
    sessionId: 'session-1',
    fallbackMachineId: 'fallback-machine',
    rawSession: rawSession(),
    metadata,
  });
}

const codexRuntimeDescriptor = {
  v: 1,
  providerId: 'codex',
  provider: { backendMode: 'mcp', vendorSessionId: 'codex-vendor-1' },
} as const;

describe('buildInactiveSessionResumeSpawnOptions', () => {
  it('resumes a flavor-identified session that still carries a stale foreign resume key', () => {
    expect(build({
      flavor: 'codex',
      codexSessionId: 'codex-vendor-1',
      claudeSessionId: 'stale-claude-1',
    })).toMatchObject({
      existingSessionId: 'session-1',
      machineId: 'machine-1',
      directory: '/repo/session',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      approvedNewDirectoryCreation: true,
    });
  });

  it('resumes a runtime-descriptor-declared session that still carries a stale foreign resume key', () => {
    expect(build({
      agentRuntimeDescriptorV1: codexRuntimeDescriptor,
      codexSessionId: 'codex-vendor-1',
      claudeSessionId: 'stale-claude-1',
    })).toMatchObject({
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      agentRuntimeDescriptorV1: expect.objectContaining({ providerId: 'codex' }),
    });
  });

  it('resumes a session identified by exactly one flat vendor resume key', () => {
    expect(build({ claudeSessionId: 'claude-vendor-1' })).toMatchObject({
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
    });
  });

  it('fails closed when several flat vendor resume keys have no higher authority', () => {
    expect(build({
      claudeSessionId: 'claude-vendor-1',
      codexSessionId: 'codex-vendor-1',
    })).toBeNull();
  });

  it('fails closed when a declared runtime descriptor contradicts the resolved identity', () => {
    expect(build({
      agentRuntimeDescriptorV1: { v: 1, providerId: 'gemini', provider: {} },
      claudeSessionId: 'claude-vendor-1',
    })).toBeNull();
  });

  it('fails closed when the persisted runtime descriptor is malformed', () => {
    expect(build({
      flavor: 'codex',
      agentRuntimeDescriptorV1: { providerId: 'codex' },
    })).toBeNull();
  });

  it('preserves a configured ACP backend that carries no built-in Agent evidence', () => {
    expect(build({
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: 100,
        backendId: 'custom-kiro',
        title: 'Custom Kiro',
      },
    })).toMatchObject({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
    });
  });

  it('preserves a configured ACP backend persisted with its generic ACP flavor', () => {
    expect(build({
      flavor: 'acp:custom-kiro',
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: 100,
        backendId: 'custom-kiro',
        title: 'Custom Kiro',
      },
    })).toMatchObject({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-kiro' },
    });
  });

  it('fails closed when a configured ACP backend also carries built-in Agent evidence', () => {
    expect(build({
      acpConfiguredBackendV1: {
        v: 1,
        updatedAt: 100,
        backendId: 'custom-kiro',
        title: 'Custom Kiro',
      },
      claudeSessionId: 'claude-vendor-1',
    })).toBeNull();
  });

  it('fails closed when a present configured-backend key is invalid', () => {
    expect(build({
      acpConfiguredBackendV1: { v: 1, backendId: 'custom-kiro' },
      flavor: 'codex',
    })).toBeNull();
  });

  it('fails closed when persisted directory identities disagree', () => {
    expect(buildInactiveSessionResumeSpawnOptions({
      sessionId: 'session-1',
      fallbackMachineId: 'fallback-machine',
      rawSession: rawSession({ path: '/repo/one' }),
      metadata: { flavor: 'codex', codexSessionId: 'codex-vendor-1', path: '/repo/two' },
    })).toBeNull();
  });

  it('fails closed when persisted machine identities disagree', () => {
    expect(buildInactiveSessionResumeSpawnOptions({
      sessionId: 'session-1',
      fallbackMachineId: 'fallback-machine',
      rawSession: rawSession({ machineId: 'machine-1' }),
      metadata: { flavor: 'codex', codexSessionId: 'codex-vendor-1', machineId: 'machine-2' },
    })).toBeNull();
  });
});
