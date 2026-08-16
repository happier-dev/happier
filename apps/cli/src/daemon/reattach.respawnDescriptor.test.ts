import { describe, expect, it } from 'vitest';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { resolve } from 'node:path';

import { hashProcessCommand } from './sessionRegistry';
import type { TrackedSession } from './types';
import type { HappyProcessInfo } from './doctor';

import { adoptSessionsFromMarkers } from './reattach';
import type { SessionRunnerRespawnDescriptorV1 } from './processSupervision/sessionRunnerRespawnDescriptor';
import { resolveSessionRunnerRestartEligibility } from './sessionRunnerRuntime/resolveRestartEligibility';
import type { Credentials } from '@/persistence';

describe('adoptSessionsFromMarkers respawn descriptor', () => {
  it('adopts a classified runner with command drift when its process-instance fingerprint matches', () => {
    const markerCommand = 'happier plugins list --json';
    const runningCommand = 'happier claude --resume sess-existing';
    const marker = {
      pid: 121,
      happySessionId: 'sess-process-instance',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'terminal' as const,
      processCommandHash: hashProcessCommand(markerCommand),
      processInstanceFingerprint: 'linux-proc:12100',
      processCommand: markerCommand,
    };
    const map = new Map<number, TrackedSession>();

    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 121, command: runningCommand, type: 'user-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
      readProcessInstanceFingerprint: () => 'linux-proc:12100',
    });

    expect(adopted).toBe(1);
    expect(map.get(121)).toMatchObject({
      processCommandHash: hashProcessCommand(runningCommand),
      processInstanceFingerprint: 'linux-proc:12100',
    });
  });

  it('restores the exact active turn from the adopted runner marker without inference', () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;
    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [{
        pid: 122,
        happySessionId: 'sess-active-turn',
        happyHomeDir: '/tmp/happy-home',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        startedBy: 'daemon',
        processCommandHash: hashProcessCommand(command),
        processCommand: command,
        activeTurnId: 'session-turn:restored-exact',
      }],
      happyProcesses: [{ pid: 122, command, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(122)?.activeTurnId).toBe('session-turn:restored-exact');
  });

  it('hydrates spawnOptions when marker includes respawn descriptor', () => {
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
        version: 1 as const,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        resume: 'vendor-sess-123',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CODEX_HOME: '/tmp/codex-home',
        },
        terminal: { mode: 'plain' },
        transcriptStorage: 'direct',
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 123, command, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(123)?.reattachedFromDiskMarker).toBe(true);
    expect(map.get(123)?.processCommand).toBe(command);
    expect(map.get(123)?.spawnOptions).toMatchObject({
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      resume: 'vendor-sess-123',
      environmentVariables: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        CODEX_HOME: '/tmp/codex-home',
      },
      terminal: { mode: 'plain' },
      transcriptStorage: 'direct',
    });
  });

  it('applies marker metadata runtime snapshot when hydrating respawn descriptor spawn options', () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;
    const markerConnectedServices = {
      v: 1,
      bindingsByServiceId: {
        'openai-codex': {
          source: 'connected',
          selection: 'profile',
          profileId: 'fresh-profile',
        },
      },
    } as const;
    const marker = {
      pid: 124,
      happySessionId: 'sess-124',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: {
        path: '/tmp/workspace',
        hostPid: 124,
        connectedServices: markerConnectedServices,
        connectedServicesUpdatedAt: 500,
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 510,
        modelOverrideV1: { v: 1, modelId: 'gpt-5.1-codex', updatedAt: 520 },
      },
      respawn: {
        version: 1 as const,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        connectedServices: { v: 1, bindingsByServiceId: {} },
        connectedServicesUpdatedAt: 100,
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 124, command, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(124)?.spawnOptions).toMatchObject({
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      connectedServices: markerConnectedServices,
      connectedServicesUpdatedAt: 500,
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 510,
      modelId: 'gpt-5.1-codex',
      modelUpdatedAt: 520,
    });
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
      happyProcesses: [{ pid: 234, command, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
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
        version: 1 as const,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        experimentalCodexAcp: true,
      } satisfies Partial<SessionRunnerRespawnDescriptorV1> & { experimentalCodexAcp: true },
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 345, command, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(345)?.spawnOptions).toMatchObject({
      directory: '/tmp/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
      codexBackendMode: 'acp',
    });
    expect(map.get(345)?.spawnOptions).not.toHaveProperty('experimentalCodexAcp');
  });

  it('rehydrates encrypted respawn environment variables when credentials are available', () => {
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;
    const marker = {
      pid: 456,
      happySessionId: 'sess-456',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: { path: '/tmp/workspace', hostPid: 456 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        environmentVariables: {
          CODEX_HOME: '/tmp/codex-home',
        },
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext: sealAccountScopedBlobCiphertext({
            kind: 'session_respawn_environment',
            material: credentials.encryption,
            payload: {
              CODEX_HOME: '/tmp/codex-home',
              OPENAI_API_KEY: 'sk-test',
            },
            randomBytes: (length) => new Uint8Array(length).fill(4),
          }),
        },
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 456, command, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
      credentials,
    });

    expect(adopted).toBe(1);
    expect(map.get(456)?.spawnOptions).toMatchObject({
      directory: '/tmp/workspace',
      environmentVariables: {
        CODEX_HOME: '/tmp/codex-home',
        OPENAI_API_KEY: 'sk-test',
      },
    });
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
      happyProcesses: [{ pid: 567, command: runningCommand, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
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
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 678, command: 'node', type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
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
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 679, command: 'node', type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(679)?.happySessionId).toBe('sess-679');
    expect(map.get(679)?.reattachedFromDiskMarker).toBe(true);
  });

  it('adopts daemon-started respawn markers when process classification degrades to user-session during takeover', () => {
    const markerCommand = 'happier claude --happy-starting-mode remote --started-by daemon';
    const marker = {
      pid: 680,
      happySessionId: 'sess-680',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(markerCommand),
      processCommand: markerCommand,
      metadata: { path: '/tmp/workspace', hostPid: 680 },
      respawn: {
        version: 1,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 680, command: 'node', type: 'user-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(680)?.happySessionId).toBe('sess-680');
    expect(map.get(680)?.reattachedFromDiskMarker).toBe(true);
  });

  it('restores vendorResumeId from the respawn descriptor so restart eligibility survives adoption', () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)" --happy-starting-mode remote --started-by daemon`;
    const marker = {
      pid: 781,
      happySessionId: 'sess-781',
      happyHomeDir: '/tmp/happy-home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedBy: 'daemon' as const,
      cwd: '/tmp/workspace',
      processCommandHash: hashProcessCommand(command),
      processCommand: command,
      metadata: { path: '/tmp/workspace', hostPid: 781 },
      respawn: {
        version: 1 as const,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        vendorResumeId: 'vendor-sess-781',
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 781, command, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(781)?.vendorResumeId).toBe('vendor-sess-781');
    expect(resolveSessionRunnerRestartEligibility(map.get(781)).eligible).toBe(true);
  });

  it('backfills vendorResumeId from live argv when the descriptor lacks resume identity', () => {
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
        version: 1 as const,
        directory: '/tmp/workspace',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      } satisfies SessionRunnerRespawnDescriptorV1,
    };

    const map = new Map<number, TrackedSession>();
    const { adopted } = adoptSessionsFromMarkers({
      markers: [marker],
      happyProcesses: [{ pid: 782, command, type: 'daemon-spawned-session' } satisfies HappyProcessInfo],
      pidToTrackedSession: map,
    });

    expect(adopted).toBe(1);
    expect(map.get(782)?.vendorResumeId).toBe('vendor-argv-782');
    expect(resolveSessionRunnerRestartEligibility(map.get(782)).eligible).toBe(true);
  });
});
