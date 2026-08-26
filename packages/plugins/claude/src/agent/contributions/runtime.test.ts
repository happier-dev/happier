import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  CLAUDE_AGENT_RUNTIME_CONTRIBUTION,
  materializeClaudeAuthEnvironment,
  verifyClaudeResumeReachability,
} from './runtime.js';
import { shouldUseClaudeDeferredBootstrap } from '../lifecycle/deferredStartup.js';
import {
  CLAUDE_AGENT_RUNTIME_CONTRIBUTION as CATALOG_CLAUDE_AGENT_RUNTIME_CONTRIBUTION,
  materializeClaudeAuthEnvironment as materializeCatalogClaudeAuthEnvironment,
} from './catalog.js';

function currentClaudeTranscriptStart(sessionId: string): string {
  return `${[
    {
      type: 'last-prompt',
      leafUuid: 'leaf-uuid',
      sessionId,
    },
    {
      type: 'mode',
      mode: 'normal',
      sessionId,
    },
    {
      type: 'permission-mode',
      permissionMode: 'auto',
      sessionId,
    },
    {
      parentUuid: null,
      isSidechain: false,
      type: 'system',
      subtype: 'informational',
      content: 'Claude permission mode notice',
      timestamp: '2026-06-14T00:00:00.000Z',
      uuid: 'system-uuid',
      sessionId,
      version: '2.1.177',
    },
    {
      parentUuid: 'system-uuid',
      isSidechain: false,
      type: 'user',
      message: {
        role: 'user',
        content: 'continue',
      },
      uuid: 'user-uuid',
      timestamp: '2026-06-14T00:00:01.000Z',
      sessionId,
      version: '2.1.177',
    },
  ].map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function legacyClaudeTranscriptStart(sessionId: string): string {
  return `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    timestamp: '2026-06-14T00:00:00.000Z',
  })}\n`;
}

describe('Claude runtime contribution', () => {
  it('keeps the legacy runtime entrypoint aligned with the static catalog leaf', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION).toBe(CATALOG_CLAUDE_AGENT_RUNTIME_CONTRIBUTION);
    expect(materializeClaudeAuthEnvironment).toBe(materializeCatalogClaudeAuthEnvironment);
  });

  it.each([
    {
      name: 'fresh terminal-local start',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        hasExistingSession: false,
        hasSessionAttachFile: false,
        hasProviderResumeId: false,
        hasExplicitPermissionMode: false,
        hasPersistedPermissionModeSeed: false,
        hasTerminalTty: false,
      },
      expected: true,
    },
    {
      name: 'eligible terminal-local Happier attach',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        hasExistingSession: true,
        hasSessionAttachFile: true,
        hasProviderResumeId: true,
        hasExplicitPermissionMode: true,
        hasPersistedPermissionModeSeed: false,
        hasTerminalTty: false,
      },
      expected: true,
    },
    {
      name: 'attach without an explicit permission seed',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        hasExistingSession: true,
        hasSessionAttachFile: true,
        hasProviderResumeId: true,
        hasExplicitPermissionMode: false,
        hasPersistedPermissionModeSeed: false,
        hasTerminalTty: true,
      },
      expected: false,
    },
    {
      name: 'daemon start',
      input: {
        startedBy: 'daemon' as const,
        startingMode: 'terminal' as const,
        hasExistingSession: false,
        hasSessionAttachFile: false,
        hasProviderResumeId: false,
        hasExplicitPermissionMode: true,
        hasPersistedPermissionModeSeed: false,
        hasTerminalTty: true,
      },
      expected: false,
    },
    {
      name: 'remote start',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'remote' as const,
        hasExistingSession: false,
        hasSessionAttachFile: false,
        hasProviderResumeId: false,
        hasExplicitPermissionMode: true,
        hasPersistedPermissionModeSeed: false,
        hasTerminalTty: true,
      },
      expected: false,
    },
  ])('keeps deferred startup eligibility at the public manifest leaf for $name', ({ input, expected }) => {
    expect(shouldUseClaudeDeferredBootstrap(input)).toBe(expected);
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('sessionStartup');
  });

  it('keeps only handoff metadata in the catalog contribution and has no predecessor goal adapter', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION.sessionHandoff).toEqual({
      runtimeLocalMetadata: {
        build: expect.any(Function),
      },
    });
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION.sessionHandoff).not.toHaveProperty('surface');
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION.runtimeControl).toBeUndefined();
  });

  // The Agent manifest's `capabilities.sessions.runtimeActivitySnapshots` is the
  // one Runtime Activity declaration seam (asserted in `manifest.test.ts`), so a
  // private duplicate here would be a second decision-maker for the same fact.
  it('leaves Runtime Activity to the public manifest capability', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('runtimeActivityApplicability');
  });

  it('does not retain the terminal overlay after prompt recognition moved to the manifest', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('terminal');
  });

  it('does not retain session preferences in the private runtime contribution', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('sessionRuntimePreferences');
  });

  it('contributes the provider-owned connected-services runtime auth adapter', () => {
    const connectedServices = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      connectedServices?: Readonly<{
        runtimeAuthAdapter?: unknown;
      }>;
    }>).connectedServices;

    expect(connectedServices?.runtimeAuthAdapter).toEqual(expect.objectContaining({
      canHotApply: expect.any(Function),
      verifyActiveAccount: expect.any(Function),
    }));
  });

  it('declares exact-origin Authorization request auth for native model observation only', () => {
    const connectedServices = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      connectedServices?: Readonly<{ requestAuthUses?: readonly unknown[] }>;
    }>).connectedServices;

    expect(connectedServices?.requestAuthUses).toEqual([{
      purpose: 'model_upstream',
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.anthropic.com',
        headerNames: ['authorization'],
      },
    }]);
    expect(JSON.stringify(connectedServices?.requestAuthUses)).not.toContain('x-api-key');
  });

  it('returns explicit booleans from the service-switch restart predicate', () => {
    const connectedServices = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      connectedServices?: Readonly<{
        shouldRestartForServiceSwitch?: (serviceId: unknown) => boolean;
        noRestartRequiredServiceIds?: readonly string[];
      }>;
    }>).connectedServices;

    expect(connectedServices?.shouldRestartForServiceSwitch?.({ serviceId: 'claude-subscription' })).toBe(true);
    expect(connectedServices?.shouldRestartForServiceSwitch?.({ serviceId: 'gemini' })).toBe(false);
    expect(connectedServices?.shouldRestartForServiceSwitch?.(null)).toBe(false);
    expect(connectedServices?.noRestartRequiredServiceIds).toEqual(['claude-subscription']);
  });

  it('advertises shared-group live soft switching without claiming in-turn exact runtime identity', () => {
    const connectedServices = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      connectedServices?: Readonly<{
        recoveryCapabilities?: unknown;
      }>;
    }>).connectedServices;

    expect(connectedServices?.recoveryCapabilities).toMatchObject({
      predictiveSoftSwitch: {
        mode: 'supported',
        liveSessionRequirement: {
          kind: 'shared_group_auth_surface',
          serviceIds: ['claude-subscription'],
          authEnvKey: 'CLAUDE_CONFIG_DIR',
          authEnvSubpath: ['claude-config'],
        },
      },
      sameAccountFanoutStrategy: 'shared_group_auth_surface',
      generationApplicationScope: 'shared_group_auth_surface',
      sharedGenerationApplicationServiceIds: ['claude-subscription'],
      runtimeAuthApply: {
        directLiveHotAuth: {
          supportsInTurnApply: false,
          requiresExactRuntimeIdentity: false,
          refreshSelectionResync: 'not_applicable',
          authMode: {
            kind: 'provider_owned',
            name: 'claude_shared_group_auth_surface',
          },
        },
      },
    });
  });

  it('does not duplicate static CLI command parsing in the runtime catalog contribution', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION).not.toHaveProperty('cliSessionCommand');
  });

  it('prepares qualified-purpose state without writing legacy credential bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-qualified-purpose-root-'));
    try {
      await expect(materializeClaudeAuthEnvironment({
        rootDir: root,
        sessionDirectory: root,
        processEnv: {},
        connectedAccountMaterializationAuthority: 'qualified',
        claudeSubscription: {
          kind: 'oauth',
          serviceId: 'claude-subscription',
          profileId: 'legacy-profile',
          oauth: {
            accessToken: 'legacy-access',
            refreshToken: 'legacy-refresh',
            expiresAt: Date.now() + 60_000,
          },
        },
      })).resolves.toEqual({
        env: { CLAUDE_CONFIG_DIR: root },
      });
      await expect(stat(join(root, '.credentials.json'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('leaves a qualified Anthropic group binding to the canonical Connected Accounts owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-qualified-anthropic-root-'));
    try {
      await expect(materializeClaudeAuthEnvironment({
        rootDir: root,
        sessionDirectory: root,
        processEnv: {},
        connectedAccountMaterializationAuthority: 'qualified',
        anthropic: {
          kind: 'token',
          serviceId: 'anthropic',
          profileId: 'legacy-profile',
          token: {
            token: 'legacy-anthropic-key',
          },
        },
      })).resolves.toEqual({
        env: { CLAUDE_CONFIG_DIR: root },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('materializes raw Anthropic credentials only for the exact legacy one-shot authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-legacy-one-shot-root-'));
    try {
      await expect(materializeClaudeAuthEnvironment({
        rootDir: root,
        sessionDirectory: root,
        processEnv: {},
        connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
        anthropic: buildConnectedServiceCredentialRecord({
          now: 10,
          serviceId: 'anthropic',
          profileId: 'legacy-profile',
          kind: 'token',
          token: {
            token: 'legacy-anthropic-key',
            providerAccountId: null,
            providerEmail: null,
          },
        }),
      })).resolves.toEqual({
        env: {
          ANTHROPIC_API_KEY: 'legacy-anthropic-key',
          CLAUDE_CONFIG_DIR: root,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: 'missing authority',
      input: {},
    },
    {
      name: 'unknown authority',
      input: { connectedAccountMaterializationAuthority: 'unqualified' },
    },
    {
      name: 'legacy one-shot combined with request auth',
      input: {
        connectedAccountMaterializationAuthority: 'legacy_unfenced_one_shot',
        requestAuth: { capabilityPath: '/must-not-be-admitted' },
      },
    },
  ])('rejects $name before preparing the materialized root', async ({ input }) => {
    const root = join(tmpdir(), `claude-invalid-authority-${Date.now()}-${Math.random()}`);
    try {
      await expect(materializeClaudeAuthEnvironment({
        rootDir: root,
        sessionDirectory: root,
        processEnv: {},
        ...input,
        anthropic: {
          kind: 'token',
          serviceId: 'anthropic',
          profileId: 'legacy-profile',
          token: {
            token: 'must-not-materialize',
          },
        },
      })).rejects.toThrow(/materialization authority|request-auth authority/);
      await expect(stat(root)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});

describe('verifyClaudeResumeReachability', () => {
  it('proves reachability from current Claude transcript rows with camelCase sessionId', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-resume-proof-'));
    const projectDir = join(configDir, 'projects', 'project-a');
    const sessionPath = join(projectDir, 'claude-session-current.jsonl');
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, currentClaudeTranscriptStart('claude-session-current'), 'utf8');

    try {
      await expect(verifyClaudeResumeReachability({
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: configDir },
        vendorResumeId: 'claude-session-current',
      })).resolves.toEqual({
        ok: true,
        resolvedPath: sessionPath,
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('keeps legacy Claude init transcript rows resumable', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-resume-proof-'));
    const projectDir = join(configDir, 'projects', 'project-a');
    const sessionPath = join(projectDir, 'claude-session-legacy.jsonl');
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, legacyClaudeTranscriptStart('claude-session-legacy'), 'utf8');

    try {
      await expect(verifyClaudeResumeReachability({
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: configDir },
        vendorResumeId: 'claude-session-legacy',
      })).resolves.toEqual({
        ok: true,
        resolvedPath: sessionPath,
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('proves reachability from large current Claude transcript rows', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-resume-proof-'));
    const projectDir = join(configDir, 'projects', 'project-a');
    const sessionPath = join(projectDir, 'claude-session-large.jsonl');
    const rows = [
      { type: 'last-prompt', leafUuid: 'leaf-uuid', sessionId: 'claude-session-large' },
      { type: 'mode', mode: 'normal', sessionId: 'claude-session-large' },
      {
        type: 'assistant',
        sessionId: 'claude-session-large',
        message: {
          role: 'assistant',
          content: 'x'.repeat(128 * 1024),
        },
      },
    ];
    await mkdir(projectDir, { recursive: true });
    await writeFile(sessionPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

    try {
      await expect(verifyClaudeResumeReachability({
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: configDir },
        vendorResumeId: 'claude-session-large',
      })).resolves.toEqual({
        ok: true,
        resolvedPath: sessionPath,
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it('does not prove reachability from a matching filename whose current transcript rows belong to another session', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'claude-resume-proof-'));
    const projectDir = join(configDir, 'projects', 'project-a');
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, 'claude-session-candidate.jsonl'),
      currentClaudeTranscriptStart('claude-session-other'),
      'utf8',
    );

    try {
      await expect(verifyClaudeResumeReachability({
        targetMaterializedEnv: { CLAUDE_CONFIG_DIR: configDir },
        vendorResumeId: 'claude-session-candidate',
      })).resolves.toEqual({
        ok: false,
        reason: 'claude_session_transcript_unproven',
      });
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
