import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SYSTEM_TASK_PROTOCOL_VERSION,
  SystemTaskSpecSchema,
  type SystemTaskJsonObject,
  type SystemTaskJsonValue,
  type SystemTaskResult,
  type SystemTaskSpec,
} from '@happier-dev/protocol';
import {
  createRemoteSshPersonalHomeRelocationDestination,
  PERSONAL_HOME_SYSTEM_TASK_KINDS,
  releaseChannelSwitchDeclinedMessage,
  SERVICE_RECONCILIATION_DECLINED_MESSAGE,
} from '@happier-dev/cli-common/systemTasks';
import {
  cleanupPersonalHomeRelocationUpload,
  PersonalHomeRelocationTransferCleanupError,
} from '@happier-dev/cli-common/firstPartyRuntime';
import { captureConsoleText, captureStdoutJsonOutput } from '@/testkit/logger/captureOutput';

import { handleHomeCliCommand, handleHomeCommand, type HomeCommandDeps } from './home';

function success(taskId: string, data: SystemTaskJsonObject): SystemTaskResult {
  return { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: true, data };
}

type ScriptedTaskResult = SystemTaskResult | Readonly<{
  prompt: Readonly<{ kind: string; data: SystemTaskJsonObject }>;
  result: SystemTaskResult;
}>;

function createDeps(results: readonly ScriptedTaskResult[], overrides: Partial<HomeCommandDeps> = {}) {
  let index = 0;
  let promptShown = false;
  const start = vi.fn(async (_params: Readonly<{ spec: SystemTaskSpec }>) => ({ taskId: `task-${index + 1}` }));
  const poll = vi.fn(async () => {
    const scripted = results[index];
    if (!scripted) throw new Error('unexpected poll');
    if ('prompt' in scripted && !promptShown) {
      promptShown = true;
      return { events: [], nextCursor: 0, result: null, pendingPrompt: scripted.prompt };
    }
    index += 1;
    promptShown = false;
    const result = 'prompt' in scripted ? scripted.result : scripted;
    return { events: [], nextCursor: 0, result, pendingPrompt: null };
  });
  const respond = vi.fn(async () => {});
  const cancel = vi.fn(async () => {});
  const deps: HomeCommandDeps = {
    createRunner: () => ({ start, poll, respond, cancel }),
    resolvePath: (value) => value.startsWith('/') ? value : `/work/${value.replace(/^\.\//, '')}`,
    isInteractiveTerminal: () => false,
    promptInput: async () => 'no',
    sleep: async () => undefined,
    resolveDefaultChannel: () => 'stable',
    ...overrides,
  };
  return { deps, start, poll, respond, cancel };
}

function isSystemTaskJsonObject(value: SystemTaskJsonValue): value is SystemTaskJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectJsonSafeSshTaskWithoutTrustedHostKey(spec: unknown): void {
  const parsed = SystemTaskSpecSchema.safeParse(spec);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;

  const params = parsed.data.params;
  if (!isSystemTaskJsonObject(params)) {
    throw new Error('Expected a JSON object for the system-task params.');
  }
  const ssh = params.ssh;
  if (!isSystemTaskJsonObject(ssh)) {
    throw new Error('Expected a JSON object for the SSH task params.');
  }

  expect(Object.hasOwn(ssh, 'trustedHostKey')).toBe(false);
  expect(ssh).not.toHaveProperty('trustedHostKey');
}

const selectedAccountServicePresentation = {
  displayName: 'Work Accounts',
  endpoint: 'https://accounts.example.test',
  serverIdentityId: 'srv_accounts',
} as const;

function erasePrompt(result: SystemTaskResult): ScriptedTaskResult {
  return {
    prompt: {
      kind: 'personal_home.confirm_erase.v1',
      data: {
        canonicalServerUrl: 'http://127.0.0.1:53288',
        homeServerIdentityId: 'home-1',
        paths: ['/data/home/database/home.sqlite', '/data/home/files/public'],
        estimatedBytes: 4096,
        previewComplete: true,
        previewReason: null,
      },
    },
    result,
  };
}

function erasePromptWithIdentity(homeServerIdentityId: string, result: SystemTaskResult): ScriptedTaskResult {
  return {
    prompt: {
      kind: 'personal_home.confirm_erase.v1',
      data: {
        canonicalServerUrl: 'http://127.0.0.1:53288',
        homeServerIdentityId,
        paths: ['/data/home/database/home.sqlite', '/data/home/files/public'],
        estimatedBytes: 4096,
        previewComplete: true,
        previewReason: null,
      },
    },
    result,
  };
}

const preEraseBackup = success('backup', {
  path: '/safe/pre-erase.tar',
  sha256: 'a'.repeat(64),
  manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
});

const preEraseVerification = success('verify', {
  manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
  archiveBytes: 2048,
  identityMatchesCurrentHome: 'match',
});

function remoteResult(taskId: string, action: string, personalHome: SystemTaskJsonObject): SystemTaskResult {
  return success(taskId, { action, personalHome });
}

function remoteErasePrompt(homeServerIdentityId: string, result: SystemTaskResult): ScriptedTaskResult {
  return {
    prompt: {
      kind: 'personal_home.confirm_remote_erase.v1',
      data: {
        sshHost: 'dev@example.test',
        canonicalServerUrl: 'http://127.0.0.1:53288',
        homeServerIdentityId,
        paths: ['/srv/home/db.sqlite', '/srv/home/files'],
        estimatedBytes: 4096,
      },
    },
    result,
  };
}

const remoteEraseInspection = remoteResult('remote-status', 'personalHome.status', {
  purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:53288' },
  running: true,
  identity: { homeServerIdentityId: 'home-1' },
  layout: { dataDir: '/srv/home' },
  storage: {
    ownedErasePaths: ['/srv/home/db.sqlite', '/srv/home/files'],
    estimatedOwnedBytes: 4096,
    destinationEmpty: false,
  },
  restoreRecovery: { status: 'none', affectedTargets: [] },
});

function remoteErasePromptWithFacts(
  facts: Readonly<{
    sshHost?: string;
    canonicalServerUrl?: string;
    homeServerIdentityId?: string;
    paths?: readonly string[];
    estimatedBytes?: number | null;
  }>,
  result: SystemTaskResult,
): ScriptedTaskResult {
  return {
    prompt: {
      kind: 'personal_home.confirm_remote_erase.v1',
      data: {
        sshHost: facts.sshHost ?? 'dev@example.test',
        canonicalServerUrl: facts.canonicalServerUrl ?? 'http://127.0.0.1:53288',
        homeServerIdentityId: facts.homeServerIdentityId ?? 'home-1',
        paths: [...(facts.paths ?? ['/srv/home/db.sqlite', '/srv/home/files'])],
        estimatedBytes: facts.estimatedBytes === undefined ? 4096 : facts.estimatedBytes,
      },
    },
    result,
  };
}

function failure(taskId: string, code: string, message: string): SystemTaskResult {
  return { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId, ok: false, error: { code, message } };
}

const homeStatus = success('status', {
  installed: true,
  purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:53288' },
  canonicalServerUrl: 'http://127.0.0.1:53288',
});

const nonEmptyInspection = success('inspect', {
  running: false,
  identity: { homeServerIdentityId: 'home-1' },
  masterSecret: { present: true, fingerprint: 'secret-fingerprint' },
  layout: {
    dataDir: '/data/home',
    configDir: '/config/home',
    backupsDir: '/data/home/backups',
    databasePath: '/data/home/database/home.sqlite',
    publicFilesDir: '/data/home/files/public',
    privateFilesDir: '/data/home/files/private',
    masterSecretPath: '/data/home/secrets/master-secret',
  },
  storage: {
    databasePresent: true,
    databaseBytes: 512,
    publicFilesPresent: true,
    privateFilesPresent: true,
    backupsCount: 1,
    ownedErasePaths: ['/data/home/database/home.sqlite', '/data/home/files/public', '/data/home/files/private'],
    estimatedOwnedBytes: 4_096,
    destinationEmpty: false,
  },
  restoreRecovery: { status: 'none', affectedTargets: [] },
  relocationRecovery: { status: 'none' },
});
const nonEmptyInspectionData = (nonEmptyInspection as Extract<SystemTaskResult, { ok: true }>).data as SystemTaskJsonObject;
const relocationInspectionNone = success('inspect', {
  ...nonEmptyInspectionData,
  identity: { homeServerIdentityId: 'srv_home1' },
  relocationRecovery: { status: 'none' },
});

function createRelocationOutcomeDeps(personalHome: SystemTaskJsonObject): HomeCommandDeps {
  const descriptor = {
    v: 1 as const,
    homeServerIdentityId: 'srv_home1',
    canonicalServerUrl: 'http://127.0.0.1:53288',
    revision: 4,
    endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
  };
  return createDeps([
    homeStatus,
    relocationInspectionNone,
    success('relocation-task', { action: 'personalHome.relocate', personalHome }),
  ], {
    createRelocationOperationId: () => 'relocation-fixed',
    readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor }),
    publishRelocationDescriptor: async ({ descriptor: next }) => next,
    readRelocationDescriptor: async () => descriptor,
  }).deps;
}

