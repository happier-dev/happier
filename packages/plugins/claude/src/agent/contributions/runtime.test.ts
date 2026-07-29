import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLAUDE_AGENT_RUNTIME_CONTRIBUTION,
  materializeClaudeAuthEnvironment,
  verifyClaudeResumeReachability,
} from './runtime.js';
import { claudeHandoffSurface } from '../surfaces/sessions/handoff/providerOps.js';

type CliSessionCommandContribution = Readonly<{
  backendIdForSessionRuntime: string;
  agentIdForAccountSettings?: string;
  implicitResumeDelegation?: Readonly<{
    resumeFlags: readonly string[];
  }>;
  directoryFlags?: readonly string[];
  forwardModelFlag?: boolean;
  yoloProviderArgs?: readonly string[];
  versionFlags?: readonly string[];
  buildSessionOptions?: (input: Readonly<{
    args: readonly string[];
    parsed: Readonly<{
      startingMode?: string;
      directory?: string;
      resume?: string;
      providerArgs: readonly string[];
    }>;
  }>) => unknown;
}>;

function readCliSessionCommand(): CliSessionCommandContribution {
  const command = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
    cliSessionCommand?: CliSessionCommandContribution;
  }>).cliSessionCommand;
  if (!command) {
    throw new Error('Expected Claude to contribute CLI session command options');
  }
  return command;
}

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

