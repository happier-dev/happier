import { describe, expect, it } from 'vitest';

import {
  deriveBoxPublicKeyFromSeed,
  openTerminalProvisioningV3Response,
} from '@happier-dev/protocol';
import { createEnrollMachineFlowExecutorFromHappierJsonExecutor, createSystemTasksRunner, type EnrollMachineFlowExecutor } from '@happier-dev/cli-common/systemTasks';

import { createSetupThisComputerInteractiveTaskKind } from './setupThisComputerInteractiveKind.js';

/** The CLI acquisition the executor reports: managed install path, with the command it resolved. */
const MANAGED_CLI = { provenance: 'managed', command: '/home/tester/.happier/bin/happier' } as const;
/** An env/repo override: usable, but never approved for pairing without a human. */
const OVERRIDE_CLI = { provenance: 'override', command: '/repo/apps/cli/bin/happier.mjs' } as const;

async function waitForPendingPrompt(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.pendingPrompt) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected pending prompt for ${params.taskId}: ${JSON.stringify(latest)}`);
}

async function waitForResult(
  runner: ReturnType<typeof createSystemTasksRunner>,
  params: Readonly<{ taskId: string; cursor: number }>,
) {
  let latest = await runner.poll(params);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    latest = await runner.poll(params);
    if (latest.result) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Expected final result for ${params.taskId}: ${JSON.stringify(latest)}`);
}

const RELAY_SERVER_URL = 'http://127.0.0.1:3005';
const RELAY_WEBAPP_URL = 'http://127.0.0.1:3005';

type PairingFixture = Readonly<{
  seed: Uint8Array;
  publicKeyB64: string;
  pairingSecret: Uint8Array;
  pairingSecretB64Url: string;
  createdAtMs: number;
  expiresAtMs: number;
}>;

function createPairingFixture(): PairingFixture {
  const seed = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) seed[index] = index + 1;
  const pairingSecret = new Uint8Array(32);
  for (let index = 0; index < 32; index += 1) pairingSecret[index] = index + 100;
  return {
    seed,
    publicKeyB64: Buffer.from(deriveBoxPublicKeyFromSeed(seed)).toString('base64'),
    pairingSecret,
    pairingSecretB64Url: Buffer.from(pairingSecret).toString('base64url'),
    createdAtMs: 1_000_000,
    expiresAtMs: 2_000_000,
  };
}

function createUnauthenticatedPairingExecutor(
  invocations: string[],
  fixture: PairingFixture,
): EnrollMachineFlowExecutor {
  return {
    configureRelay: async () => {
      invocations.push('configureRelay');
    },
    readAuthStatus: async () => {
      invocations.push('readAuthStatus');
      return { authenticated: false, machineId: null };
    },
    requestAuthPairing: async () => {
      invocations.push('requestAuthPairing');
      return {
        publicKey: fixture.publicKeyB64,
        pairing: {
          secretB64Url: fixture.pairingSecretB64Url,
          createdAtMs: fixture.createdAtMs,
          expiresAtMs: fixture.expiresAtMs,
        },
        supportsTokenOnly: true,
        claimSecret: 'claim-secret-value',
        pairingSecret: fixture.pairingSecretB64Url,
        stateFile: '/home/tester/.happier/auth/pending/abc123.json',
      } as unknown as Readonly<{ publicKey: string } & Record<string, unknown>>;
    },
    waitForAuthPairing: async (publicKey) => {
      invocations.push(`waitForAuthPairing:${publicKey}`);
      return { machineId: 'machine-1' };
    },
    installDaemonService: async () => {
      invocations.push('installDaemonService');
    },
    startDaemonService: async () => {
      invocations.push('startDaemonService');
    },
    waitForReadyDaemon: async () => ({
      serviceInstalled: true,
      daemonRunning: true,
      needsAuth: false,
      machineId: 'machine-1',
    }),
  };
}