const emptyInspection = success('inspect', {
  running: false,
  identity: null,
  masterSecret: { present: false, fingerprint: null },
  layout: { dataDir: '/data/home' },
  storage: {
    databasePresent: false,
    databaseBytes: null,
    publicFilesPresent: false,
    privateFilesPresent: false,
    backupsCount: 0,
    ownedErasePaths: [],
    estimatedOwnedBytes: 0,
    destinationEmpty: true,
  },
  restoreRecovery: { status: 'none', affectedTargets: [] },
  relocationRecovery: { status: 'none' },
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('handleHomeCommand', () => {
  it('discloses the verified selected Account Service in the single create confirmation', async () => {
    let prompt = '';
    const { deps } = createDeps([], {
      isInteractiveTerminal: () => true,
      promptInput: async (value) => {
        prompt = value;
        return 'no';
      },
      resolveSelectedAccountServicePresentation: async () => selectedAccountServicePresentation,
    });

    await expect(handleHomeCommand(['create'], deps)).rejects.toMatchObject({ code: 'confirmation_declined' });
    expect(prompt).toContain('Availability through Work Accounts: enabled (https://accounts.example.test).');
  });

  it('creates the Home without automatic publication when no Account Service can be verified before confirmation', async () => {
    const createPersonalHome = vi.fn(async () => ({
      profileId: 'personal-home',
      homeServerIdentityId: 'srv_personal_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      accountCreated: true,
    }));
    const reconcileCreatedHome = vi.fn(async () => undefined);
    const linkAccount = vi.fn(async () => ({ kind: 'linked' as const, homeServerIdentityId: 'srv_personal_home' }));
    const { deps } = createDeps([], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
      resolveSelectedAccountServicePresentation: async () => null,
      createPersonalHome,
      reconcileCreatedHome,
      linkAccount,
    });

    await handleHomeCommand(['create', '--link-account', 'auto'], deps);

    expect(createPersonalHome).toHaveBeenCalledOnce();
    expect(reconcileCreatedHome).toHaveBeenCalledOnce();
    expect(linkAccount).not.toHaveBeenCalled();
  });

  it('runs forward direct QR only after trusted Home creation and keeps automatic Account Service linking optional', async () => {
    const order: string[] = [];
    const pairDevice = vi.fn(async () => {
      order.push('pair');
      return { kind: 'completed' as const, requestedDeviceLabel: 'Phone' };
    });
    const linkAccount = vi.fn(async () => {
      order.push('link');
      return { kind: 'unavailable' as const, reason: 'account_service_credentials_unavailable' as const };
    });
    const { deps } = createDeps([], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
      createPersonalHome: async () => {
        order.push('create');
        return {
          profileId: 'personal-home',
          homeServerIdentityId: 'srv_personal_home',
          canonicalServerUrl: 'http://127.0.0.1:43123',
          accountCreated: true,
        };
      },
      reconcileCreatedHome: async () => { order.push('reconcile'); },
      pairDevice,
      linkAccount,
      resolveSelectedAccountServicePresentation: async () => selectedAccountServicePresentation,
    });

    await handleHomeCommand(['create', '--link-account', 'auto'], deps);

    expect(order).toEqual(['create', 'reconcile', 'pair', 'link']);
    expect(pairDevice).toHaveBeenCalledWith({ profileRef: 'personal-home', copyLink: false, signal: undefined });
    expect(linkAccount).toHaveBeenCalledWith({
      homeServerIdentityId: 'srv_personal_home',
      relink: false,
      signal: undefined,
      expectedAccountServiceSelection: {
        endpoint: selectedAccountServicePresentation.endpoint,
        serverIdentityId: selectedAccountServicePresentation.serverIdentityId,
      },
    });
    expect(process.exitCode).toBeUndefined();
  });

  it('honors create --link-account never and does not emit QR material in JSON mode', async () => {
    const pairDevice = vi.fn();
    const linkAccount = vi.fn();
    const { deps } = createDeps([], {
      createPersonalHome: async () => ({
        profileId: 'personal-home',
        homeServerIdentityId: 'srv_personal_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: false,
      }),
      reconcileCreatedHome: async () => undefined,
      pairDevice,
      linkAccount,
    });
    const output = captureStdoutJsonOutput<Record<string, unknown>>();
    try {
      await handleHomeCommand(['create', '--yes', '--json', '--link-account', 'never'], deps);
      expect(JSON.stringify(output.json())).not.toMatch(/pair|secret|credential|approval|qr/i);
      expect(output.json().data).toMatchObject({ accountServiceLink: { kind: 'not_requested' } });
    } finally {
      output.restore();
    }
    expect(pairDevice).not.toHaveBeenCalled();
    expect(linkAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', async () => ({ kind: 'failed' as const }), { kind: 'failed' }],
    ['cancelled', async () => ({ kind: 'cancelled' as const }), { kind: 'cancelled' }],
    ['Account Service session unavailable', async () => ({ kind: 'unavailable' as const, reason: 'account_service_credentials_unavailable' as const }), { kind: 'unavailable', reason: 'account_service_credentials_unavailable' }],
    ['home transport unavailable', async () => ({ kind: 'unavailable' as const, reason: 'home_transport_unavailable' as const }), { kind: 'unavailable', reason: 'home_transport_unavailable' }],
    ['exception', async () => { throw new Error('link failed after create'); }, { kind: 'failed' }],
  ])('keeps local Home creation durable and reports typed post-create link outcome when linking is %s', async (_label, linkAccount, expected) => {
    const { deps } = createDeps([], {
      createPersonalHome: async () => ({
        profileId: 'personal-home',
        homeServerIdentityId: 'srv_personal_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
      }),
      reconcileCreatedHome: async () => undefined,
      linkAccount,
    });
    const output = captureStdoutJsonOutput<{ data?: { status?: string; accountServiceLink?: { kind?: string } } }>();
    try {
      await handleHomeCommand(['create', '--yes', '--json', '--link-account', 'auto'], deps);
      expect(output.json().data).toMatchObject({
        status: 'complete',
        accountServiceLink: expected,
      });
    } finally {
      output.restore();
    }
  });

  it('keeps local creation successful and prints identity-specific reentry after an optional post-create link failure', async () => {
    const { deps } = createDeps([], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
      createPersonalHome: async () => ({
        profileId: 'personal-home',
        homeServerIdentityId: 'srv_personal_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
      }),
      reconcileCreatedHome: async () => undefined,
      linkAccount: async () => ({ kind: 'failed' }),
      resolveSelectedAccountServicePresentation: async () => selectedAccountServicePresentation,
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHomeCommand(['create', '--link-account', 'auto'], deps);

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Personal Home ready');
    expect(text).toContain('happier home link-account --home srv_personal_home');
    expect(process.exitCode).toBeUndefined();
  });

  it('exposes direct QR reentry separately from terminal pairing', async () => {
    const pairDevice = vi.fn(async () => ({ kind: 'completed' as const, requestedDeviceLabel: 'Browser' }));
    const { deps } = createDeps([], { pairDevice });

    await handleHomeCommand(['pair-device', '--home', 'studio', '--copy-link'], deps);

    expect(pairDevice).toHaveBeenCalledWith({ profileRef: 'studio', copyLink: true, signal: undefined });
  });

  it('emits only the authorized invite and typed outcome for the internal remote pairing stream', async () => {
    const link = 'happier:///pair?v=2&payload=short-lived-v2';
    const pairDevice = vi.fn(async (input: Readonly<{ onInvite?: (value: Readonly<{ link: string }>) => void }>) => {
      input.onInvite?.({ link });
      return { kind: 'expired' as const };
    });
    const { deps } = createDeps([], { pairDevice, isInteractiveTerminal: () => false });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHomeCommand(['pair-device', '--system-task-stream'], deps);

    expect(output.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      { v: 1, kind: 'home_pair_device.invite', link },
      { v: 1, kind: 'home_pair_device.result', result: { kind: 'expired' } },
    ]);
    expect(output.mock.calls.flat().join('\n')).not.toMatch(/access\.key|bearer|claimSecret|masterSecret/i);
  });

  it('refuses pair-device JSON before starting and emits no enrollment material', async () => {
    const pairDevice = vi.fn();
    const { deps } = createDeps([], { pairDevice });
    const output = captureStdoutJsonOutput();
    try {
      await expect(handleHomeCommand(['pair-device', '--json', '--copy-link'], deps))
        .rejects.toMatchObject({ code: 'interactive_required' });
      expect(output.chunks.join('')).toBe('');
    } finally {
      output.restore();
    }
    expect(pairDevice).not.toHaveBeenCalled();
  });

  it('surfaces bound QR update-required without starting another flow', async () => {
    const pairDevice = vi.fn(async () => ({ kind: 'update_required' as const }));
    const { deps } = createDeps([], { pairDevice, isInteractiveTerminal: () => true });

    await expect(handleHomeCommand(['pair-device'], deps)).rejects.toMatchObject({ code: 'update_required' });
    expect(pairDevice).toHaveBeenCalledOnce();
  });

  it('preserves explicit Account Service relink conflict semantics', async () => {
    const linkAccount = vi.fn(async (input: Readonly<{ relink: boolean }>) => input.relink
      ? ({ kind: 'linked' as const, homeServerIdentityId: 'srv_home' })
      : ({ kind: 'relink_required' as const, homeServerIdentityId: 'srv_home' }));
    const { deps } = createDeps([], { linkAccount });

    await expect(handleHomeCommand(['link-account', '--home', 'srv_home'], deps)).rejects.toMatchObject({ code: 'relink_required' });
    await handleHomeCommand(['link-account', '--home', 'srv_home', '--relink'], deps);

    expect(linkAccount).toHaveBeenLastCalledWith({ homeServerIdentityId: 'srv_home', relink: true, signal: undefined });
  });

  it('turns missing sign-in credentials into an actionable link-account refusal', async () => {
    const { deps } = createDeps([], {
      linkAccount: async () => ({ kind: 'unavailable' as const, reason: 'account_service_credentials_unavailable' as const }),
    });

    await expect(handleHomeCommand(['link-account', '--home', 'srv_home'], deps)).rejects.toMatchObject({
      code: 'account_service_credentials_unavailable',
      message: expect.stringContaining('happier auth service use'),
    });
  });

  it('names the selected sign-in service in the link-account sign-in command instead of a placeholder', async () => {
    const { deps } = createDeps([], {
      linkAccount: async () => ({
        kind: 'unavailable' as const,
        reason: 'account_service_credentials_unavailable' as const,
        selectedEndpoint: 'https://accounts.example.test',
      }),
    });

    const error = await handleHomeCommand(['link-account', '--home', 'srv_home'], deps).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: 'account_service_credentials_unavailable' });
    expect((error as Error).message).toContain('happier auth service use https://accounts.example.test');
    expect((error as Error).message).not.toContain('<endpoint>');
  });

  it('stops Account Service sign-in for one Home and says exactly what unlinking does not revoke', async () => {
    const unlinkAccount = vi.fn(async () => ({
      kind: 'unlinked' as const,
      homeServerIdentityId: 'srv_home',
      issuerServerIdentityId: 'srv_service',
    }));
    const { deps } = createDeps([], { unlinkAccount });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHomeCommand(['unlink-account', '--home', 'srv_home'], deps);

    expect(unlinkAccount).toHaveBeenCalledWith({ homeServerIdentityId: 'srv_home', signal: undefined });
    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Stopped future account-based sign-in for this Home.');
    expect(text).toContain('Devices already signed in keep their access until signed out on the Home.');
  });

  it('reports an unlink this Home cannot answer with its own typed reason', async () => {
    const unlinkAccount = vi.fn(async () => ({
      kind: 'unavailable' as const,
      reason: 'home_credentials_unavailable' as const,
    }));
    const { deps } = createDeps([], { unlinkAccount });

    await expect(handleHomeCommand(['unlink-account'], deps))
      .rejects.toMatchObject({ code: 'home_credentials_unavailable' });
    expect(unlinkAccount).toHaveBeenCalledWith({ signal: undefined });
  });

  it('admits the selected artifact before starting local Personal Home bootstrap, then reconciles the adopted Home', async () => {
    const order: string[] = [];
    const createPersonalHome = vi.fn(async (input: Readonly<{
      channel: 'stable' | 'preview' | 'dev';
      mode: 'user' | 'system';
    }>) => {
      order.push('create');
      expect(input).toEqual({ channel: 'preview', mode: 'system' });
      return {
        profileId: 'personal-home',
        homeServerIdentityId: 'srv_personal_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
      };
    });
    const reconcileCreatedHome = vi.fn(async (profileId: string) => {
      order.push(`reconcile:${profileId}`);
    });
    const promptInput = vi.fn(async () => {
      order.push('confirm');
      return 'yes';
    });
    const { deps, start } = createDeps([], {
      createPersonalHome,
      reconcileCreatedHome,
      isInteractiveTerminal: () => true,
      promptInput,
    });

    await handleHomeCommand(['create', '--channel', 'preview', '--mode', 'system'], deps);

    expect(order).toEqual(['confirm', 'create', 'reconcile:personal-home']);
    expect(promptInput).toHaveBeenCalledWith(expect.stringContaining('plaintext'));
    expect(promptInput).toHaveBeenCalledWith(expect.stringContaining('Mode: system'));
    expect(start).not.toHaveBeenCalled();
  });

  it('uses the current CLI release ring when --channel is omitted', async () => {
    const controller = new AbortController();
    const createPersonalHome = vi.fn(async () => ({
      profileId: 'personal-home',
      homeServerIdentityId: 'srv_personal_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      accountCreated: false,
    }));
    const { deps } = createDeps([], {
      createPersonalHome,
      reconcileCreatedHome: async () => undefined,
      resolveDefaultChannel: () => 'dev',
      isInteractiveTerminal: () => false,
    });

    await handleHomeCommand(['create', '--yes'], deps, controller.signal);

    expect(createPersonalHome).toHaveBeenCalledWith(
      { channel: 'dev', mode: 'user' },
      { allowErasedRuntimeRecreate: true, signal: controller.signal },
    );
  });

  it('declines before artifact, runtime, profile, or bootstrap mutation', async () => {
    const createPersonalHome = vi.fn();
    const reconcileCreatedHome = vi.fn();
    const { deps, start } = createDeps([], {
      createPersonalHome,
      reconcileCreatedHome,
      isInteractiveTerminal: () => true,
      promptInput: async () => 'no',
    });

    await expect(handleHomeCommand(['create'], deps)).rejects.toMatchObject({
      code: 'confirmation_declined',
    });

    expect(createPersonalHome).not.toHaveBeenCalled();
    expect(reconcileCreatedHome).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('allows explicit --yes creation without a TTY and never prompts', async () => {
    const createPersonalHome = vi.fn(async () => ({
      profileId: 'personal-home',
      homeServerIdentityId: 'srv_personal_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      accountCreated: true,
    }));
    const promptInput = vi.fn();
    const { deps } = createDeps([], {
      createPersonalHome,
      reconcileCreatedHome: async () => undefined,
      isInteractiveTerminal: () => false,
      promptInput,
    });

    await handleHomeCommand(['create', '--yes'], deps);

    expect(createPersonalHome).toHaveBeenCalledOnce();
    expect(promptInput).not.toHaveBeenCalled();
  });

  it('creates a remote Personal Home through the one SSH coordinator after explicit plaintext confirmation', async () => {
    const descriptor = {
      v: 1,
      homeServerIdentityId: 'srv_remote_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      revision: 2,
      endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }],
    };
    const remoteCreated = success('remote-create', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: 'srv_remote_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor,
        pairing: { kind: 'completed', requestedDeviceLabel: null },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const createPersonalHome = vi.fn();
    const reconcileCreatedHome = vi.fn();
    const pairDevice = vi.fn();
    const promptInput = vi.fn(async (_prompt: string) => 'yes');
    const { deps, start } = createDeps([remoteCreated], {
      createPersonalHome,
      reconcileCreatedHome,
      pairDevice,
      promptInput,
      isInteractiveTerminal: () => true,
    });

    await handleHomeCommand(['create', '--ssh', 'dev@example.test'], deps);

    expect(promptInput).toHaveBeenCalledWith(expect.stringContaining('dev@example.test'));
    expect(promptInput).toHaveBeenCalledWith(expect.stringContaining('plaintext'));
    expect(start).toHaveBeenCalledWith({ spec: {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action: 'personalHome.create',
        channel: 'stable',
        relayRuntime: { channel: 'stable', mode: 'user' },
        pairDevice: true,
        enrollInvokingClient: true,
        ssh: { target: 'dev@example.test', auth: 'agent' },
      },
    } });
    expect(createPersonalHome).not.toHaveBeenCalled();
    expect(reconcileCreatedHome).not.toHaveBeenCalled();
    expect(pairDevice).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'expired'] as const)('keeps remote creation successful when optional pairing is %s', async (kind) => {
    const remoteCreated = success(`remote-create-${kind}`, {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: 'srv_remote_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind },
        invokingClientEnrollment: { kind: 'not_requested' },
      },
    });
    const { deps } = createDeps([remoteCreated], { isInteractiveTerminal: () => true, promptInput: async () => 'yes' });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--link-account', 'never'], deps);

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Remote Personal Home ready');
    expect(text).toContain('happier home create --ssh dev@example.test --link-account never');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports an optional post-create pairing failure without failing or claiming Home rollback', async () => {
    const remoteCreated = success('remote-create-pair-failed', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: 'srv_remote_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'failed', status: 503 },
        invokingClientEnrollment: { kind: 'not_requested' },
      },
    });
    const { deps } = createDeps([remoteCreated], { isInteractiveTerminal: () => true, promptInput: async () => 'yes' });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--link-account', 'never'], deps);

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Remote Personal Home ready');
    expect(text).toContain('pairing is incomplete');
    expect(text).not.toMatch(/rolled back|removed|creation failed/i);
    expect(process.exitCode).toBeUndefined();
  });

  it('enrolls the invoking CLI before automatic Account Service linking for a remote Home', async () => {
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_remote_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      revision: 2,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const remoteCreated = success('remote-create-auto-link', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: descriptor.homeServerIdentityId,
        canonicalServerUrl: descriptor.canonicalServerUrl,
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor,
        pairing: { kind: 'completed', requestedDeviceLabel: null },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const linkAccount = vi.fn(async () => ({ kind: 'linked' as const, homeServerIdentityId: descriptor.homeServerIdentityId }));
    const { deps } = createDeps([remoteCreated], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
      linkAccount,
      resolveSelectedAccountServicePresentation: async () => selectedAccountServicePresentation,
    });

    await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--link-account', 'auto'], deps);

    expect(linkAccount).toHaveBeenCalledWith({
      homeServerIdentityId: descriptor.homeServerIdentityId,
      relink: false,
      signal: undefined,
      expectedAccountServiceSelection: {
        endpoint: selectedAccountServicePresentation.endpoint,
        serverIdentityId: selectedAccountServicePresentation.serverIdentityId,
      },
    });
  });

  it('reports remote invoking-client enrollment failure as typed post-create incompleteness in JSON', async () => {
    const remoteCreated = success('remote-create-enrollment-failed', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: 'srv_remote_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'not_requested' },
        invokingClientEnrollment: { kind: 'failed' },
      },
    });
    const linkAccount = vi.fn();
    const { deps } = createDeps([remoteCreated], { linkAccount });
    const output = captureStdoutJsonOutput<{ data?: Record<string, unknown> }>();
    try {
      await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--yes', '--json', '--link-account', 'auto'], deps);
      expect(output.json().data).toMatchObject({
        status: 'complete',
        invokingClientEnrollment: { kind: 'failed' },
        accountServiceLink: { kind: 'unable_to_attempt' },
      });
      expect(output.json().data).not.toHaveProperty('pairing');
    } finally {
      output.restore();
    }
    expect(linkAccount).not.toHaveBeenCalled();
  });

  it('reports remote enrollment failure without undoing the Home and prints exact create reentry', async () => {
    const remoteCreated = success('remote-create-enrollment-failed-human', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: 'srv_remote_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'not_requested' },
        invokingClientEnrollment: { kind: 'failed' },
      },
    });
    const { deps } = createDeps([remoteCreated], { isInteractiveTerminal: () => true, promptInput: async () => 'yes' });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--link-account', 'auto'], deps);

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Remote Personal Home ready');
    expect(text).toContain('happier home create --ssh dev@example.test --link-account auto');
    expect(text).not.toMatch(/rolled back|removed|creation failed/i);
    expect(process.exitCode).toBeUndefined();
  });

  it('does not attempt Account Service linking when remote Home creation fails', async () => {
    const linkAccount = vi.fn();
    const { deps } = createDeps([
      failure('remote-create-failed', 'personal_home_create_failed', 'Remote bootstrap failed.'),
    ], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
      linkAccount,
    });

    await expect(handleHomeCommand([
      'create',
      '--ssh',
      'dev@example.test',
      '--link-account',
      'auto',
    ], deps)).rejects.toMatchObject({ code: 'personal_home_create_failed' });

    expect(linkAccount).not.toHaveBeenCalled();
  });

  it('keeps creator enrollment enabled while --link-account never skips Account Service publication', async () => {
    const remoteCreated = success('remote-create-never-link', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: 'srv_remote_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'completed', requestedDeviceLabel: null },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const linkAccount = vi.fn();
    const { deps, start } = createDeps([remoteCreated], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
      linkAccount,
    });

    await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--link-account', 'never'], deps);

    expect(linkAccount).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ spec: expect.objectContaining({
      params: expect.objectContaining({ enrollInvokingClient: true }),
    }) }));
  });

  it('keeps a remote Home usable when Account Service is unavailable and prints the exact link reentry', async () => {
    const remoteCreated = success('remote-create-no-account-service', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: 'srv_remote_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'completed', requestedDeviceLabel: null },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const { deps } = createDeps([remoteCreated], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
      linkAccount: async () => ({ kind: 'unavailable' as const, reason: 'account_service_credentials_unavailable' as const }),
      resolveSelectedAccountServicePresentation: async () => selectedAccountServicePresentation,
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHomeCommand(['create', '--ssh', 'dev@example.test'], deps);

    expect(output.mock.calls.flat().join('\n')).toContain('happier auth service use https://accounts.example.test');
    expect(output.mock.calls.flat().join('\n')).not.toContain('<endpoint>');
    expect(output.mock.calls.flat().join('\n')).toContain('happier home link-account --home srv_remote_home');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports an optional Account Service exception without failing or undoing the remote Home', async () => {
    const remoteCreated = success('remote-create-link-error', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete',
        homeServerIdentityId: 'srv_remote_home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true,
        channel: 'stable',
        mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'completed', requestedDeviceLabel: null },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const { deps } = createDeps([remoteCreated], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
      linkAccount: async () => {
        throw new Error('Account Service unavailable');
      },
      resolveSelectedAccountServicePresentation: async () => selectedAccountServicePresentation,
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleHomeCommand(['create', '--ssh', 'dev@example.test'], deps);

    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Remote Personal Home ready');
    expect(text).toContain('happier home link-account --home srv_remote_home');
    expect(text).not.toMatch(/rolled back|removed|creation failed/i);
    expect(process.exitCode).toBeUndefined();
  });

  it.each([
    ['daemon.replaceRemoteBackgroundServices', { replaceExistingServices: true }],
    ['releaseChannel.switchDefaultForSetup', { switchDefaultReleaseChannel: true }],
  ] as const)('answers the remote %s prompt through the canonical confirmation path', async (kind, expectedAnswer) => {
    const remoteCreated = success(`remote-create-${kind}`, {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete', homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true, channel: 'preview', mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'not_requested' },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const { deps, respond } = createDeps([{
      prompt: {
        kind,
        data: kind === 'daemon.replaceRemoteBackgroundServices'
          ? { targetReleaseChannel: 'preview', targetServerUrl: null, services: [] }
          : { targetReleaseChannel: 'preview', currentDefaultReleaseChannel: 'stable', targetServerUrl: null, managedReleaseChannels: [] },
      },
      result: remoteCreated,
    }], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
    });

    await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--channel', 'preview'], deps);

    expect(respond).toHaveBeenCalledWith({ taskId: 'task-1', answer: expectedAnswer });
  });

  it('shows the conflicting remote services and keeps them when the replacement prompt is answered with Enter', async () => {
    const remoteCreated = success('remote-create-service-keep', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete', homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true, channel: 'preview', mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'not_requested' },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const prompts: string[] = [];
    const { deps, respond } = createDeps([{
      prompt: {
        kind: 'daemon.replaceRemoteBackgroundServices',
        data: {
          targetReleaseChannel: 'preview',
          targetServerUrl: null,
          services: [{ label: 'happier-daemon.stable', releaseChannel: 'stable', targetMode: 'pinned', running: true }],
        },
      },
      result: remoteCreated,
    }], {
      isInteractiveTerminal: () => true,
      promptInput: async (message: string) => {
        prompts.push(message);
        return prompts.length === 1 ? 'yes' : '';
      },
    });

    await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--channel', 'preview'], deps);

    expect(respond).toHaveBeenCalledWith({ taskId: 'task-1', answer: { replaceExistingServices: false } });
    const replacePrompt = prompts.at(-1) ?? '';
    expect(replacePrompt).toContain('happier-daemon.stable');
    expect(replacePrompt).toContain('Target release channel: preview');
    expect(replacePrompt).not.toContain('Target server:');
    expect(replacePrompt).toContain('[y/N]');
  });

  it.each([
    ['daemon.replaceRemoteBackgroundServices', { replaceExistingServices: false }],
    ['releaseChannel.switchDefaultForSetup', { switchDefaultReleaseChannel: false }],
  ] as const)('keeps --yes fail-closed for the remote %s authority', async (kind, expectedAnswer) => {
    const remoteCreated = success(`remote-create-${kind}-declined`, {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete', homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true, channel: 'preview', mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'not_requested' },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const { deps, respond } = createDeps([{
      prompt: { kind, data: { targetReleaseChannel: 'preview' } },
      result: remoteCreated,
    }], {
      promptInput: async () => { throw new Error('--yes must not prompt or grant reconciliation authority'); },
    });

    await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--channel', 'preview', '--yes'], deps);

    expect(respond).toHaveBeenCalledWith({ taskId: 'task-1', answer: expectedAnswer });
  });

  it.each([
    // The task's own host-neutral refusals (cli-common SERVICE_RECONCILIATION_DECLINED_MESSAGE /
    // releaseChannelSwitchDeclinedMessage) pass through verbatim.
    [
      'daemon.replaceRemoteBackgroundServices',
      'service_reconciliation_declined',
      SERVICE_RECONCILIATION_DECLINED_MESSAGE,
      '--replace-services',
    ],
    [
      'releaseChannel.switchDefaultForSetup',
      'release_channel_switch_declined',
      releaseChannelSwitchDeclinedMessage({ currentDefaultReleaseChannel: 'stable', targetReleaseChannel: 'preview' }),
      '--switch-channel',
    ],
  ] as const)('keeps the task-owned refusal and appends only the CLI flag when --yes declines the remote %s conflict', async (kind, code, taskMessage, flag) => {
    const { deps } = createDeps([{
      prompt: { kind, data: { targetReleaseChannel: 'preview' } },
      result: failure(`remote-create-${code}`, code, taskMessage),
    }], {
      promptInput: async () => { throw new Error('--yes must not prompt'); },
    });
    const error = await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--channel', 'preview', '--yes'], deps)
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toMatchObject({ code, personalHomeTaskFailure: true, message: `${taskMessage} Or rerun with ${flag}.` });
  });

  it('keeps remote create mutation-free without confirmation and makes JSON output secret-free', async () => {
    const createPersonalHome = vi.fn();
    const { deps, start } = createDeps([], { createPersonalHome, promptInput: async () => 'no', isInteractiveTerminal: () => true });
    await expect(handleHomeCommand(['create', '--ssh', 'dev@example.test'], deps)).rejects.toMatchObject({ code: 'confirmation_declined' });
    expect(start).not.toHaveBeenCalled();

    const remoteCreated = success('remote-create-json', {
      action: 'personalHome.create',
      personalHome: {
        status: 'complete', homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123',
        accountCreated: true, channel: 'stable', mode: 'user',
        descriptor: { v: 1, homeServerIdentityId: 'srv_remote_home', canonicalServerUrl: 'http://127.0.0.1:43123', revision: 1, endpoints: [{ kind: 'iroh', endpointId: 'a'.repeat(64) }] },
        pairing: { kind: 'not_requested' },
        invokingClientEnrollment: { kind: 'enrolled' },
      },
    });
    const linkAccount = vi.fn(async () => ({ kind: 'linked' as const, homeServerIdentityId: 'srv_remote_home' }));
    const jsonHarness = createDeps([remoteCreated], { linkAccount });
    const output = captureStdoutJsonOutput<Record<string, unknown>>();
    try {
      await handleHomeCommand(['create', '--ssh', 'dev@example.test', '--yes', '--json'], jsonHarness.deps);
      const text = JSON.stringify(output.json());
      expect(text).not.toMatch(/token|secret|credential|approval|qr|pairing.*link/i);
    } finally {
      output.restore();
    }
    expect(jsonHarness.start).toHaveBeenCalledWith(expect.objectContaining({ spec: expect.objectContaining({
      kind: 'remote.ssh.manageHost.v1',
      params: expect.objectContaining({ pairDevice: false, enrollInvokingClient: true }),
    }) }));
    expect(linkAccount).toHaveBeenCalledOnce();
    expect(output.json().data).toMatchObject({ accountServiceLink: { kind: 'linked' } });
  });

  it('rejects ambiguous or invalid remote create options before starting the coordinator', async () => {
    const { deps, start } = createDeps([]);
    await expect(handleHomeCommand(['create', '--ssh', 'dev@example.test', '--this-computer', '--yes'], deps))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handleHomeCommand(['create', '--ssh', 'dev@example.test', '--link-account', 'sometimes', '--yes'], deps))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handleHomeCommand(['create', '--target', 'dev@example.test', '--yes'], deps))
      .rejects.toMatchObject({ code: 'invalid_params' });
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    ['status', ['status', '--ssh', 'dev@example.test'], 'personalHome.status', undefined],
    ['backup', ['backup', '--ssh', 'dev@example.test', '--output', './home.tar'], 'personalHome.backup', { outputPath: '/work/home.tar' }],
    ['verify', ['verify-backup', '--ssh', 'dev@example.test', './home.tar'], 'personalHome.verifyBackup', { archivePath: '/work/home.tar' }],
    ['restore', ['restore', '--ssh', 'dev@example.test', './home.tar', '--yes'], 'personalHome.restore', { archivePath: '/work/home.tar' }],
    ['recovery', ['recover-restore', '--ssh', 'dev@example.test', '--yes'], 'personalHome.recoverRestore', undefined],
  ] as const)('routes remote %s through the single SSH coordinator', async (_name, argv, action, personalHomeOperation) => {
    const remote = success('remote-operation', { action, personalHome: { outcome: 'complete' } });
    const { deps, start } = createDeps([remote]);

    await handleHomeCommand([...argv], deps);

    expect(start).toHaveBeenCalledWith({ spec: {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action,
        channel: 'stable',
        relayRuntime: { channel: 'stable', mode: 'user' },
        ssh: { target: 'dev@example.test', auth: 'agent' },
        ...(personalHomeOperation ? { personalHomeOperation } : {}),
      },
    } });
  });

  it('omits an absent trusted host key from every remote Home task spec and keeps the payload JSON-safe', async () => {
    const createHarness = createDeps([
      failure('remote-create', 'payload_captured', 'Stop after capturing the task payload.'),
    ]);
    await expect(handleHomeCommand(['create', '--ssh', 'dev@example.test', '--yes'], createHarness.deps))
      .rejects.toMatchObject({ code: 'payload_captured' });
    expectJsonSafeSshTaskWithoutTrustedHostKey(createHarness.start.mock.calls[0]?.[0].spec);

    const operationHarness = createDeps([
      failure('remote-status', 'payload_captured', 'Stop after capturing the task payload.'),
    ]);
    await expect(handleHomeCommand(['status', '--ssh', 'dev@example.test'], operationHarness.deps))
      .rejects.toMatchObject({ code: 'payload_captured' });
    expectJsonSafeSshTaskWithoutTrustedHostKey(operationHarness.start.mock.calls[0]?.[0].spec);

    const sourceDescriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const relocationHarness = createDeps([
      homeStatus,
      relocationInspectionNone,
      failure('remote-relocate', 'payload_captured', 'Stop after capturing the task payload.'),
    ], {
      createRelocationOperationId: () => 'relocation-fixed',
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor: sourceDescriptor }),
      publishRelocationDescriptor: async ({ descriptor }) => descriptor,
      readRelocationDescriptor: async () => sourceDescriptor,
    });
    await expect(handleHomeCommand(['relocate', '--target', 'dev@example.test', '--yes'], relocationHarness.deps))
      .rejects.toMatchObject({ code: 'payload_captured' });
    expectJsonSafeSshTaskWithoutTrustedHostKey(relocationHarness.start.mock.calls[2]?.[0].spec);
  });

  it('relocates the local Personal Home to the explicit SSH target through the shared coordinator contract', async () => {
    const sourceDescriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const destinationDescriptor = {
      ...sourceDescriptor,
      canonicalServerUrl: 'https://destination.example.test',
      revision: 5,
      endpoints: [{ kind: 'https' as const, url: 'https://destination.example.test' }],
    };
    const start = vi.fn(async ({ spec }: Readonly<{ spec: SystemTaskSpec }>) => ({
      taskId: spec.kind === 'relay.runtime.status.v1'
        ? 'status-task'
        : spec.kind === PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect
          ? 'inspect-task'
          : 'relocation-task',
    }));
    let relocationPoll = 0;
    const poll = vi.fn(async ({ taskId }: Readonly<{ taskId: string; cursor: number }>) => {
      if (taskId === 'status-task') {
        return { events: [], nextCursor: 0, result: homeStatus, pendingPrompt: null };
      }
      if (taskId === 'inspect-task') {
        return { events: [], nextCursor: 0, result: relocationInspectionNone, pendingPrompt: null };
      }
      relocationPoll += 1;
      if (relocationPoll === 1) {
        return {
          events: [], nextCursor: 0, result: null,
          pendingPrompt: {
            kind: 'personal_home.publish_relocation_descriptor.v1',
            data: { operationId: 'relocation-fixed', homeServerIdentityId: 'srv_home1', connectionDescriptor: destinationDescriptor },
          },
        };
      }
      if (relocationPoll === 2) {
        return {
          events: [], nextCursor: 0, result: null,
          pendingPrompt: {
            kind: 'personal_home.read_relocation_descriptor.v1',
            data: { operationId: 'relocation-fixed', homeServerIdentityId: 'srv_home1' },
          },
        };
      }
      return {
        events: [], nextCursor: 0,
        result: success('relocation-task', {
          action: 'personalHome.relocate',
          personalHome: {
            operationId: 'relocation-fixed', status: 'committed', destinationMachineId: 'dev@example.test',
            sourceDescriptorRevision: 4, publishedDescriptor: destinationDescriptor,
          },
        }),
        pendingPrompt: null,
      };
    });
    const respond = vi.fn(async () => undefined);
    const publishRelocationDescriptor = vi.fn(async () => destinationDescriptor);
    const readRelocationDescriptor = vi.fn(async () => destinationDescriptor);
    const { deps } = createDeps([], {
      createRunner: () => ({ start, poll, respond, cancel: vi.fn(async () => undefined) }) as ReturnType<HomeCommandDeps['createRunner']>,
      createRelocationOperationId: () => 'relocation-fixed',
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor: sourceDescriptor }),
      publishRelocationDescriptor,
      readRelocationDescriptor,
    });

    await handleHomeCommand(['relocate', '--target', 'dev@example.test', '--yes'], deps);

    expect(start).toHaveBeenLastCalledWith({ spec: {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      kind: 'remote.ssh.manageHost.v1',
      params: {
        action: 'personalHome.relocate',
        channel: 'stable',
        relayRuntime: { channel: 'stable', mode: 'user' },
        personalHomeRelocation: {
          operationId: 'relocation-fixed',
          destinationMachineId: 'dev@example.test',
          sourceDescriptorRevision: 4,
        },
        ssh: { target: 'dev@example.test', auth: 'agent' },
      },
    } });
    expect(publishRelocationDescriptor).toHaveBeenCalledWith({ profileId: 'home-profile', descriptor: destinationDescriptor });
    expect(readRelocationDescriptor).toHaveBeenCalledWith({ profileId: 'home-profile', homeServerIdentityId: 'srv_home1' });
    expect(respond).toHaveBeenNthCalledWith(1, { taskId: 'relocation-task', answer: { descriptor: destinationDescriptor } });
    expect(respond).toHaveBeenNthCalledWith(2, { taskId: 'relocation-task', answer: { descriptor: destinationDescriptor } });
  });

  it.each(['committed', 'returned'] as const)('reports a %s relocation as successful JSON', async (status) => {
    const output = captureStdoutJsonOutput<{
      ok: boolean;
      kind: string;
      data?: { status?: string };
    }>();
    try {
      await handleHomeCliCommand({
        args: ['home', 'relocate', '--target', 'dev@example.test', '--yes', '--json'],
        rawArgv: [],
        terminalRuntime: null,
      }, createRelocationOutcomeDeps({
        operationId: 'relocation-fixed',
        status,
        destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 4,
      }));

      expect(output.json()).toMatchObject({
        v: 1,
        ok: true,
        kind: 'personal_home_relocation',
        data: { status },
      });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      output.restore();
    }
  });

  it('reports a pending relocation as structured JSON failure with its exact recovery action', async () => {
    const output = captureStdoutJsonOutput<{
      ok: boolean;
      kind: string;
      error?: { code?: string; status?: string; recoveryAction?: string; message?: string };
    }>();
    try {
      await handleHomeCliCommand({
        args: ['home', 'relocate', '--target', 'dev@example.test', '--yes', '--json'],
        rawArgv: [],
        terminalRuntime: null,
      }, createRelocationOutcomeDeps({
        operationId: 'relocation-fixed',
        status: 'pending',
        destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 4,
        recoveryAction: 'finish_move',
      }));

      expect(output.json()).toMatchObject({
        v: 1,
        ok: false,
        kind: 'personal_home_operation',
        error: {
          code: 'personal_home_relocation_incomplete',
          status: 'pending',
          recoveryAction: 'finish_move',
        },
      });
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
    }
  });

  it('reports a pending relocation truthfully to a human with the exact recovery command', async () => {
    const output = captureConsoleText();
    try {
      await handleHomeCliCommand({
        args: ['home', 'relocate', '--target', 'dev@example.test', '--yes'],
        rawArgv: [],
        terminalRuntime: null,
      }, createRelocationOutcomeDeps({
        operationId: 'relocation-fixed',
        status: 'pending',
        destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 4,
        recoveryAction: 'return_to_source',
      }));

      expect(output.text()).not.toContain('relocation complete');
      expect(output.text()).toContain('Personal Home relocation is pending');
      expect(output.text()).toContain('--recovery-action return_to_source');
      expect(process.exitCode).toBe(1);
    } finally {
      output.restore();
    }
  });

  it('discloses retained destination cleanup attention and its exact retry command', async () => {
    const output = captureConsoleText();
    try {
      await handleHomeCliCommand({
        args: ['home', 'relocate', '--target', 'dev@example.test', '--yes'],
        rawArgv: [],
        terminalRuntime: null,
      }, createRelocationOutcomeDeps({
        operationId: 'relocation-fixed',
        status: 'committed',
        destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 4,
        destinationCleanupNeedsAttention: true,
      }));

      expect(output.text()).toContain('Personal Home relocation committed.');
      expect(output.text()).toContain('Destination cleanup needs attention.');
      expect(output.text()).toContain('--recovery-action finish_move');
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      output.restore();
    }
  });

  it('preserves relocation destination cleanup attention in successful JSON output', async () => {
    const output = captureStdoutJsonOutput<{
      ok: boolean;
      data?: { status?: string; destinationCleanupNeedsAttention?: boolean };
    }>();
    try {
      await handleHomeCliCommand({
        args: ['home', 'relocate', '--target', 'dev@example.test', '--yes', '--json'],
        rawArgv: [],
        terminalRuntime: null,
      }, createRelocationOutcomeDeps({
        operationId: 'relocation-fixed',
        status: 'committed',
        destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 4,
        destinationCleanupNeedsAttention: true,
      }));

      expect(output.json()).toMatchObject({
        ok: true,
        data: { status: 'committed', destinationCleanupNeedsAttention: true },
      });
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      output.restore();
    }
  });

  it.each([
    ['finish_move', undefined],
    ['return_to_source', 'return_to_source'],
  ] as const)('resumes an interrupted relocation with the stored operation facts using %s', async (recoveryAction, expectedRecoveryAction) => {
    const sourceDescriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const inspection = success('inspect', {
      ...nonEmptyInspectionData,
      identity: { homeServerIdentityId: 'srv_home1' },
      relocationRecovery: {
        status: 'recovery_available',
        operationId: 'relocation-retained',
        destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 3,
        primaryAction: 'finish_move',
        secondaryAction: 'return_to_source',
      },
    });
    const relocated = success('relocate', {
      action: 'personalHome.relocate',
      personalHome: {
        operationId: 'relocation-retained', status: expectedRecoveryAction ? 'returned' : 'committed',
        destinationMachineId: 'dev@example.test', sourceDescriptorRevision: 3,
      },
    });
    const { deps, start } = createDeps([homeStatus, inspection, relocated], {
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor: sourceDescriptor }),
      publishRelocationDescriptor: async ({ descriptor }) => descriptor,
      readRelocationDescriptor: async () => sourceDescriptor,
    });

    await handleHomeCommand(['relocate', '--target', 'dev@example.test', '--recovery-action', recoveryAction], deps);

    expect(start).toHaveBeenLastCalledWith({ spec: expect.objectContaining({
      kind: 'remote.ssh.manageHost.v1',
      params: expect.objectContaining({
        personalHomeRelocation: {
          operationId: 'relocation-retained',
          destinationMachineId: 'dev@example.test',
          sourceDescriptorRevision: 3,
          ...(expectedRecoveryAction ? { recoveryAction: expectedRecoveryAction } : { recoveryAction: 'finish_move' }),
        },
      }),
    }) });
  });

  it('offers only authority-safe recovery choices and refuses return after publication advanced', async () => {
    const sourceDescriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'https://destination.example.test',
      revision: 5,
      endpoints: [{ kind: 'https' as const, url: 'https://destination.example.test' }],
    };
    const inspection = success('inspect', {
      ...nonEmptyInspectionData,
      identity: { homeServerIdentityId: 'srv_home1' },
      relocationRecovery: {
        status: 'recovery_available', operationId: 'relocation-retained', destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 4, primaryAction: 'finish_move',
      },
    });
    const { deps, start } = createDeps([homeStatus, inspection], {
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor: sourceDescriptor }),
      publishRelocationDescriptor: async ({ descriptor }) => descriptor,
      readRelocationDescriptor: async () => sourceDescriptor,
    });

    await expect(handleHomeCommand([
      'relocate', '--target', 'dev@example.test', '--recovery-action', 'return_to_source',
    ], deps)).rejects.toMatchObject({ code: 'relocation_recovery_action_unavailable' });
    expect(start).toHaveBeenCalledTimes(2);

    const finished = success('relocate', {
      action: 'personalHome.relocate',
      personalHome: {
        operationId: 'relocation-retained', status: 'committed',
        destinationMachineId: 'dev@example.test', sourceDescriptorRevision: 4,
      },
    });
    const finishHarness = createDeps([homeStatus, inspection, finished], {
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor: sourceDescriptor }),
      publishRelocationDescriptor: async ({ descriptor }) => descriptor,
      readRelocationDescriptor: async () => sourceDescriptor,
    });

    await handleHomeCommand([
      'relocate', '--target', 'dev@example.test', '--recovery-action', 'finish_move',
    ], finishHarness.deps);
    expect(finishHarness.start).toHaveBeenLastCalledWith({ spec: expect.objectContaining({ params: expect.objectContaining({
      personalHomeRelocation: {
        operationId: 'relocation-retained', destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 4, recoveryAction: 'finish_move',
      },
    }) }) });
  });

  it('refuses a relocation target that does not match the retained recovery destination', async () => {
    const sourceDescriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const inspection = success('inspect', {
      ...nonEmptyInspectionData,
      identity: { homeServerIdentityId: 'srv_home1' },
      relocationRecovery: {
        status: 'recovery_available', operationId: 'relocation-retained', destinationMachineId: 'saved@example.test',
        sourceDescriptorRevision: 4, primaryAction: 'finish_move', secondaryAction: 'return_to_source',
      },
    });
    const { deps, start } = createDeps([homeStatus, inspection], {
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor: sourceDescriptor }),
      publishRelocationDescriptor: async ({ descriptor }) => descriptor,
      readRelocationDescriptor: async () => sourceDescriptor,
    });

    await expect(handleHomeCommand([
      'relocate', '--target', 'other@example.test', '--recovery-action', 'finish_move',
    ], deps)).rejects.toMatchObject({ code: 'relocation_destination_mismatch' });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('offers both retained recovery choices interactively before resuming', async () => {
    const sourceDescriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1', canonicalServerUrl: 'http://127.0.0.1:53288', revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const inspection = success('inspect', {
      ...nonEmptyInspectionData,
      identity: { homeServerIdentityId: 'srv_home1' },
      relocationRecovery: {
        status: 'recovery_available', operationId: 'relocation-retained', destinationMachineId: 'dev@example.test',
        sourceDescriptorRevision: 4, primaryAction: 'finish_move', secondaryAction: 'return_to_source',
      },
    });
    const relocated = success('relocate', {
      action: 'personalHome.relocate', personalHome: {
        operationId: 'relocation-retained', status: 'returned',
        destinationMachineId: 'dev@example.test', sourceDescriptorRevision: 4,
      },
    });
    const promptInput = vi.fn(async (_message: string) => 'return_to_source');
    const { deps, start } = createDeps([homeStatus, inspection, relocated], {
      isInteractiveTerminal: () => true,
      promptInput,
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor: sourceDescriptor }),
      publishRelocationDescriptor: async ({ descriptor }) => descriptor,
      readRelocationDescriptor: async () => sourceDescriptor,
    });

    await handleHomeCommand(['relocate', '--target', 'dev@example.test'], deps);

    expect(promptInput.mock.calls[0]?.[0]).toContain('finish_move');
    expect(promptInput.mock.calls[0]?.[0]).toContain('return_to_source');
    expect(start).toHaveBeenLastCalledWith({ spec: expect.objectContaining({ params: expect.objectContaining({
      personalHomeRelocation: expect.objectContaining({ recoveryAction: 'return_to_source' }),
    }) }) });
  });

  it('requires an explicit relocation target before starting any task', async () => {
    const { deps, start } = createDeps([]);

    await expect(handleHomeCommand(['relocate', '--yes'], deps)).rejects.toMatchObject({ code: 'invalid_params' });

    expect(start).not.toHaveBeenCalled();
  });

  it('requires confirmation before starting the relocation mutation', async () => {
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const { deps, start } = createDeps([homeStatus, relocationInspectionNone], {
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor }),
      publishRelocationDescriptor: async ({ descriptor: next }) => next,
      readRelocationDescriptor: async () => descriptor,
    });

    await expect(handleHomeCommand(['relocate', '--target', 'dev@example.test'], deps))
      .rejects.toMatchObject({ code: 'confirmation_required' });

    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledWith({ spec: expect.objectContaining({ kind: 'relay.runtime.status.v1' }) });
  });

  it('relocate --yes declines ssh.replaceHostKey and starts no transfer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const publishRelocationDescriptor = vi.fn(async () => descriptor);
    const { deps, start, respond } = createDeps([
      homeStatus,
      relocationInspectionNone,
      {
        prompt: {
          kind: 'ssh.replaceHostKey',
          data: {
            sshHost: 'dev@example.test',
            host: 'dev@example.test',
            keyType: 'ssh-ed25519',
            fingerprint: 'SHA256:replacement',
            existingFingerprint: 'SHA256:pinned',
          },
        },
        result: failure('relocation-task', 'host_trust_declined', 'SSH host trust was declined.'),
      },
    ], {
      createRelocationOperationId: () => 'relocation-fixed',
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor }),
      publishRelocationDescriptor,
      readRelocationDescriptor: async () => descriptor,
    });

    await expect(handleHomeCommand(['relocate', '--target', 'dev@example.test', '--yes'], deps))
      .rejects.toMatchObject({ code: 'host_trust_declined' });

    expect(respond).toHaveBeenCalledWith({ taskId: 'task-3', answer: { trusted: false } });
    expect(publishRelocationDescriptor).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(3);
  });

  it('relocate --yes still trusts a first-use ssh.trustHost key', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const { deps, respond } = createDeps([
      homeStatus,
      relocationInspectionNone,
      {
        prompt: {
          kind: 'ssh.trustHost',
          data: { sshHost: 'dev@example.test', host: 'dev@example.test', keyType: 'ssh-ed25519', fingerprint: 'SHA256:first-use' },
        },
        result: success('relocation-task', {
          action: 'personalHome.relocate',
          personalHome: {
            operationId: 'relocation-fixed',
            status: 'committed',
            destinationMachineId: 'dev@example.test',
            sourceDescriptorRevision: 4,
            publishedDescriptor: descriptor,
          },
        }),
      },
    ], {
      createRelocationOperationId: () => 'relocation-fixed',
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor }),
      publishRelocationDescriptor: async () => descriptor,
      readRelocationDescriptor: async () => descriptor,
    });

    await handleHomeCommand(['relocate', '--target', 'dev@example.test', '--yes'], deps);

    expect(respond).toHaveBeenCalledWith({ taskId: 'task-3', answer: { trusted: true } });
  });

  it('accepts an exact --trusted-host-key pin as the non-interactive replacement path', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_home1',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      revision: 4,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const { deps, start } = createDeps([
      homeStatus,
      relocationInspectionNone,
      success('relocation-task', {
        action: 'personalHome.relocate',
        personalHome: {
          operationId: 'relocation-fixed',
          status: 'committed',
          destinationMachineId: 'dev@example.test',
          sourceDescriptorRevision: 4,
          publishedDescriptor: descriptor,
        },
      }),
    ], {
      createRelocationOperationId: () => 'relocation-fixed',
      readRelocationSourceProfile: async () => ({ profileId: 'home-profile', name: 'My Home', descriptor }),
      publishRelocationDescriptor: async () => descriptor,
      readRelocationDescriptor: async () => descriptor,
    });

    await handleHomeCommand(
      ['relocate', '--target', 'dev@example.test', '--trusted-host-key', 'example.test ssh-ed25519 AAAAC3Nz', '--yes'],
      deps,
    );

    expect(start).toHaveBeenLastCalledWith({ spec: expect.objectContaining({ params: expect.objectContaining({
      ssh: { target: 'dev@example.test', auth: 'agent', trustedHostKey: 'example.test ssh-ed25519 AAAAC3Nz' },
    }) }) });
  });

  it('renders exact remote erase facts and keeps approval in the in-memory prompt response', async () => {
    const remoteErase: ScriptedTaskResult = {
      prompt: {
        kind: 'personal_home.confirm_remote_erase.v1',
        data: {
          sshHost: 'dev@example.test', canonicalServerUrl: 'http://127.0.0.1:53288', homeServerIdentityId: 'home-1',
          paths: ['/srv/home/db.sqlite', '/srv/home/files'], estimatedBytes: 4096,
        },
      },
      result: success('remote-erase', { action: 'personalHome.erase', personalHome: { outcome: 'completed', removedPaths: ['/srv/home/db.sqlite', '/srv/home/files'] } }),
    };
    const answers = ['no', 'yes'];
    const promptInput = vi.fn(async (_prompt: string) => answers.shift() ?? 'no');
    const { deps, start, respond } = createDeps([remoteErase], { promptInput, isInteractiveTerminal: () => true });

    await handleHomeCommand(['erase', '--ssh', 'dev@example.test'], deps);

    expect(promptInput.mock.calls[0]?.[0]).toMatch(/backup/iu);
    expect(promptInput.mock.calls[1]?.[0]).toContain('dev@example.test');
    expect(promptInput.mock.calls[1]?.[0]).toContain('home-1');
    expect(promptInput.mock.calls[1]?.[0]).toContain('/srv/home/db.sqlite');
    expect(promptInput.mock.calls[1]?.[0]).toContain('4096');
    expect(respond).toHaveBeenCalledWith({ taskId: 'task-1', answer: { confirmed: true } });
    expect(JSON.stringify(start.mock.calls)).not.toMatch(/confirmation-token|approval-stdin/u);
  });

  it('releases a cancellable remote-operation prompt through the command abort signal', async () => {
    const remoteErase: ScriptedTaskResult = {
      prompt: {
        kind: 'personal_home.confirm_remote_erase.v1',
        data: {
          sshHost: 'dev@example.test', canonicalServerUrl: 'http://127.0.0.1:53288', homeServerIdentityId: 'home-1',
          paths: ['/srv/home/db.sqlite'], estimatedBytes: 4096,
        },
      },
      result: failure('remote-erase', 'cancelled', 'cancelled'),
    };
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let declinedBackupOffer = false;
    const promptInput: HomeCommandDeps['promptInput'] = async (_prompt, options) => {
      if (!declinedBackupOffer) {
        declinedBackupOffer = true;
        return 'no';
      }
      observedSignal = options?.signal;
      controller.abort();
      options?.signal?.throwIfAborted();
      return 'yes';
    };
    const { deps, cancel, poll, respond } = createDeps([remoteErase], { promptInput, isInteractiveTerminal: () => true });

    await expect(handleHomeCommand(['erase', '--ssh', 'dev@example.test'], deps, controller.signal))
      .rejects.toMatchObject({ code: 'cancelled', personalHomeTaskFailure: true });

    expect(observedSignal).toBe(controller.signal);
    expect(cancel).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledTimes(2);
    expect(respond).not.toHaveBeenCalled();
  });

  it.each([[[]], [['--json']]])('keeps no-TTY creation without --yes mutation-free (%j)', async (flags: string[]) => {
    const createPersonalHome = vi.fn();
    const reconcileCreatedHome = vi.fn();
    const { deps, start } = createDeps([], { createPersonalHome, reconcileCreatedHome });

    await expect(handleHomeCommand(['create', ...flags], deps)).rejects.toMatchObject({ code: 'interactive_required' });
    expect(createPersonalHome).not.toHaveBeenCalled();
    expect(reconcileCreatedHome).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('writes one strict non-secret JSON creation result with --json --yes', async () => {
    const descriptor = {
      v: 1 as const,
      homeServerIdentityId: 'srv_personal_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      revision: 1,
      endpoints: [{ kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    };
    const createPersonalHome = vi.fn(async () => ({
      profileId: 'personal-home',
      homeServerIdentityId: 'srv_personal_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      accountCreated: true,
      descriptor,
    }));
    const reconcileCreatedHome = vi.fn(async () => undefined);
    const { deps } = createDeps([], { createPersonalHome, reconcileCreatedHome });
    const output = captureStdoutJsonOutput<Record<string, unknown>>();
    try {
      await handleHomeCommand(['create', '--json', '--yes'], deps);
      const parsed = output.json() as Record<string, any>;
      expect(parsed).toEqual({
        v: 1,
        ok: true,
        kind: 'personal_home_create',
        data: {
          status: 'complete',
          profileId: 'personal-home',
          homeServerIdentityId: 'srv_personal_home',
          canonicalServerUrl: 'http://127.0.0.1:43123',
          accountCreated: true,
          channel: 'stable',
          mode: 'user',
          descriptor,
          accountServiceLink: { kind: 'unable_to_attempt' },
        },
      });
      expect(JSON.stringify(parsed)).not.toMatch(/token|secret|credential|approval|qr/i);
      expect(reconcileCreatedHome).toHaveBeenCalledWith('personal-home', { quiet: true, signal: undefined });
    } finally {
      output.restore();
    }
  });

  it('forwards explicit local reconciliation authority without deriving it from --yes', async () => {
    const createPersonalHome = vi.fn(async () => ({
      profileId: 'personal-home', homeServerIdentityId: 'srv_personal_home',
      canonicalServerUrl: 'http://127.0.0.1:43123', accountCreated: true,
    }));
    const reconcileCreatedHome = vi.fn(async () => undefined);
    const { deps } = createDeps([], { createPersonalHome, reconcileCreatedHome });

    await handleHomeCommand(['create', '--yes', '--replace-services', '--switch-channel'], deps);

    expect(reconcileCreatedHome).toHaveBeenCalledWith('personal-home', {
      quiet: false,
      signal: undefined,
      replaceServices: true,
      switchChannel: true,
    });
  });

  it('keeps the compatibility --this-computer alias on the canonical create path', async () => {
    const createPersonalHome = vi.fn(async () => ({
      profileId: 'personal-home',
      homeServerIdentityId: 'srv_personal_home',
      canonicalServerUrl: 'http://127.0.0.1:43123',
      accountCreated: false,
    }));
    const { deps } = createDeps([], {
      createPersonalHome,
      reconcileCreatedHome: async () => undefined,
      isInteractiveTerminal: () => true,
      promptInput: async () => 'yes',
    });

    await handleHomeCommand(['create', '--this-computer'], deps);

    expect(createPersonalHome).toHaveBeenCalledTimes(1);
  });

  it('invokes the installed destination-local relocation task contract without exposing a data directory', async () => {
    const staged = success('stage', { operationId: 'operation-1', status: 'quarantined' });
    const { deps, start } = createDeps([homeStatus, staged]);
    await handleHomeCommand([
      'relocation-destination', 'stage',
      '--operation-id', 'operation-1',
      '--archive', '/incoming/home.tar',
      '--bundle-sha256', 'a'.repeat(64),
      '--expected-home-id', 'home-1',
      '--expected-canonical-server-url', 'https://source.example.test',
      '--source-descriptor-revision', '7',
      '--json',
    ], deps);
    expect(start).toHaveBeenNthCalledWith(2, { spec: expect.objectContaining({
      kind: PERSONAL_HOME_SYSTEM_TASK_KINDS.relocationDestinationStage,
      params: expect.objectContaining({
        operationId: 'operation-1',
        archivePath: '/incoming/home.tar',
        expectedCanonicalServerUrl: 'https://source.example.test',
        sourceDescriptorRevision: 7,
      }),
    }) });
    const params = (start.mock.calls[1]?.[0] as { spec: SystemTaskSpec }).spec.params as Record<string, unknown>;
    expect(params).not.toHaveProperty('destinationDataDir');
  });

  it('projects only the non-secret upload locator from a destination transfer reservation', async () => {
    // The reservation carries its receipt token; only the locator may be projected.
    const prepareRelocationUpload = vi.fn(async () => ({
      operationId: 'remote-verify-1',
      uploadLocator: '/tmp/happier-transfer/bundle.tar',
      uploadReceipt: '11111111-1111-4111-8111-111111111111',
    }));
    const { deps } = createDeps([homeStatus], { prepareRelocationUpload });
    const output = captureStdoutJsonOutput<Record<string, unknown>>();
    try {
      await handleHomeCommand([
        'relocation-destination', 'stage', '--operation-id', 'remote-verify-1', '--prepare-upload', '--json',
      ], deps);
      expect(output.json()).toMatchObject({
        kind: 'personal_home_task_result',
        result: { data: { operationId: 'remote-verify-1', uploadLocator: '/tmp/happier-transfer/bundle.tar' } },
      });
      expect(JSON.stringify(output.json())).not.toContain('uploadReceipt');
      expect(JSON.stringify(output.json())).not.toContain('11111111-1111-4111-8111-111111111111');
    } finally {
      output.restore();
    }
  });

  it('composes the real secret-free CLI upload reservation with the SSH relocation destination', async () => {
    const operationId = 'remote-relocation-secret-free';
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'happier-relocation-ssh-composed-'));
    const archivePath = join(temporaryDirectory, 'source.tar');
    const destinationArgs: string[][] = [];
    const archiveBytes = 'relocation bundle bytes';
    const bundleSha256 = createHash('sha256').update(archiveBytes).digest('hex');
    await writeFile(archivePath, archiveBytes);
    const stagedFacts = {
      operationId,
      status: 'quarantined',
      bundleSha256,
      expectedHomeServerIdentityId: 'srv_home1',
      expectedCanonicalServerUrl: 'https://source.example.test',
      sourceDescriptorRevision: 7,
      homeServerIdentityId: 'srv_home1',
      authenticated: true,
      accountCount: 1,
      sessionCount: 0,
      connectionDescriptor: {
        v: 1,
        homeServerIdentityId: 'srv_home1',
        canonicalServerUrl: 'https://destination.example.test',
        revision: 8,
        endpoints: [{ kind: 'https', url: 'https://destination.example.test' }],
      },
    } as const;
    const runPersonalHomeCommand = async ({ args }: { args: readonly string[] }): Promise<SystemTaskJsonObject> => {
      destinationArgs.push([...args]);
      if (!args.includes('--prepare-upload')) return stagedFacts;
      const output = captureStdoutJsonOutput<{
        result: { data: SystemTaskJsonObject };
      }>();
      try {
        await handleHomeCommand(args.slice(1), createDeps([homeStatus]).deps);
        return output.json().result.data;
      } finally {
        output.restore();
      }
    };
    const destination = createRemoteSshPersonalHomeRelocationDestination({
      ssh: { target: 'destination.example.test', auth: 'agent' },
      auth: { mode: 'agent' },
      knownHostsMode: 'app',
      channel: 'stable',
      mode: 'user',
      runPersonalHomeCommand,
      transferPersonalHomeArchive: async ({ localPath, remotePath }) => {
        await copyFile(localPath, remotePath);
      },
      ensureRuntime: async () => undefined,
    });

    try {
      await expect(destination.stage({
        operationId,
        archivePath,
        bundleSha256,
        expectedHomeServerIdentityId: 'srv_home1',
        expectedCanonicalServerUrl: 'https://source.example.test',
        sourceDescriptorRevision: 7,
      })).resolves.toEqual(stagedFacts);
      expect(destinationArgs.flat()).not.toContain('--upload-receipt');
    } finally {
      await cleanupPersonalHomeRelocationUpload({ operationId }).catch(() => undefined);
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('cleans the exact destination-owned transfer reservation after a successful stage', async () => {
    const consumeRelocationUpload = vi.fn(async () => ({ archivePath: '/tmp/relocation-operation/bundle.tar' }));
    const cleanupRelocationUpload = vi.fn(async () => undefined);
    const staged = success('stage', { operationId: 'operation-1', status: 'quarantined' });
    const { deps, start } = createDeps([homeStatus, staged], { consumeRelocationUpload, cleanupRelocationUpload });

    await handleHomeCommand([
      'relocation-destination', 'stage',
      '--operation-id', 'operation-1',
      '--bundle-sha256', 'a'.repeat(64),
      '--expected-home-id', 'home-1',
      '--expected-canonical-server-url', 'https://source.example.test',
      '--source-descriptor-revision', '7',
      '--json',
    ], deps);

    expect(consumeRelocationUpload).toHaveBeenCalledWith({ operationId: 'operation-1' });
    expect(cleanupRelocationUpload).toHaveBeenCalledTimes(1);
    expect(cleanupRelocationUpload).toHaveBeenCalledWith({ operationId: 'operation-1' });
    const params = (start.mock.calls[1]?.[0] as { spec: SystemTaskSpec }).spec.params as Record<string, unknown>;
    expect(params).toMatchObject({ operationId: 'operation-1', archivePath: '/tmp/relocation-operation/bundle.tar' });
  });

  it('still cleans the destination-owned transfer reservation when the stage task fails', async () => {
    const consumeRelocationUpload = vi.fn(async () => ({ archivePath: '/tmp/relocation-operation/bundle.tar' }));
    const cleanupRelocationUpload = vi.fn(async () => undefined);
    const { deps } = createDeps(
      [homeStatus, failure('stage', 'relocation_stage_failed', 'restore failed')],
      { consumeRelocationUpload, cleanupRelocationUpload },
    );

    await expect(handleHomeCommand([
      'relocation-destination', 'stage',
      '--operation-id', 'operation-1',
      '--bundle-sha256', 'a'.repeat(64),
      '--expected-home-id', 'home-1',
      '--expected-canonical-server-url', 'https://source.example.test',
      '--source-descriptor-revision', '7',
      '--json',
    ], deps)).rejects.toMatchObject({ code: 'relocation_stage_failed' });
    expect(cleanupRelocationUpload).toHaveBeenCalledTimes(1);
    expect(cleanupRelocationUpload).toHaveBeenCalledWith({ operationId: 'operation-1' });
  });

  it('surfaces cleanup attention when staging and reservation cleanup both fail', async () => {
    const consumeRelocationUpload = vi.fn(async () => ({ archivePath: '/tmp/relocation-operation/bundle.tar' }));
    const cleanupRelocationUpload = vi.fn(async () => { throw new Error('cleanup failed'); });
    const { deps } = createDeps(
      [homeStatus, failure('stage', 'relocation_stage_failed', 'restore failed')],
      { consumeRelocationUpload, cleanupRelocationUpload },
    );

    const error = await handleHomeCommand([
      'relocation-destination', 'stage',
      '--operation-id', 'operation-1',
      '--bundle-sha256', 'a'.repeat(64),
      '--expected-home-id', 'home-1',
      '--expected-canonical-server-url', 'https://source.example.test',
      '--source-descriptor-revision', '7',
      '--json',
    ], deps).then(() => null, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(PersonalHomeRelocationTransferCleanupError);
    expect(error).toMatchObject({ transferCleanupNeedsAttention: true });
    expect(String((error as Error).message)).not.toContain('/tmp/relocation-operation');
  });

  it('cleans the destination-owned transfer reservation when the upload cannot be consumed', async () => {
    const consumeRelocationUpload = vi.fn(async () => {
      throw new Error('Personal Home relocation upload receipt does not match the reserved transfer.');
    });
    const cleanupRelocationUpload = vi.fn(async () => undefined);
    const { deps } = createDeps([homeStatus], { consumeRelocationUpload, cleanupRelocationUpload });

    await expect(handleHomeCommand([
      'relocation-destination', 'stage',
      '--operation-id', 'operation-1',
      '--bundle-sha256', 'a'.repeat(64),
      '--expected-home-id', 'home-1',
      '--expected-canonical-server-url', 'https://source.example.test',
      '--source-descriptor-revision', '7',
      '--json',
    ], deps)).rejects.toThrow('does not match the reserved transfer');
    expect(cleanupRelocationUpload).toHaveBeenCalledTimes(1);
    expect(cleanupRelocationUpload).toHaveBeenCalledWith({ operationId: 'operation-1' });
  });

  it('selects the existing live task composition with explicit runtime channel and mode', async () => {
    const createRunner = vi.fn((runtime: Readonly<{ channel: 'stable' | 'preview' | 'dev'; mode: 'user' | 'system' }>) => createDeps([homeStatus, success('inspect', nonEmptyInspectionData)]).deps.createRunner(runtime));
    const deps: HomeCommandDeps = {
      ...createDeps([]).deps,
      createRunner,
    };

    await handleHomeCommand(['status', '--channel', 'preview', '--mode', 'system'], deps);

    expect(createRunner).toHaveBeenCalledWith({ channel: 'preview', mode: 'system' });
  });

  it('accepts ephemeral stdin approval only when the final owner prompt facts match exactly', async () => {
    const approved = success('erase', { outcome: 'erased', removedPaths: ['/data/home/database/home.sqlite', '/data/home/files/public'] });
    const approval = JSON.stringify({
      v: 1,
      operation: 'erase',
      canonicalServerUrl: 'http://127.0.0.1:53288',
      homeServerIdentityId: 'home-1',
      paths: ['/data/home/database/home.sqlite', '/data/home/files/public'],
      estimatedBytes: 4096,
      confirmed: true,
    });
    const { deps, respond } = createDeps([homeStatus, erasePrompt(approved)], {
      readApprovalInput: async () => approval,
    });

    await handleHomeCommand(['erase', '--approval-stdin'], deps);

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ answer: { confirmed: true } }));
  });

  it.each([
    ['operation mismatch', JSON.stringify({ v: 1, operation: 'restore', canonicalServerUrl: 'http://127.0.0.1:53288', homeServerIdentityId: 'home-1', paths: ['/data/home/database/home.sqlite', '/data/home/files/public'], estimatedBytes: 4096, confirmed: true })],
    ['canonical URL mismatch', JSON.stringify({ v: 1, operation: 'erase', canonicalServerUrl: 'http://127.0.0.1:9999', homeServerIdentityId: 'home-1', paths: ['/data/home/database/home.sqlite', '/data/home/files/public'], estimatedBytes: 4096, confirmed: true })],
    ['Home identity mismatch', JSON.stringify({ v: 1, operation: 'erase', canonicalServerUrl: 'http://127.0.0.1:53288', homeServerIdentityId: 'other-home', paths: ['/data/home/database/home.sqlite', '/data/home/files/public'], estimatedBytes: 4096, confirmed: true })],
    ['path mismatch', JSON.stringify({ v: 1, operation: 'erase', canonicalServerUrl: 'http://127.0.0.1:53288', homeServerIdentityId: 'home-1', paths: ['/data/home/database/home.sqlite'], estimatedBytes: 4096, confirmed: true })],
    ['byte estimate mismatch', JSON.stringify({ v: 1, operation: 'erase', canonicalServerUrl: 'http://127.0.0.1:53288', homeServerIdentityId: 'home-1', paths: ['/data/home/database/home.sqlite', '/data/home/files/public'], estimatedBytes: 4097, confirmed: true })],
    ['extra field', JSON.stringify({ v: 1, operation: 'erase', canonicalServerUrl: 'http://127.0.0.1:53288', homeServerIdentityId: 'home-1', paths: ['/data/home/database/home.sqlite', '/data/home/files/public'], estimatedBytes: 4096, confirmed: true, token: 'not-accepted' })],
    ['malformed JSON', '{'],
    ['EOF', ''],
  ])('fails the final owner prompt closed for %s in ephemeral stdin approval', async (_label, approvalInput) => {
    const declined = failure('erase', 'confirmation_required', 'not confirmed');
    const { deps, respond } = createDeps([homeStatus, erasePrompt(declined)], {
      readApprovalInput: async () => approvalInput,
    });
    await expect(handleHomeCommand(['erase', '--approval-stdin'], deps)).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ answer: { confirmed: false } }));
  });

  it('fails a malformed final owner erase prompt closed without consuming stdin approval', async () => {
    const declined = failure('erase', 'confirmation_required', 'not confirmed');
    const malformedPrompt: ScriptedTaskResult = {
      prompt: {
        kind: 'personal_home.confirm_erase.v1',
        data: {
          canonicalServerUrl: 'http://127.0.0.1:53288',
          homeServerIdentityId: '',
          paths: ['/data/home/database/home.sqlite'],
          estimatedBytes: 1,
        },
      },
      result: declined,
    };
    const readApprovalInput = vi.fn(async () => '{}');
    const { deps, respond } = createDeps([homeStatus, malformedPrompt], { readApprovalInput });

    await expect(handleHomeCommand(['erase', '--approval-stdin'], deps)).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ answer: { confirmed: false } }));
    expect(readApprovalInput).not.toHaveBeenCalled();
  });

  it('fails an incomplete erase preview closed without consuming stdin approval', async () => {
    const declined = failure('erase', 'confirmation_required', 'not confirmed');
    const incompletePrompt: ScriptedTaskResult = {
      prompt: {
        kind: 'personal_home.confirm_erase.v1',
        data: {
          canonicalServerUrl: 'http://127.0.0.1:53288',
          homeServerIdentityId: 'home-1',
          paths: ['/data/home/database/home.sqlite'],
          estimatedBytes: 1,
          previewComplete: false,
          previewReason: 'inspection cancelled',
        },
      },
      result: declined,
    };
    const readApprovalInput = vi.fn(async () => '{}');
    const { deps, respond } = createDeps([homeStatus, incompletePrompt], { readApprovalInput });

    await expect(handleHomeCommand(['erase', '--approval-stdin'], deps)).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ answer: { confirmed: false } }));
    expect(readApprovalInput).not.toHaveBeenCalled();
  });
  it('inspects and explicitly confirms rollback recovery through the restore task kind', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const recoverable = success('inspect', { ...nonEmptyInspectionData, restoreRecovery: { status: 'rollback_available', affectedTargets: ['/data/home', '/data/home.rollback'] } });
    const recovered = success('recover', { outcome: 'rolled_back', affectedTargets: ['/data/home', '/data/home.rollback'] });
    const { deps, start } = createDeps([homeStatus, recoverable, recovered]);
    await handleHomeCommand(['recover-restore', '--yes'], deps);
    expect(start).toHaveBeenNthCalledWith(3, { spec: expect.objectContaining({
      kind: PERSONAL_HOME_SYSTEM_TASK_KINDS.restore,
      params: expect.objectContaining({ action: 'recover' }),
    }) });
  });

  it('returns a stable no-op without starting recovery when no restore recovery is needed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, start } = createDeps([homeStatus, nonEmptyInspection]);
    await handleHomeCommand(['recover-restore'], deps);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('fails closed without mutation for ambiguous restore recovery', async () => {
    const ambiguous = success('inspect', { ...nonEmptyInspectionData, restoreRecovery: { status: 'ambiguous', affectedTargets: ['/data/home'] } });
    const { deps, start } = createDeps([homeStatus, ambiguous]);
    await expect(handleHomeCommand(['recover-restore', '--yes'], deps)).rejects.toMatchObject({ code: 'restore_recovery_ambiguous' });
    expect(start).toHaveBeenCalledTimes(2);
  });
  it('rejects completed restore finalization facts through recover-restore', async () => {
    const finalization = success('inspect', { ...nonEmptyInspectionData, restoreRecovery: { status: 'finalization_available', affectedTargets: ['/data/home', '/data/home.rollback'] } });
    const { deps, start } = createDeps([homeStatus, finalization]);

    await expect(handleHomeCommand(['recover-restore', '--yes'], deps))
      .rejects.toMatchObject({ code: 'personal_home_inspection_incomplete' });

    expect(start).toHaveBeenCalledTimes(2);
  });

  it('does not expose the removed finalize-restore command', async () => {
    const { deps, start } = createDeps([homeStatus]);

    await expect(handleHomeCommand(['finalize-restore', '--yes'], deps))
      .rejects.toThrow('Unknown home subcommand: finalize-restore');

    expect(start).toHaveBeenCalledOnce();
  });
  it('starts the exact backup task with a normalized output path and authoritative purpose', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const backup = success('backup', { path: '/work/backup.tar', sha256: 'abc', manifest: { homeServerIdentityId: 'home-1' } });
    const { deps, start } = createDeps([homeStatus, backup]);

    await handleHomeCommand(['backup', '--output', './backup.tar'], deps);

    expect(start).toHaveBeenNthCalledWith(2, { spec: {
      protocolVersion: 1,
      kind: PERSONAL_HOME_SYSTEM_TASK_KINDS.backup,
      params: {
        target: { kind: 'local' },
        channel: 'stable',
        mode: 'user',
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:53288' },
        outputPath: '/work/backup.tar',
      },
    } });
  });

  it('warns when backup bytes exist but the Home needs attention', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const backup = success('backup', { path: '/work/backup.tar', sha256: 'abc', homeNeedsAttention: true });
    const { deps } = createDeps([homeStatus, backup]);

    await handleHomeCommand(['backup'], deps);

    expect(output.mock.calls.flat().join('\n')).toMatch(/Home needs attention: true/iu);
  });

  it('rejects home status for a generic managed runtime before starting inspect', async () => {
    const genericStatus = success('status', { installed: true, purpose: { kind: 'generic' } });
    const { deps, start } = createDeps([genericStatus]);

    await expect(handleHomeCommand(['status'], deps)).rejects.toThrow(/not a Personal Home/i);
    expect(start).toHaveBeenCalledOnce();
  });

  it('prints an incomplete backup inventory as a lower bound', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const incompleteInspection = success('inspect', {
      ...nonEmptyInspectionData,
      storage: {
        ...(nonEmptyInspectionData.storage as SystemTaskJsonObject),
        backupsCount: 32,
        backupsCountComplete: false,
      },
    });
    const { deps } = createDeps([homeStatus, incompleteInspection]);

    await handleHomeCommand(['status'], deps);

    expect(log.mock.calls.flat().join('\n')).toContain('Backup archives: 32+');
  });

  it('verifies before restore and never starts restore when confirmation is declined', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const verified = success('verify', {
      identityMatchesCurrentHome: 'match',
      manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
    });
    const { deps, start } = createDeps([homeStatus, nonEmptyInspection, verified], {
      isInteractiveTerminal: () => true,
      promptInput: async () => 'no',
    });

    await expect(handleHomeCommand(['restore', './backup.tar'], deps)).rejects.toThrow(/not confirmed/i);
    expect(start.mock.calls.map(([input]) => input.spec.kind)).toEqual([
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect,
      PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup,
    ]);
  });

  it('does not start restore when the verification task fails', async () => {
    const failedVerification: SystemTaskResult = {
      protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
      taskId: 'verify',
      ok: false,
      error: { code: 'archive_hash_mismatch', message: 'Backup verification failed.' },
    };
    const { deps, start } = createDeps([homeStatus, nonEmptyInspection, failedVerification]);

    await expect(handleHomeCommand(['restore', './backup.tar', '--yes'], deps))
      .rejects.toMatchObject({ code: 'archive_hash_mismatch' });
    expect(start.mock.calls.map(([input]) => input.spec.kind)).toEqual([
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect,
      PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup,
    ]);
  });

  it('verifies before restore and --yes starts the exact confirmed restore task', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const verified = success('verify', {
      identityMatchesCurrentHome: 'match',
      manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
    });
    const restored = success('restore', { outcome: 'restored' });
    const { deps, start } = createDeps([homeStatus, nonEmptyInspection, verified, restored]);

    await handleHomeCommand(['restore', './backup.tar', '--yes'], deps);

    expect(start).toHaveBeenNthCalledWith(4, { spec: {
      protocolVersion: 1,
      kind: PERSONAL_HOME_SYSTEM_TASK_KINDS.restore,
      params: {
        target: { kind: 'local' },
        channel: 'stable',
        mode: 'user',
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:53288' },
        archivePath: '/work/backup.tar',
        confirmOverwrite: true,
        expectedHomeServerIdentityId: 'home-1',
      },
    } });
  });

  it('prints retained restore recovery facts and rejects a rolled-back restore outcome', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const verified = success('verify', {
      identityMatchesCurrentHome: 'match',
      manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
    });
    const restored = success('restore', {
      outcome: 'rolled_back',
      error: 'activated Home identity did not match',
      rollbackPaths: ['/data/home.rollback', '/config/server.env.rollback'],
    });
    const { deps } = createDeps([homeStatus, nonEmptyInspection, verified, restored]);

    await expect(handleHomeCommand(['restore', './backup.tar', '--yes'], deps)).rejects.toMatchObject({
      code: 'personal_home_restore_incomplete',
    });
    const stdout = output.mock.calls.flat().join('\n');
    expect(stdout).toContain('Outcome: rolled_back');
    expect(stdout).toContain('Restore error: activated Home identity did not match');
    expect(stdout).toContain('Rollback retained at: /data/home.rollback');
    expect(stdout).toContain('Rollback retained at: /config/server.env.rollback');
  });

  it('requires --yes for a noninteractive restore into an owner-proven non-empty destination', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const verified = success('verify', {
      identityMatchesCurrentHome: 'match',
      manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
    });
    const { deps, start } = createDeps([homeStatus, nonEmptyInspection, verified]);

    await expect(handleHomeCommand(['restore', './backup.tar'], deps)).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(start.mock.calls.some(([input]) => input.spec.kind === PERSONAL_HOME_SYSTEM_TASK_KINDS.restore)).toBe(false);
  });

  it('restores a verified archive into an owner-proven empty destination without overwrite confirmation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const verified = success('verify', {
      identityMatchesCurrentHome: 'unknown',
      manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-from-backup' },
    });
    const restored = success('restore', { outcome: 'restored' });
    const { deps, start } = createDeps([homeStatus, emptyInspection, verified, restored]);

    await handleHomeCommand(['restore', './backup.tar'], deps);

    expect(start).toHaveBeenNthCalledWith(4, { spec: {
      protocolVersion: 1,
      kind: PERSONAL_HOME_SYSTEM_TASK_KINDS.restore,
      params: {
        target: { kind: 'local' },
        channel: 'stable',
        mode: 'user',
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:53288' },
        archivePath: '/work/backup.tar',
        expectedHomeServerIdentityId: 'home-from-backup',
      },
    } });
  });

  it('keeps a verified identity mismatch fail-closed even when the destination is empty', async () => {
    const verified = success('verify', {
      identityMatchesCurrentHome: 'mismatch',
      manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'other-home' },
    });
    const { deps, start } = createDeps([homeStatus, emptyInspection, verified]);

    await expect(handleHomeCommand(['restore', './backup.tar'], deps)).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(start.mock.calls.some(([input]) => input.spec.kind === PERSONAL_HOME_SYSTEM_TASK_KINDS.restore)).toBe(false);
  });

  it('noninteractive erase without --yes answers the owner prompt negatively and leaves no waiting task', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const declined = failure('erase', 'confirmation_required', 'Personal Home data deletion was not explicitly confirmed.');
    const { deps, start, respond } = createDeps([homeStatus, erasePrompt(declined)]);

    await expect(handleHomeCommand(['erase'], deps)).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(start.mock.calls.map(([input]) => input.spec.kind)).toEqual([
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.erase,
    ]);
    expect(respond).toHaveBeenCalledWith({ taskId: 'task-2', answer: { confirmed: false } });
  });

  it('prints partial erase facts and rejects a partial outcome', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const erased = success('erase', {
      outcome: 'partial',
      removedPaths: ['/data/home/database/home.sqlite'],
      remainingOwnedPaths: ['/data/home/files/private'],
      remainingUnknownPaths: ['/data/home/files/private/mystery'],
      stoppedRunningHome: true,
      error: 'permission denied',
    });
    const { deps } = createDeps([homeStatus, erasePrompt(erased)]);

    await expect(handleHomeCommand(['erase', '--yes'], deps)).rejects.toMatchObject({
      code: 'personal_home_erase_incomplete',
    });
    const stdout = output.mock.calls.flat().join('\n');
    expect(stdout).toContain('Erase error: permission denied');
    expect(stdout).toContain('Removed: /data/home/database/home.sqlite');
    expect(stdout).toContain('Remaining owned: /data/home/files/private');
    expect(stdout).toContain('Remaining unknown: /data/home/files/private/mystery');
    expect(stdout).toContain('Stopped running Home: true');
  });

  it('uses --yes only for erase and never adds a preliminary backup prompt', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const erased = success('erase', { removedPaths: ['/data/home'] });
    const prompt = vi.fn(async () => 'yes');
    const { deps, start, respond } = createDeps([homeStatus, erasePrompt(erased)], {
      isInteractiveTerminal: () => true,
      promptInput: prompt,
    });

    await handleHomeCommand(['erase', '--yes'], deps);

    expect(start.mock.calls.map(([input]) => input.spec.kind)).toEqual([
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.erase,
    ]);
    // Erase confirmation is answered through the owner prompt, never carried as a task param.
    expect(start).toHaveBeenNthCalledWith(2, { spec: expect.objectContaining({
      kind: PERSONAL_HOME_SYSTEM_TASK_KINDS.erase,
      params: expect.not.objectContaining({ confirmErase: expect.anything() }),
    }) });
    expect(prompt).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({ taskId: 'task-2', answer: { confirmed: true } });
  });

  it('requires --backup-first before --backup-output and keeps both flags on erase only', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, start } = createDeps([homeStatus]);

    await expect(handleHomeCommand(['erase', '--backup-output', '/safe/verified.tar', '--yes'], deps))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handleHomeCommand(['backup', '--backup-first', '--backup-output', '/safe/verified.tar'], deps))
      .rejects.toMatchObject({ code: 'invalid_params' });
    await expect(handleHomeCommand(['erase', '--backup-first', '--backup-output', '/safe/verified.tar', '--approval-stdin'], deps))
      .rejects.toMatchObject({ code: 'invalid_params' });

    expect(start).not.toHaveBeenCalled();
  });

  it('interactive erase declines at the single exact owner-held path prompt after declining the backup offer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const answers = ['no', 'no'];
    const prompt = vi.fn(async (_message: string) => answers.shift() ?? 'no');
    const declined = failure('erase', 'confirmation_required', 'Personal Home data deletion was not explicitly confirmed.');
    const { deps, start } = createDeps([homeStatus, erasePrompt(declined)], {
      isInteractiveTerminal: () => true,
      promptInput: prompt,
    });

    await expect(handleHomeCommand(['erase'], deps)).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(prompt.mock.calls[0]?.[0]).toMatch(/backup/iu);
    expect(prompt.mock.calls[1]?.[0]).toContain('http://127.0.0.1:53288');
    expect(prompt.mock.calls[1]?.[0]).toContain('home-1');
    expect(prompt.mock.calls[1]?.[0]).toContain('/data/home/database/home.sqlite');
    expect(prompt.mock.calls[1]?.[0]).toContain('4096');
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(start.mock.calls.some(([input]) => input.spec.kind === PERSONAL_HOME_SYSTEM_TASK_KINDS.backup)).toBe(false);
    expect(start.mock.calls.some(([input]) => input.spec.kind === PERSONAL_HOME_SYSTEM_TASK_KINDS.erase)).toBe(true);
  });

  it('offers a verified backup before the interactive erase confirmation and runs each owner exactly once', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const answers = ['yes', '/safe/pre-erase.tar', 'yes'];
    const prompt = vi.fn(async (_message: string) => answers.shift() ?? 'no');
    const erased = success('erase', { outcome: 'completed', removedPaths: ['/data/home'] });
    const { deps, start, respond } = createDeps(
      [homeStatus, nonEmptyInspection, preEraseBackup, preEraseVerification, homeStatus, erasePrompt(erased)],
      { isInteractiveTerminal: () => true, promptInput: prompt },
    );

    await handleHomeCommand(['erase'], deps);

    expect(start.mock.calls.map(([input]) => input.spec.kind)).toEqual([
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect,
      PERSONAL_HOME_SYSTEM_TASK_KINDS.backup,
      PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup,
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.erase,
    ]);
    expect(start).toHaveBeenNthCalledWith(3, { spec: expect.objectContaining({
      kind: PERSONAL_HOME_SYSTEM_TASK_KINDS.backup,
      params: expect.objectContaining({ outputPath: '/safe/pre-erase.tar' }),
    }) });
    expect(start).toHaveBeenNthCalledWith(4, { spec: expect.objectContaining({
      kind: PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup,
      params: expect.objectContaining({ archivePath: '/safe/pre-erase.tar' }),
    }) });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ taskId: 'task-6', answer: { confirmed: true } });
  });

  it('takes the verified pre-erase backup non-interactively through --backup-first', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const erased = success('erase', { outcome: 'completed', removedPaths: ['/data/home'] });
    const { deps, start, respond } = createDeps(
      [homeStatus, nonEmptyInspection, preEraseBackup, preEraseVerification, homeStatus, erasePrompt(erased)],
    );

    await handleHomeCommand(['erase', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'], deps);

    expect(start.mock.calls.map(([input]) => input.spec.kind)).toEqual([
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect,
      PERSONAL_HOME_SYSTEM_TASK_KINDS.backup,
      PERSONAL_HOME_SYSTEM_TASK_KINDS.verifyBackup,
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.erase,
    ]);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ taskId: 'task-6', answer: { confirmed: true } });
  });

  it('refuses a pre-erase backup destination inside the data this erase deletes before writing anything', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, start } = createDeps([homeStatus, nonEmptyInspection]);

    await expect(handleHomeCommand(
      ['erase', '--backup-first', '--backup-output', '/data/home/files/private/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'backup_output_required' });

    expect(start.mock.calls.map(([input]) => input.spec.kind)).toEqual([
      'relay.runtime.status.v1',
      PERSONAL_HOME_SYSTEM_TASK_KINDS.inspect,
    ]);
  });

  it('never erases when the pre-erase backup fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, start } = createDeps([
      homeStatus,
      nonEmptyInspection,
      failure('backup', 'backup_failed', 'archive write failed'),
    ]);

    await expect(handleHomeCommand(
      ['erase', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'backup_failed' });

    expect(start.mock.calls.some(([input]) => input.spec.kind === PERSONAL_HOME_SYSTEM_TASK_KINDS.erase)).toBe(false);
  });

  it('never erases while the verified backup still has an exact protected staging cleanup obligation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stagedBackup = success('backup', {
      path: '/safe/pre-erase.tar',
      sha256: 'a'.repeat(64),
      manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
      cleanupRequired: {
        kind: 'backup_staging',
        path: '/data/.personal-home-backup-stage-owned',
        error: 'injected cleanup failure',
      },
    });
    const { deps, start } = createDeps([
      homeStatus,
      nonEmptyInspection,
      stagedBackup,
      preEraseVerification,
    ]);

    await expect(handleHomeCommand(
      ['erase', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({
      code: 'personal_home_backup_cleanup_required',
      cleanupPath: '/data/.personal-home-backup-stage-owned',
    });

    expect(start.mock.calls.some(([input]) => input.spec.kind === PERSONAL_HOME_SYSTEM_TASK_KINDS.erase)).toBe(false);
  });

  it('never erases when the pre-erase backup does not verify against this Home', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const mismatched = success('verify', {
      manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
      archiveBytes: 2048,
      identityMatchesCurrentHome: 'mismatch',
    });
    const { deps, start } = createDeps([homeStatus, nonEmptyInspection, preEraseBackup, mismatched]);

    await expect(handleHomeCommand(
      ['erase', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'identity_mismatch' });

    expect(start.mock.calls.some(([input]) => input.spec.kind === PERSONAL_HOME_SYSTEM_TASK_KINDS.erase)).toBe(false);
  });

  it('aborts without deleting when the Home identity drifts after the verified backup', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const declined = failure('erase', 'confirmation_required', 'Personal Home data deletion was not explicitly confirmed.');
    const { deps, respond } = createDeps([
      homeStatus,
      nonEmptyInspection,
      preEraseBackup,
      preEraseVerification,
      homeStatus,
      erasePromptWithIdentity('home-2', declined),
    ]);

    await expect(handleHomeCommand(
      ['erase', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'identity_mismatch' });

    expect(respond).toHaveBeenCalledWith({ taskId: 'task-6', answer: { confirmed: false } });
  });

  it('aborts when the verified local backup destination enters the fresh erase set', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const declined = failure('erase', 'confirmation_required', 'Personal Home data deletion was not explicitly confirmed.');
    const { deps, respond } = createDeps([
      homeStatus,
      nonEmptyInspection,
      preEraseBackup,
      preEraseVerification,
      homeStatus,
      {
        prompt: {
          kind: 'personal_home.confirm_erase.v1',
          data: {
            canonicalServerUrl: 'http://127.0.0.1:53288',
            homeServerIdentityId: 'home-1',
            paths: ['/safe', '/data/home/database/home.sqlite'],
            estimatedBytes: 4096,
            // Complete bounded preview: the shape guard must pass so this prompt
            // reaches the intended backup-overlap drift branch (the verified
            // pre-erase backup at /safe/pre-erase.tar falls inside /safe).
            previewComplete: true,
            previewReason: null,
          },
        },
        result: declined,
      },
    ]);

    await expect(handleHomeCommand(
      ['erase', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'identity_mismatch' });

    expect(respond).toHaveBeenCalledWith({ taskId: 'task-6', answer: { confirmed: false } });
  });

  it('offers the same verified backup before remote SSH erase and confirms the remote target once', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const erased = remoteResult('remote-erase', 'personalHome.erase', { outcome: 'completed', removedPaths: ['/srv/home/db.sqlite'] });
    const { deps, start, respond } = createDeps([
      remoteEraseInspection,
      remoteResult('remote-backup', 'personalHome.backup', {
        path: '/safe/pre-erase.tar',
        sha256: 'a'.repeat(64),
        manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
      }),
      remoteResult('remote-verify', 'personalHome.verifyBackup', {
        manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
        archiveBytes: 2048,
        identityMatchesCurrentHome: 'match',
      }),
      // Creating the remote backup can legitimately grow the owned backup directory;
      // the final owner prompt must show the fresh bounded preview rather than being
      // rejected as target drift.
      remoteErasePromptWithFacts({ estimatedBytes: 8192 }, erased),
    ]);

    await handleHomeCommand(
      ['erase', '--ssh', 'dev@example.test', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    );

    expect(start.mock.calls.map(([input]) => (input.spec.params as Record<string, unknown>).action)).toEqual([
      'personalHome.status',
      'personalHome.backup',
      'personalHome.verifyBackup',
      'personalHome.erase',
    ]);
    expect(start).toHaveBeenNthCalledWith(2, { spec: expect.objectContaining({
      params: expect.objectContaining({ personalHomeOperation: { outputPath: '/safe/pre-erase.tar' } }),
    }) });
    expect(start).toHaveBeenNthCalledWith(3, { spec: expect.objectContaining({
      params: expect.objectContaining({ personalHomeOperation: { archivePath: '/safe/pre-erase.tar' } }),
    }) });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith({ taskId: 'task-4', answer: { confirmed: true } });
  });

  it('does not compare the local remote-backup destination with remote erase paths', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const erased = remoteResult('remote-erase', 'personalHome.erase', { outcome: 'completed', removedPaths: ['/srv/home/db.sqlite'] });
    const { deps, start, respond } = createDeps([
      remoteEraseInspection,
      remoteResult('remote-backup', 'personalHome.backup', {
        path: '/srv/home/files/pre-erase.tar',
        sha256: 'a'.repeat(64),
        manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
      }),
      remoteResult('remote-verify', 'personalHome.verifyBackup', {
        manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
        archiveBytes: 2048,
        identityMatchesCurrentHome: 'match',
      }),
      remoteErasePromptWithFacts({}, erased),
    ]);

    await handleHomeCommand(
      ['erase', '--ssh', 'dev@example.test', '--backup-first', '--backup-output', '/srv/home/files/pre-erase.tar', '--yes'],
      deps,
    );

    expect(start.mock.calls.map(([input]) => (input.spec.params as Record<string, unknown>).action)).toEqual([
      'personalHome.status',
      'personalHome.backup',
      'personalHome.verifyBackup',
      'personalHome.erase',
    ]);
    expect(respond).toHaveBeenCalledWith({ taskId: 'task-4', answer: { confirmed: true } });
  });

  it('rejects a replacement SSH host key after binding the remote pre-erase target even with --yes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, start, respond } = createDeps([
      remoteEraseInspection,
      {
        prompt: { kind: 'ssh.replaceHostKey', data: { sshHost: 'dev@example.test' } },
        result: failure('remote-backup', 'backup_failed', 'replacement host key was rejected'),
      },
    ]);

    await expect(handleHomeCommand(
      ['erase', '--ssh', 'dev@example.test', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'backup_failed' });

    expect(start.mock.calls.map(([input]) => (input.spec.params as Record<string, unknown>).action)).toEqual([
      'personalHome.status',
      'personalHome.backup',
    ]);
    expect(respond).toHaveBeenCalledWith({ taskId: 'task-2', answer: { trusted: false } });
  });

  it('never starts remote erase when the remote pre-erase backup fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, start } = createDeps([
      remoteEraseInspection,
      failure('remote-backup', 'backup_failed', 'archive write failed'),
    ]);

    await expect(handleHomeCommand(
      ['erase', '--ssh', 'dev@example.test', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'backup_failed' });

    expect(start.mock.calls.map(([input]) => (input.spec.params as Record<string, unknown>).action)).toEqual([
      'personalHome.status',
      'personalHome.backup',
    ]);
  });

  it('never starts remote erase when the remote pre-erase backup does not verify', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, start } = createDeps([
      remoteEraseInspection,
      remoteResult('remote-backup', 'personalHome.backup', {
        path: '/safe/pre-erase.tar',
        sha256: 'a'.repeat(64),
        manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
      }),
      remoteResult('remote-verify', 'personalHome.verifyBackup', {
        manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
        archiveBytes: 2048,
        identityMatchesCurrentHome: 'mismatch',
      }),
    ]);

    await expect(handleHomeCommand(
      ['erase', '--ssh', 'dev@example.test', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'identity_mismatch' });

    expect(start.mock.calls.map(([input]) => (input.spec.params as Record<string, unknown>).action)).toEqual([
      'personalHome.status',
      'personalHome.backup',
      'personalHome.verifyBackup',
    ]);
  });

  it.each([
    ['SSH host', { sshHost: 'other@example.test' }],
    ['canonical URL', { canonicalServerUrl: 'http://127.0.0.1:59999' }],
    ['Home identity', { homeServerIdentityId: 'home-2' }],
    ['erase paths', { paths: ['/srv/home/db.sqlite', '/srv/home/other-files'] }],
  ])('aborts remote SSH erase without deleting when the remote %s drifts after the verified backup', async (_label, changedFacts) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const declined = failure('remote-erase', 'confirmation_declined', 'Remote Personal Home erase was not confirmed.');
    const { deps, respond } = createDeps([
      remoteEraseInspection,
      remoteResult('remote-backup', 'personalHome.backup', {
        path: '/safe/pre-erase.tar',
        sha256: 'a'.repeat(64),
        manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
      }),
      remoteResult('remote-verify', 'personalHome.verifyBackup', {
        manifest: { format: 'happier-personal-home-backup', version: 1, homeServerIdentityId: 'home-1' },
        archiveBytes: 2048,
        identityMatchesCurrentHome: 'match',
      }),
      remoteErasePromptWithFacts(changedFacts, declined),
    ]);

    await expect(handleHomeCommand(
      ['erase', '--ssh', 'dev@example.test', '--backup-first', '--backup-output', '/safe/pre-erase.tar', '--yes'],
      deps,
    )).rejects.toMatchObject({ code: 'identity_mismatch' });

    expect(respond).toHaveBeenCalledWith({ taskId: 'task-4', answer: { confirmed: false } });
  });

});

describe('happier home help', () => {
  it('lists the compiled Home administration leaves beside the lifecycle commands', async () => {
    const output = captureConsoleText();
    try {
      await handleHomeCommand(['--help'], createDeps([]).deps);
    } finally {
      output.restore();
    }
    expect(output.text()).toContain('happier home create');
    // Home governance and Account administration are compiled Action leaves
    // under this root; help must not hide commands dispatch already accepts.
    for (const leaf of [
      'governance get',
      'governance eligibility get',
      'accounts list',
      'accounts search',
      'accounts role set',
      'accounts disable',
      'accounts enable',
      'accounts delete',
      'policy set',
    ]) {
      expect(output.text()).toContain(`happier home ${leaf}`);
    }
  });
});