describe('Claude runtime contribution CLI command options', () => {
  it('binds the native runtime to the declared Claude CLI system tool', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION.agentCliSystemTool).toEqual({
      toolId: 'claude-cli',
    });
  });

  it.each([
    {
      name: 'fresh terminal-local start',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: null,
        hasExplicitPermissionMode: false,
        permissionModeSeedSource: 'fallback' as const,
        hasTerminalTty: false,
      },
      expected: true,
    },
    {
      name: 'eligible terminal-local Happier attach',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        existingSessionId: 'happy-session',
        sessionAttachFilePath: '/tmp/session-attach.json',
        providerResumeId: 'claude-session',
        hasExplicitPermissionMode: true,
        permissionModeSeedSource: 'explicit' as const,
        hasTerminalTty: false,
      },
      expected: true,
    },
    {
      name: 'attach without an explicit permission seed',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'terminal' as const,
        existingSessionId: 'happy-session',
        sessionAttachFilePath: '/tmp/session-attach.json',
        providerResumeId: 'claude-session',
        hasExplicitPermissionMode: false,
        permissionModeSeedSource: 'fallback' as const,
        hasTerminalTty: true,
      },
      expected: false,
    },
    {
      name: 'daemon start',
      input: {
        startedBy: 'daemon' as const,
        startingMode: 'terminal' as const,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: null,
        hasExplicitPermissionMode: true,
        permissionModeSeedSource: 'explicit' as const,
        hasTerminalTty: true,
      },
      expected: false,
    },
    {
      name: 'remote start',
      input: {
        startedBy: 'terminal' as const,
        startingMode: 'remote' as const,
        existingSessionId: null,
        sessionAttachFilePath: null,
        providerResumeId: null,
        hasExplicitPermissionMode: true,
        permissionModeSeedSource: 'explicit' as const,
        hasTerminalTty: true,
      },
      expected: false,
    },
  ])('owns deferred startup eligibility for $name', ({ input, expected }) => {
    const policy = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      sessionStartup?: Readonly<{
        shouldUseDeferredBootstrap?: (params: typeof input) => boolean;
      }>;
    }>).sessionStartup;

    expect(policy?.shouldUseDeferredBootstrap?.(input)).toBe(expected);
  });

  it('projects handoff through the canonical contribution and has no predecessor goal adapter', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION.sessionHandoff?.surface?.({} as never)).toBe(claudeHandoffSurface);
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION.runtimeControl).toBeUndefined();
  });

  it('declares truthful runtime Activity snapshots as supported', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION.runtimeActivityApplicability).toBe('supported');
  });

  it('uses the canonical current Claude OAuth endpoints', () => {
    expect(CLAUDE_AGENT_RUNTIME_CONTRIBUTION.cloudConnect?.oauthAuthorizationCode).toMatchObject({
      authorizeUrl: 'https://platform.claude.com/oauth/authorize',
      tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    });
  });

  it('contributes Claude-owned terminal prompt submit verification policy', () => {
    const terminal = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      terminal?: Readonly<{
        promptSubmitVerification?: Readonly<{
          shouldVerifyBeforeSubmit(promptText: string): boolean;
          shouldVerifyAfterSubmit(promptText: string): boolean;
          verifyAfterSubmit(params: Readonly<{ promptText: string; screenText: string }>): boolean;
        }>;
      }>;
    }>).terminal;
    const prompt = Array.from({ length: 41 }, (_, index) => `line ${index}`).join('\n');

    expect(terminal?.promptSubmitVerification?.shouldVerifyBeforeSubmit(prompt)).toBe(false);
    expect(terminal?.promptSubmitVerification?.shouldVerifyAfterSubmit(prompt)).toBe(true);
    expect(terminal?.promptSubmitVerification?.verifyAfterSubmit({
      promptText: prompt,
      screenText: '❯ [Pasted text #1 +40 lines]',
    })).toBe(true);
  });

  it('projects the unified resume-choice setting into session runtime preferences', async () => {
    const sessionRuntimePreferences = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      sessionRuntimePreferences?: Readonly<{
        resolve?: (params: Readonly<{
          settings: Readonly<Record<string, unknown>>;
          processEnv: NodeJS.ProcessEnv;
          startedBy?: 'terminal' | 'daemon';
        }>) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
      }>;
    }>).sessionRuntimePreferences;

    await expect(Promise.resolve(sessionRuntimePreferences?.resolve?.({
      settings: { claudeUnifiedTerminalResumeChoice: 'resume_full_session' },
      processEnv: {},
      startedBy: 'terminal',
    }))).resolves.toEqual({
      claudeUnifiedTerminalResumeChoice: 'resume_full_session',
    });
  });

  it('defaults malformed unified resume-choice runtime preferences to ask every time', async () => {
    const sessionRuntimePreferences = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      sessionRuntimePreferences?: Readonly<{
        resolve?: (params: Readonly<{
          settings: Readonly<Record<string, unknown>>;
          processEnv: NodeJS.ProcessEnv;
          startedBy?: 'terminal' | 'daemon';
        }>) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
      }>;
    }>).sessionRuntimePreferences;

    await expect(Promise.resolve(sessionRuntimePreferences?.resolve?.({
      settings: { claudeUnifiedTerminalResumeChoice: 'skip_dialog' },
      processEnv: {},
      startedBy: 'terminal',
    }))).resolves.toEqual({
      claudeUnifiedTerminalResumeChoice: 'ask_every_time',
    });
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

  it('declares provider-owned session command parsing through the runtime contribution', () => {
    const command = readCliSessionCommand();

    expect(command).toMatchObject({
      backendIdForSessionRuntime: 'claude',
      agentIdForAccountSettings: 'claude',
      implicitResumeDelegation: {
        resumeFlags: ['--resume', '-r'],
      },
      directoryFlags: ['-C', '--cd'],
      forwardModelFlag: true,
      yoloProviderArgs: ['--dangerously-skip-permissions'],
      versionFlags: ['-v', '--version'],
    });
    expect(command.buildSessionOptions).toBeTypeOf('function');
  });

  it('prepares qualified-purpose state without writing legacy credential bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-qualified-purpose-root-'));
    try {
      await expect(materializeClaudeAuthEnvironment({
        rootDir: root,
        sessionDirectory: root,
        processEnv: {},
        qualifiedPurposeMaterialization: true,
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
        qualifiedPurposeMaterialization: true,
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

  it('declares provider-owned preflight model probing without projection command adaptation', () => {
    const preflight = (CLAUDE_AGENT_RUNTIME_CONTRIBUTION as Readonly<{
      preflightSessionControls?: Readonly<Record<string, unknown>>;
    }>).preflightSessionControls;

    expect(preflight).toEqual(expect.objectContaining({
      failureCacheStrategy: 'cooldown',
      probeModelsRaw: expect.any(Function),
    }));
    expect(preflight).not.toHaveProperty('probeModelsCommandArgs');
    expect(preflight).not.toHaveProperty('probeModelsFromCommandOutput');
  });

  it('maps Claude CLI-only args into session runtime options without host command code', () => {
    const command = readCliSessionCommand();

    expect(command.buildSessionOptions?.({
      args: ['claude', '--js-runtime', 'bun', '--resume', 'vendor-session-1'],
      parsed: {
        startingMode: 'terminal',
        directory: '/workspace',
        resume: 'vendor-session-1',
        providerArgs: ['--model', 'claude-opus-4-6', '--js-runtime', 'bun'],
      },
    })).toEqual({
      ok: true,
      options: {
        startingMode: 'terminal',
        directory: '/workspace',
        jsRuntime: 'bun',
        resume: undefined,
        claudeArgs: ['--model', 'claude-opus-4-6', '--resume', 'vendor-session-1'],
      },
    });
  });

  it('canonicalizes native Claude permission args before deferred attach eligibility is decided', () => {
    const command = readCliSessionCommand();

    expect(command.buildSessionOptions?.({
      args: ['claude'],
      parsed: {
        providerArgs: ['--permission-mode', 'acceptEdits'],
      },
    })).toEqual({
      ok: true,
      options: {
        permissionMode: 'safe-yolo',
        claudeArgs: ['--permission-mode', 'acceptEdits'],
      },
    });
  });

  it('keeps implicit default resume as a Happier session id instead of forwarding it to Claude', () => {
    const command = readCliSessionCommand();

    expect(command.buildSessionOptions?.({
      args: ['--resume', 'session_happy_123'],
      parsed: {
        resume: 'session_happy_123',
        providerArgs: ['--model', 'claude-opus-4-6'],
      },
    })).toEqual({
      ok: true,
      options: {
        claudeArgs: ['--model', 'claude-opus-4-6'],
      },
    });
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
