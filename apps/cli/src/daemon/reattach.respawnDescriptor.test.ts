import { describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { resolve } from 'node:path';

import { hashProcessCommand } from './sessionRegistry';
import type { TrackedSession } from './types';
import type { Credentials } from '@/persistence';

import { adoptSessionsFromMarkers } from './reattach';
import type { SessionRunnerRespawnDescriptorV1 } from './processSupervision/sessionRunnerRespawnDescriptor';

describe('adoptSessionsFromMarkers respawn descriptor', () => {
  it('does not represent a surviving Agent-runtime marker as usable or its interrupted turn as active', () => {
    const command = 'happier grok --happy-starting-mode remote --started-by daemon';
    const marker = {
      pid: 119,
      happySessionId: 'sess-agent-runtime-restart',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      activeTurnId: 'native-turn-1',
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend' as const, backendId: 'grok', sourceKind: 'built_in' as const },
      },
    };
    const map = new Map<number, TrackedSession>();

    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker as never],
      happyProcesses: [{
        pid: marker.pid,
        command,
        type: 'daemon-spawned-session',
      } as never],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(marker.pid)).toMatchObject({
      happySessionId: marker.happySessionId,
      reattachedFromDiskMarker: true,
      reattachedInterruptedTurnId: 'native-turn-1',
    });
    expect(map.get(marker.pid)).not.toHaveProperty('activeTurnId');
  });

  it('does not treat an invalid respawn descriptor as cli-update hash-drift ownership proof', () => {
    const markerCommand = 'happier codex --happy-starting-mode remote --started-by daemon';
    const marker = {
      pid: 120,
      happySessionId: 'sess-invalid-respawn',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(markerCommand),
      processCommand: markerCommand,
      respawn: {
        version: 999,
        directory: '/tmp/workspace',
      },
    };
    const map = new Map<number, TrackedSession>();

    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker as never],
      happyProcesses: [{ pid: marker.pid, command: 'node', type: 'daemon-spawned-session' } as never],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(0);
    expect(map.has(marker.pid)).toBe(false);
  });

  it('restores exact Provider continuity from the current descriptor during cli-update takeover', () => {
    const markerCommand = 'happier codex --happy-starting-mode remote --started-by daemon';
    const providerBindingMetadataV1 = {
      v: 1 as const,
      connectionId: 'pc_gateway' as const,
      contributionKey: 'plugin.gateway/gateway',
      connectionRevision: 2,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'gateway',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'Gateway',
        connectionName: 'Work',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const modelSelection = {
      v: 1 as const,
      updatedAt: 9,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: providerBindingMetadataV1.connectionId,
        modelId: 'vendor/model',
      },
    };
    const marker = {
      pid: 121,
      happySessionId: 'sess-provider-respawn',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(markerCommand),
      processCommand: markerCommand,
      respawn: {
        version: 2,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
        modelSelection,
        providerBindingMetadataV1,
      },
    };
    const map = new Map<number, TrackedSession>();

    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker as never],
      happyProcesses: [{ pid: marker.pid, command: 'node', type: 'daemon-spawned-session' } as never],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(marker.pid)?.spawnOptions).toMatchObject({
      modelSelection,
      providerBindingMetadataV1,
    });
  });

  it('hydrates spawnOptions when marker includes respawn descriptor with sealed env continuity', () => {
    const credentials: Credentials = {
      token: 't',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array(32).fill(5),
        machineKey: new Uint8Array(32).fill(9),
      },
    };
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;
    const marker = {
      pid: 123,
      happySessionId: 'sess-123',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: { path: '/tmp/workspace', hostPid: 123 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'vendor-sess-123',
        vendorResumeId: 'stale-runtime-learned-id',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CODEX_HOME: '/tmp/codex-home',
        },
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext: sealAccountScopedBlobCiphertext({
            kind: 'session_respawn_environment',
            material: credentials.encryption,
            payload: {
              CLAUDE_CONFIG_DIR: '/tmp/claude-config',
              CODEX_HOME: '/tmp/codex-home',
              OPENAI_API_KEY: 'sk-secret',
            },
            randomBytes: (length) => new Uint8Array(length).fill(4),
          }),
        },
        terminal: { mode: 'plain' },
        transcriptStorage: 'direct',
      } as any,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = (adoptSessionsFromMarkers as unknown as (
      params: Parameters<typeof adoptSessionsFromMarkers>[0] & { credentials?: Credentials | null },
    ) => ReturnType<typeof adoptSessionsFromMarkers>)({
      markers: [marker],
      happyProcesses: [{ pid: 123, command, type: 'daemon-spawned-session' } as any],
      pidToTrackedSession: map,
      credentials,
    });

    expect(adopted).toBe(1);
    expect(map.get(123)?.reattachedFromDiskMarker).toBe(true);
    expect(map.get(123)?.happySessionMetadataFromLocalWebhook).toEqual(marker.metadata);
    expect(map.get(123)?.spawnOptions).toMatchObject({
      directory: '/tmp/workspace',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      resume: 'vendor-sess-123',
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'sk-secret',
      },
      terminal: { mode: 'plain' },
      transcriptStorage: 'direct',
    });
    expect(map.get(123)?.vendorResumeId).toBe('vendor-sess-123');
  });

  it('refuses complete-marker adoption when newer metadata would downgrade Provider V2 continuity to native', () => {
    const markerCommand = 'happier codex --happy-starting-mode remote --started-by daemon';
    const providerBindingMetadataV1 = {
      v: 1 as const,
      connectionId: 'pc_gateway' as const,
      contributionKey: 'plugin.gateway/gateway',
      connectionRevision: 2,
      protocol: 'openai-responses' as const,
      materialization: 'engineConfig' as const,
      adapterBindingKey: 'gateway',
      compatibilityFingerprint: 'compatibility-v1',
      bindingSecurityFingerprint: 'security-v1',
      displaySnapshot: {
        providerName: 'Gateway',
        connectionName: 'Work',
        connectionRole: 'named' as const,
        connectionDisplayNameMode: 'custom' as const,
      },
    };
    const marker = {
      pid: 122,
      happySessionId: 'sess-provider-downgrade',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(markerCommand),
      processCommand: markerCommand,
      metadata: {
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 10,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: null,
            modelId: 'native-newer',
          },
        },
      },
      respawn: {
        version: 2,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
        modelSelection: {
          v: 1 as const,
          updatedAt: 9,
          ref: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: providerBindingMetadataV1.connectionId,
            modelId: 'provider/model',
          },
        },
        providerBindingMetadataV1,
      },
    };
    const map = new Map<number, TrackedSession>();

    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker as never],
      happyProcesses: [{ pid: marker.pid, command: markerCommand, type: 'daemon-spawned-session' } as never],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(0);
    expect(map.has(marker.pid)).toBe(false);
  });

  it('refuses complete-marker adoption when persisted Provider binding metadata is malformed', () => {
    const markerCommand = 'happier codex --happy-starting-mode remote --started-by daemon';
    const marker = {
      pid: 124,
      happySessionId: 'sess-provider-malformed-binding',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(markerCommand),
      processCommand: markerCommand,
      metadata: {
        providerBindingV1: { v: 1, connectionId: 'pc_gateway' },
        modelSelectionIntentV1: {
          v: 1,
          updatedAt: 10,
          selection: {
            agentTargetKey: 'backend:codex',
            providerConnectionId: 'pc_gateway',
            modelId: 'provider/model',
          },
        },
      },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend' as const, backendId: 'codex', sourceKind: 'built_in' as const },
      },
    };
    const map = new Map<number, TrackedSession>();

    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker as never],
      happyProcesses: [{ pid: marker.pid, command: markerCommand, type: 'daemon-spawned-session' } as never],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(0);
    expect(map.has(marker.pid)).toBe(false);
  });

  it('keeps reattach non-fatal when respawn restore fails', () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;
    const marker = {
      pid: 222,
      happySessionId: 'sess-222',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: { path: '/tmp/workspace', hostPid: 222 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext: 'not-decryptable',
        },
      } as any,
    };

    const map = new Map<number, TrackedSession>();
    expect(() => {
      (adoptSessionsFromMarkers as unknown as (
        params: Parameters<typeof adoptSessionsFromMarkers>[0] & { credentials?: Credentials | null },
      ) => ReturnType<typeof adoptSessionsFromMarkers>)({
        markers: [marker],
        happyProcesses: [{ pid: 222, command, type: 'daemon-spawned-session' } as any],
        pidToTrackedSession: map,
      });
    }).not.toThrow();

    expect(map.get(222)).toMatchObject({
      reattachedFromDiskMarker: true,
      pid: 222,
      happySessionId: 'sess-222',
      spawnOptions: {
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      },
    });
    expect(map.get(222)?.spawnOptions).not.toHaveProperty('environmentVariables');
  });

  it('does not set spawnOptions when marker does not include respawn descriptor', () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;
    const marker = {
      pid: 234,
      happySessionId: 'sess-234',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'terminal' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: { path: '/tmp/workspace', hostPid: 234 },
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 234, command, type: 'daemon-spawned-session' } as any],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(234)?.spawnOptions).toBeUndefined();
  });

  it('rehydrates legacy respawn descriptors onto canonical codexBackendMode for daemon restarts', () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;
    const marker = {
      pid: 345,
      happySessionId: 'sess-345',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: { path: '/tmp/workspace', hostPid: 345 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        experimentalCodexAcp: true,
      } as any,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 345, command, type: 'daemon-spawned-session' } as any],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(345)?.spawnOptions).toMatchObject({
      directory: '/tmp/workspace',
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      codexBackendMode: 'acp',
    });
    expect(map.get(345)?.spawnOptions).not.toHaveProperty('experimentalCodexAcp');
  });

  it('adopts daemon-started markers when command hash drifts but both commands are owned live daemon session commands', () => {
    const runtimeEntrypoint = resolve(process.cwd(), 'dist', 'index.mjs');
    const markerCommand = `${process.execPath} ${runtimeEntrypoint} claude --happy-starting-mode remote --started-by daemon`;
    const runningCommand = `${process.execPath} ${runtimeEntrypoint} claude --happy-starting-mode remote --started-by daemon --existing-session sess-567`;
    const marker = {
      pid: 567,
      happySessionId: 'sess-567',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(markerCommand),
      processCommand: markerCommand,
      metadata: { path: '/tmp/workspace', hostPid: 567 },
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 567, command: runningCommand, type: 'daemon-spawned-session' } as any],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(567)?.happySessionId).toBe('sess-567');
    expect(map.get(567)?.reattachedFromDiskMarker).toBe(true);
  });

  it('adopts daemon-started markers with respawn descriptors when the live command hash drifts and runtime command identity is degraded', () => {
    const runtimeEntrypoint = resolve(process.cwd(), '.project', 'tmp', 'cli-dist-snapshot', 'src', 'index.ts');
    const markerCommand = `${process.execPath} ${runtimeEntrypoint} claude --happy-starting-mode remote --started-by daemon`;
    const marker = {
      pid: 678,
      happySessionId: 'sess-678',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(markerCommand),
      processCommand: markerCommand,
      metadata: { path: '/tmp/workspace', hostPid: 678 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      } as any,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 678, command: 'node', type: 'daemon-spawned-session' } as any],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(678)?.happySessionId).toBe('sess-678');
    expect(map.get(678)?.reattachedFromDiskMarker).toBe(true);
  });

  it('adopts daemon-started respawn markers during cli-update takeover when marker command is non-owned and live command identity is degraded', () => {
    const markerCommand = 'happier claude --happy-starting-mode remote --started-by daemon';
    const marker = {
      pid: 679,
      happySessionId: 'sess-679',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(markerCommand),
      processCommand: markerCommand,
      metadata: { path: '/tmp/workspace', hostPid: 679 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      } as any,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 679, command: 'node', type: 'daemon-spawned-session' } as any],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(679)?.happySessionId).toBe('sess-679');
    expect(map.get(679)?.reattachedFromDiskMarker).toBe(true);
  });

  it('backfills vendor resume identity from live argv when a legacy descriptor lacks it', () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)" --resume vendor-argv-782 --happy-starting-mode remote --started-by daemon`;
    const marker = {
      pid: 782,
      happySessionId: 'sess-782',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: { path: '/tmp/workspace', hostPid: 782 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 782, command, type: 'daemon-spawned-session' } as any],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(782)?.vendorResumeId).toBe('vendor-argv-782');
  });

  it('restores vendor identity from the predecessor V1 descriptor when spawn argv has no resume', () => {
    // Provenance: current dirty ../remote-dev descriptor/reattach contract at
    // HEAD 490a27a7435b414f9c70e82b1774f416d180f6bd, inspected 2026-07-13.
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)" --happy-starting-mode remote --started-by daemon`;
    const marker = {
      pid: 783,
      happySessionId: 'sess-783',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: { path: '/tmp/workspace', hostPid: 783 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        vendorResumeId: 'remote-runtime-learned-783',
      },
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker as never],
      happyProcesses: [{ pid: 783, command, type: 'daemon-spawned-session' } as never],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(783)?.vendorResumeId).toBe('remote-runtime-learned-783');
    expect(map.get(783)?.spawnOptions?.resume).toBeUndefined();
  });
});