function noGuidanceDeps() {
  return {
    readBackgroundServiceSetupGuidance: async () => ({
      targetReleaseChannel: 'stable' as const,
      targetServerUrl: RELAY_SERVER_URL,
      currentHappierHomeDir: null,
      currentDefaultReleaseChannel: 'stable' as const,
      managedReleaseChannels: [],
      manualRelayOwner: null,
      conflictingServices: [],
      foreignHomeConflictingServices: [],
      exactDefaultServiceExists: false,
      exactDefaultServiceRunning: false,
      shouldOfferDefaultReleaseChannelSwitch: false,
      shouldPromptForManualRelayTakeover: false,
      shouldPromptForServiceReplacement: false,
    }),
    readCurrentRelayOwner: async () => null,
    switchDefaultReleaseChannel: async () => undefined,
    readServerProfileScope: async () => ({ serverId: null, activeServerId: 'cloud', selectedService: null, targetMode: 'pinned' as const }),
    upgradeCliForTokenOnlyPairing: async () => false,
  };
}

function eventJson(events: ReadonlyArray<unknown>): string {
  return JSON.stringify(events);
}

describe('setup.thisComputer.v1 pairing approval', () => {
  it('repairs local registration through the instrumented executor without exposing pairing secrets', async () => {
    const fixture = createPairingFixture();
    const request = {
      publicKey: fixture.publicKeyB64,
      pairing: { secretB64Url: fixture.pairingSecretB64Url, createdAtMs: fixture.createdAtMs, expiresAtMs: fixture.expiresAtMs },
      supportsTokenOnly: true,
    };
    let approved = false;
    const executor = createEnrollMachineFlowExecutorFromHappierJsonExecutor({
      executor: {
        runHappierText: async () => ({ status: 0, stdout: '', stderr: '' }),
        // The CLI process boundary validates what the real flow and instrumentation send.
        runHappierJson: async (args, opts) => {
          if (args.includes('status')) return { ok: true, data: {
            authenticated: true, credentialState: 'valid', machineRegistrationState: 'local-only', machineId: null,
          } };
          if (args.includes('request')) return request;
          if (args.includes('approve')) {
            expect(args).toContain('--request-json-stdin');
            expect(JSON.parse(opts?.input ?? 'null')).toEqual(request);
            approved = true;
            return { ok: true };
          }
          if (args.includes('wait')) return { machineId: 'machine-repaired' };
          return { ok: true };
        },
      },
    });
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => MANAGED_CLI,
      readActiveRelayProfile: async () => ({ serverUrl: RELAY_SERVER_URL, webappUrl: RELAY_WEBAPP_URL, localServerUrl: null }),
      createFlowExecutor: () => executor,
      ...noGuidanceDeps(),
    });
    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({ taskId: 'setup-repair-envelope', kind: 'setup.thisComputer.v1', params: {
      surface: 'desktop.ui', target: 'thisComputer', activeRelayUrl: RELAY_SERVER_URL, activeWebappUrl: RELAY_WEBAPP_URL,
      installService: false, startService: false, verifyService: false,
    } });
    const finalPoll = await waitForResult(runner, { taskId: 'setup-repair-envelope', cursor: 0 });
    expect(finalPoll.result, JSON.stringify(finalPoll.result)).toMatchObject({ ok: true, data: { machineId: 'machine-repaired' } });
    expect(approved).toBe(true);
    expect(eventJson(finalPoll.events)).not.toContain(fixture.pairingSecretB64Url);
  });

  it('configures the explicit relay before reading auth status and pairing', async () => {
    const invocations: string[] = [];
    const fixture = createPairingFixture();
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => {
        invocations.push('ensureLocalHappierTools');
        return MANAGED_CLI;
      },
      readActiveRelayProfile: async () => ({
        serverUrl: RELAY_SERVER_URL,
        webappUrl: RELAY_WEBAPP_URL,
        localServerUrl: null,
      }),
      createFlowExecutor: () => createUnauthenticatedPairingExecutor(invocations, fixture),
      ...noGuidanceDeps(),
    });

    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({
      taskId: 'setup-ordering',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: RELAY_SERVER_URL,
        activeWebappUrl: RELAY_WEBAPP_URL,
      },
    });

    // The automatic approval prompt is part of the flow; answer it so the task completes.
    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'setup-ordering', cursor: 0 });
    await runner.respond({ taskId: 'setup-ordering', answer: { approved: true } });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-ordering', cursor: promptPoll.nextCursor });
    expect(finalPoll.result?.ok).toBe(true);

    const configureRelayIndex = invocations.indexOf('configureRelay');
    const readAuthStatusIndex = invocations.indexOf('readAuthStatus');
    const requestAuthPairingIndex = invocations.indexOf('requestAuthPairing');
    expect(configureRelayIndex).toBeGreaterThan(-1);
    expect(readAuthStatusIndex).toBeGreaterThan(configureRelayIndex);
    expect(requestAuthPairingIndex).toBeGreaterThan(readAuthStatusIndex);
  });

  it('issues one blocking token-only approval prompt that exposes only the opaque response and target identity', async () => {
    const invocations: string[] = [];
    const fixture = createPairingFixture();
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => {
        invocations.push('ensureLocalHappierTools');
        return MANAGED_CLI;
      },
      readActiveRelayProfile: async () => ({
        serverUrl: RELAY_SERVER_URL,
        webappUrl: RELAY_WEBAPP_URL,
        localServerUrl: null,
      }),
      createFlowExecutor: () => createUnauthenticatedPairingExecutor(invocations, fixture),
      ...noGuidanceDeps(),
    });

    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({
      taskId: 'setup-approval',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: RELAY_SERVER_URL,
        activeWebappUrl: RELAY_WEBAPP_URL,
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'setup-approval', cursor: 0 });
    const promptData = promptPoll.pendingPrompt?.data as Record<string, unknown>;
    expect(promptData).toBeTruthy();
    // Only the opaque response, its kind, the public key, the explicit target identity, and which
    // CLI this run resolved and how — the facts the approval owner decides on (R8/R13). The
    // command is a local filesystem path, never a credential.
    expect(Object.keys(promptData).sort()).toEqual([
      'cliCommand',
      'cliProvenance',
      'kind',
      'publicKey',
      'relayUrl',
      'response',
      'responseKind',
      'webappUrl',
    ]);
    expect(promptData.cliProvenance).toBe('managed');
    expect(promptData.cliCommand).toBe(MANAGED_CLI.command);
    expect(promptData.kind).toBe('authRequest');
    expect(promptData.publicKey).toBe(fixture.publicKeyB64);
    expect(promptData.responseKind).toBe('tokenOnly');
    expect(promptData.relayUrl).toBe(RELAY_SERVER_URL);
    expect(promptData.webappUrl).toBe(RELAY_WEBAPP_URL);

    // The opaque response is the existing v3 token-only envelope, sealed with the retained
    // pairing context; opening it proves the protocol and that no credential is carried.
    const opened = openTerminalProvisioningV3Response({
      payload: new Uint8Array(Buffer.from(String(promptData.response), 'base64')),
      recipientSecretKeyOrSeed: fixture.seed,
      terminalEphemeralPublicKey: new Uint8Array(Buffer.from(fixture.publicKeyB64, 'base64')),
      pairingSecret: fixture.pairingSecret,
      createdAtMs: fixture.createdAtMs,
      expiresAtMs: fixture.expiresAtMs,
      nowMs: (fixture.createdAtMs + fixture.expiresAtMs) / 2,
    });
    expect(opened).toEqual({ type: 'tokenOnly' });

    // No pairing secret, claim secret, state file path, or bearer ever reaches task artifacts.
    const serializedEvents = eventJson(promptPoll.events);
    expect(serializedEvents).not.toContain(fixture.pairingSecretB64Url);
    expect(serializedEvents).not.toContain('claim-secret-value');
    expect(serializedEvents).not.toContain('/auth/pending');
    expect(serializedEvents.toLowerCase()).not.toMatch(/"(secret|pairingsecret|claimsecret|statefile|token)"/);

    await runner.respond({ taskId: 'setup-approval', answer: { approved: true } });
    const finalPoll = await waitForResult(runner, { taskId: 'setup-approval', cursor: promptPoll.nextCursor });
    expect(finalPoll.result).toMatchObject({ ok: true, data: { machineId: 'machine-1' } });
    expect(invocations).toContain(`waitForAuthPairing:${fixture.publicKeyB64}`);
  });

  it('fails by name when the approval owner declines, with no second approval surface to wait on', async () => {
    const invocations: string[] = [];
    const fixture = createPairingFixture();
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => {
        invocations.push('ensureLocalHappierTools');
        return MANAGED_CLI;
      },
      readActiveRelayProfile: async () => ({
        serverUrl: RELAY_SERVER_URL,
        webappUrl: RELAY_WEBAPP_URL,
        localServerUrl: null,
      }),
      createFlowExecutor: () => createUnauthenticatedPairingExecutor(invocations, fixture),
      ...noGuidanceDeps(),
    });

    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({
      taskId: 'setup-declined',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: RELAY_SERVER_URL,
        activeWebappUrl: RELAY_WEBAPP_URL,
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'setup-declined', cursor: 0 });
    await runner.respond({ taskId: 'setup-declined', answer: { approved: false } });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-declined', cursor: promptPoll.nextCursor });
    // A declined approval stops the run and says so, exactly as local repair does. Proceeding to
    // claim the pairing would pair a computer the person just refused.
    expect(finalPoll.result).toMatchObject({ ok: false, error: { code: 'approval_declined' } });
    expect(invocations).not.toContain(`waitForAuthPairing:${fixture.publicKeyB64}`);
    expect(invocations).not.toContain('installDaemonService');

    // No second, non-blocking approval prompt: nothing in the app reads one, so emitting it only
    // replaced this named failure with a silent wait for the executor timeout.
    const legacyPrompt = finalPoll.events.find((event) => (
      (event as { type?: string }).type === 'prompt'
      && (event as { data?: Record<string, unknown> }).data != null
      && (event as { data?: Record<string, unknown> }).data!.response === undefined
    ));
    expect(legacyPrompt).toBeUndefined();
  });

  it('fails closed by name when the CLI supplies no token-only pairing material', async () => {
    const invocations: string[] = [];
    const fixture = createPairingFixture();
    const executor = createUnauthenticatedPairingExecutor(invocations, fixture);
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => MANAGED_CLI,
      readActiveRelayProfile: async () => ({
        serverUrl: RELAY_SERVER_URL,
        webappUrl: RELAY_WEBAPP_URL,
        localServerUrl: null,
      }),
      createFlowExecutor: () => ({
        ...executor,
        // A CLI old enough to predate token-only pairing: a public key and nothing to seal.
        requestAuthPairing: async () => {
          invocations.push('requestAuthPairing');
          return { publicKey: fixture.publicKeyB64 };
        },
      }),
      ...noGuidanceDeps(),
    });

    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({
      taskId: 'setup-no-token-only',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: RELAY_SERVER_URL,
        activeWebappUrl: RELAY_WEBAPP_URL,
      },
    });

    const finalPoll = await waitForResult(runner, { taskId: 'setup-no-token-only', cursor: 0 });
    expect(finalPoll.result).toMatchObject({ ok: false, error: { code: 'pairing_approval_unavailable' } });
    expect(finalPoll.events.some((event) => (event as { type?: string }).type === 'prompt')).toBe(false);
    expect(invocations).not.toContain('installDaemonService');
  });

  it('replaces a managed CLI that lacks token-only pairing with the newer CLI on its channel and pairs once more', async () => {
    // R3-3: the installed managed CLI predates token-only pairing. When the channel has a newer
    // CLI, the acquisition owner replaces it and pairing is retried once with the new CLI.
    const invocations: string[] = [];
    const fixture = createPairingFixture();
    const executor = createUnauthenticatedPairingExecutor(invocations, fixture);
    let upgraded = false;
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => MANAGED_CLI,
      readActiveRelayProfile: async () => ({ serverUrl: RELAY_SERVER_URL, webappUrl: RELAY_WEBAPP_URL, localServerUrl: null }),
      createFlowExecutor: () => ({
        ...executor,
        requestAuthPairing: upgraded
          ? executor.requestAuthPairing
          : async () => {
            invocations.push('requestAuthPairing:legacy');
            return { publicKey: fixture.publicKeyB64 };
          },
      }),
      ...noGuidanceDeps(),
      upgradeCliForTokenOnlyPairing: async () => {
        invocations.push('upgradeCliForTokenOnlyPairing');
        upgraded = true;
        return true;
      },
    });

    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({
      taskId: 'setup-upgrade-token-only',
      kind: 'setup.thisComputer.v1',
      params: { surface: 'desktop.ui', target: 'thisComputer', activeRelayUrl: RELAY_SERVER_URL, activeWebappUrl: RELAY_WEBAPP_URL },
    });
    const prompt = await waitForPendingPrompt(runner, { taskId: 'setup-upgrade-token-only', cursor: 0 });
    await runner.respond({ taskId: 'setup-upgrade-token-only', answer: { approved: true } });
    const finalPoll = await waitForResult(runner, { taskId: 'setup-upgrade-token-only', cursor: prompt.nextCursor });

    expect(finalPoll.result?.ok).toBe(true);
    expect(invocations.indexOf('upgradeCliForTokenOnlyPairing')).toBeGreaterThan(invocations.indexOf('requestAuthPairing:legacy'));
    expect(invocations.lastIndexOf('requestAuthPairing')).toBeGreaterThan(invocations.indexOf('upgradeCliForTokenOnlyPairing'));
  });

  it('stamps an override-resolved CLI and its command on the prompt so the approval owner can ask about it', async () => {
    // An env/repo override went through no release verification. The executor does not decide —
    // it reports which CLI it resolved and how, and the desktop approval owner asks the person at
    // the keyboard about anything that is not `managed`, naming that exact command (R8/R13).
    const invocations: string[] = [];
    const fixture = createPairingFixture();
    const kind = createSetupThisComputerInteractiveTaskKind({
      exposeHappierCliOnPath: async () => ({ changed: false, shellReloadHint: null, failure: null, existingCommand: null }),
      ensureLocalHappierTools: async () => {
        invocations.push('ensureLocalHappierTools');
        return OVERRIDE_CLI;
      },
      readActiveRelayProfile: async () => ({
        serverUrl: RELAY_SERVER_URL,
        webappUrl: RELAY_WEBAPP_URL,
        localServerUrl: null,
      }),
      createFlowExecutor: () => createUnauthenticatedPairingExecutor(invocations, fixture),
      ...noGuidanceDeps(),
    });

    const runner = createSystemTasksRunner({ kinds: { 'setup.thisComputer.v1': kind } });
    await runner.start({
      taskId: 'setup-override-provenance',
      kind: 'setup.thisComputer.v1',
      params: {
        surface: 'desktop.ui',
        target: 'thisComputer',
        activeRelayUrl: RELAY_SERVER_URL,
        activeWebappUrl: RELAY_WEBAPP_URL,
      },
    });

    const promptPoll = await waitForPendingPrompt(runner, { taskId: 'setup-override-provenance', cursor: 0 });
    const overridePromptData = promptPoll.pendingPrompt?.data as Record<string, unknown>;
    expect(overridePromptData.cliProvenance).toBe('override');
    expect(overridePromptData.cliCommand).toBe(OVERRIDE_CLI.command);

    await runner.respond({ taskId: 'setup-override-provenance', answer: { approved: true } });
    await waitForResult(runner, { taskId: 'setup-override-provenance', cursor: promptPoll.nextCursor });
  });
});
