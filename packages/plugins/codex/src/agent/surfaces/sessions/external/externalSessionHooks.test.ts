import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateAgentExternalSessionHookMapEventResult,
  validateAgentExternalSessionHookResolveInstallationResult,
  validateAgentExternalSessionHooksContribution,
  type AgentExternalSessionHookMapEventRequest,
  type AgentExternalSessionHookResolveInstallationRequest,
} from '@happier-dev/plugin-sdk/experimental/sessions';
import type {
  PluginInvocationContext,
  PluginServices,
} from '@happier-dev/plugin-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const appServerMocks = vi.hoisted(() => ({
  createCodexNativeAppServerClient: vi.fn(),
}));

vi.mock('../../../runtime/appServer/client.js', () => ({
  createCodexNativeAppServerClient:
    appServerMocks.createCodexNativeAppServerClient,
}));

import { createCodexExternalSessionsContribution } from './contribution.js';
import {
  CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID,
  CODEX_EXTERNAL_SESSION_HOOK_WINDOWS_CMD_VARIANT_ID,
  CODEX_EXTERNAL_SESSION_HOOK_VERSION,
  createCodexExternalSessionHooksContribution,
} from './externalSessionHooks.js';
import { createCodexExternalSessionObservationContribution } from './observation.js';

const invocation = {
  signal: new AbortController().signal,
  deadlineAtMs: Number.MAX_SAFE_INTEGER,
  maxSerializedBytes: 64 * 1024,
} as const;

const readinessDiagnostic = {
  code: 'codex_hooks_approval_required',
  severity: 'warning',
  message: expect.any(String),
  remediation: { kind: 'openSettings', path: '/hooks' },
} as const;

type ResolveCustody =
  NonNullable<AgentExternalSessionHookResolveInstallationRequest['custody']>;
type CustodiedEntry = ResolveCustody['targets'][number]['entries'][number];

function custody(
  absolutePath = '/tmp/codex-hooks-list/hooks.json',
): ResolveCustody {
  const entry = (
    eventId: string,
    nativeEventName: string,
    entryIndex: number,
    command: string,
    timeout: number,
  ): CustodiedEntry => ({
    eventId,
    nativeEventName,
    entryIndex,
    entry: {
      matcher: null,
      hooks: [{ type: 'command', command, timeout }],
    },
  });
  return {
    variantId: CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID,
    targets: [{
      targetId: 'codex-user-hooks',
      absolutePath,
      entries: [
        entry(
          'codex-session-start',
          'SessionStart',
          2,
          'happier hook codex-session-start',
          5,
        ),
        entry('codex-stop', 'Stop', 1, 'happier hook codex-stop', 7),
      ],
    }],
  };
}

type HookTrustStatus = 'managed' | 'trusted' | 'untrusted' | 'modified';

function listedHook(
  entry: CustodiedEntry,
  absolutePath: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const eventKey = entry.nativeEventName === 'SessionStart'
    ? 'session_start'
    : 'stop';
  return {
    key: `${absolutePath}:${eventKey}:${entry.entryIndex}:0`,
    eventName: entry.nativeEventName === 'SessionStart'
      ? 'sessionStart'
      : 'stop',
    handlerType: 'command',
    isManaged: false,
    matcher: entry.entry.matcher,
    command: entry.entry.hooks[0].command,
    timeoutSec: entry.entry.hooks[0].timeout,
    statusMessage: null,
    sourcePath: absolutePath,
    source: 'user',
    pluginId: null,
    displayOrder: 0,
    enabled: true,
    currentHash: `sha256:${entry.eventId}`,
    trustStatus: 'trusted' as HookTrustStatus,
    additionalContextLimit: null,
    ...overrides,
  };
}

function hooksListResponse(
  custodyValue: ResolveCustody,
  hookOverrides: readonly Readonly<Record<string, unknown>>[] = [],
) {
  const target = custodyValue.targets[0]!;
  return {
    data: [{
      cwd: '/tmp/workspace',
      hooks: target.entries.map((entry, index) => listedHook(
        entry,
        target.absolutePath,
        hookOverrides[index],
      )),
      warnings: [],
      errors: [],
    }],
  };
}

function createInvocationContext(
  signal: AbortSignal,
  exec: PluginServices['exec'],
): PluginInvocationContext {
  const unavailableUi = new Proxy({}, {
    get() {
      throw new Error('UI is unavailable in this process-boundary fixture');
    },
  });
  // The app-server transport is the only system service this leaf is allowed to use.
  const services = new Proxy({ exec }, {
    get(target, property, receiver) {
      if (property === 'exec') return Reflect.get(target, property, receiver);
      throw new Error(`Unexpected plugin service access: ${String(property)}`);
    },
  }) as PluginServices;
  return {
    plugin: { id: 'happier.agent.codex' },
    contribution: {
      family: 'agents',
      localId: 'codex',
    },
    signal,
    services,
    ui: unavailableUi as PluginInvocationContext['ui'],
  };
}

function installAppServerResponse(response: unknown) {
  const request = vi.fn(async (method: string, params?: unknown) => {
    expect(method).toBe('hooks/list');
    expect(params).toEqual({ cwds: [] });
    return response;
  });
  const dispose = vi.fn(async () => undefined);
  appServerMocks.createCodexNativeAppServerClient.mockResolvedValueOnce({
    request,
    notify: vi.fn(),
    registerRequestHandler: vi.fn(),
    registerNotificationHandler: vi.fn(),
    onExit: vi.fn(),
    dispose,
  });
  return { request, dispose };
}

function resolveRequest(
  installedVersion: string,
  platform: 'darwin' | 'linux' | 'win32' = 'darwin',
  custodyValue?: ResolveCustody,
): AgentExternalSessionHookResolveInstallationRequest {
  return {
    ...invocation,
    installation: {
      installationIdentity: 'codex-installation',
      executableIdentity: 'sha256:codex',
      installedVersion,
      platform,
      architecture: 'arm64',
    },
    ...(custodyValue ? { custody: custodyValue } : {}),
  };
}

function mapRequest(
  overrides: Partial<AgentExternalSessionHookMapEventRequest> = {},
): AgentExternalSessionHookMapEventRequest {
  return {
    ...invocation,
    installationIdentity: 'codex-installation',
    variantId: CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID,
    eventId: 'codex-session-start',
    observedAtMs: 100_000,
    nativePayload: {
      session_id: 'codex-thread-a',
      cwd: '/private/project',
      hook_event_name: 'SessionStart',
      model: 'gpt-5',
      permission_mode: 'default',
      source: 'startup',
      transcript_path: '/private/transcript.jsonl',
    },
    ...overrides,
  };
}

describe('Codex External Session hooks contribution', () => {
  beforeEach(() => {
    appServerMocks.createCodexNativeAppServerClient.mockReset();
  });

  it('declares immutable POSIX and Windows cmd variants with no legacy notify surface', () => {
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-modern-hooks' },
    });
    const validated = validateAgentExternalSessionHooksContribution(contribution);

    const variant = (
      variantId: string,
      shellDialect: 'posix' | 'windows_cmd',
    ) => ({
      variantId,
      targets: [{
        targetId: 'codex-user-hooks',
        format: 'hook_event_json_arrays_v1',
        collectionId: 'codex-lifecycle-hooks',
      }],
      events: [
        {
          eventId: 'codex-session-start',
          targetId: 'codex-user-hooks',
          nativeEventName: 'SessionStart',
          command: { kind: 'happier_observation_v1', shellDialect },
        },
        {
          eventId: 'codex-stop',
          targetId: 'codex-user-hooks',
          nativeEventName: 'Stop',
          command: { kind: 'happier_observation_v1', shellDialect },
        },
      ],
    });
    expect(validated.installationVariants).toEqual([
      variant(CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID, 'posix'),
      variant(CODEX_EXTERNAL_SESSION_HOOK_WINDOWS_CMD_VARIANT_ID, 'windows_cmd'),
    ]);
    expect(Object.isFrozen(validated.installationVariants)).toBe(true);
    expect(Object.keys(contribution).sort()).toEqual([
      'installationVariants',
      'mapHookEvent',
      'resolveInstallation',
    ]);
    expect(JSON.stringify(validated)).not.toMatch(
      /adapter|recipe|planConfiguration|config\.toml|notify|nativePath|token/u,
    );
  });

  it('resolves the no-custody install target as ready and rejects wrong versions without spawning', async () => {
    const codexHome = join(tmpdir(), 'happier-codex-hook-target');
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: codexHome },
    });
    const declaredVariant = contribution.installationVariants[0];
    if (!declaredVariant) throw new Error('Missing Codex hook installation variant');

    const supported = await contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION),
      createInvocationContext(invocation.signal, {} as PluginServices['exec']),
    );
    expect(validateAgentExternalSessionHookResolveInstallationResult(
      supported,
      declaredVariant,
    )).toEqual({
      ok: true,
      value: {
        kind: 'supported',
        variantId: CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID,
        targets: [{
          targetId: 'codex-user-hooks',
          absolutePath: join(codexHome, 'hooks.json'),
        }],
        readiness: { kind: 'ready' },
      },
    });

    const windowsVariant = contribution.installationVariants[1];
    if (!windowsVariant) throw new Error('Missing Codex Windows hook variant');
    const windows = await contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'win32'),
      createInvocationContext(invocation.signal, {} as PluginServices['exec']),
    );
    expect(validateAgentExternalSessionHookResolveInstallationResult(
      windows,
      windowsVariant,
    )).toMatchObject({
      ok: true,
      value: {
        kind: 'supported',
        variantId: CODEX_EXTERNAL_SESSION_HOOK_WINDOWS_CMD_VARIANT_ID,
      },
    });

    const linux = await contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'linux'),
      createInvocationContext(invocation.signal, {} as PluginServices['exec']),
    );
    expect(validateAgentExternalSessionHookResolveInstallationResult(
      linux,
      declaredVariant,
    )).toMatchObject({
      ok: true,
      value: {
        kind: 'supported',
        variantId: CODEX_EXTERNAL_SESSION_HOOK_VARIANT_ID,
      },
    });

    for (const installedVersion of ['0.144.0', '0.145.0-alpha.1', '0.146.0']) {
      expect(await contribution.resolveInstallation(
        resolveRequest(installedVersion),
        createInvocationContext(invocation.signal, {} as PluginServices['exec']),
      )).toEqual({
        ok: true,
        value: { kind: 'unsupported', reason: 'version_unsupported' },
      });
    }
    expect(appServerMocks.createCodexNativeAppServerClient).not.toHaveBeenCalled();
  });

  it('returns ready only when every exact custodied handler is enabled and managed or trusted', async () => {
    const custodyValue = custody();
    const contribution = createCodexExternalSessionHooksContribution({
      env: {
        CODEX_HOME: '/tmp/codex-hooks-list',
        HOME: '/home/ambient-user',
        FOREIGN_SECRET: 'must-not-reach-codex',
      },
    });
    const trusted = installAppServerResponse(hooksListResponse(custodyValue));
    const exec = {} as PluginServices['exec'];

    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      createInvocationContext(invocation.signal, exec),
    ))).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'supported',
        readiness: { kind: 'ready' },
      },
    });
    expect(appServerMocks.createCodexNativeAppServerClient).toHaveBeenCalledWith({
      exec,
      processEnv: { CODEX_HOME: '/tmp/codex-hooks-list' },
      signal: invocation.signal,
    });
    expect(trusted.request).toHaveBeenCalledTimes(1);
    expect(trusted.dispose).toHaveBeenCalledTimes(1);

    const managed = installAppServerResponse(hooksListResponse(custodyValue, [
      { trustStatus: 'managed', isManaged: true },
      { trustStatus: 'managed', isManaged: true },
    ]));
    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      createInvocationContext(invocation.signal, exec),
    ))).resolves.toMatchObject({
      ok: true,
      value: { readiness: { kind: 'ready' } },
    });
    expect(managed.dispose).toHaveBeenCalledTimes(1);
  });

  it('ignores foreign hooks while matching every owned field exactly', async () => {
    const custodyValue = custody();
    const target = custodyValue.targets[0]!;
    const response = hooksListResponse(custodyValue);
    response.data[0]!.hooks.unshift(
      listedHook(target.entries[0]!, '/tmp/foreign/hooks.json', {
        trustStatus: 'modified',
        enabled: false,
      }),
      listedHook(target.entries[1]!, target.absolutePath, {
        eventName: 'postToolUse',
        trustStatus: 'untrusted',
      }),
    );
    const server = installAppServerResponse(response);
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks-list' },
    });

    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      createInvocationContext(
        invocation.signal,
        {} as PluginServices['exec'],
      ),
    ))).resolves.toMatchObject({
      ok: true,
      value: { readiness: { kind: 'ready' } },
    });
    expect(server.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not let a trusted byte-identical foreign occurrence mask the untrusted owned key', async () => {
    const custodyValue = custody();
    const target = custodyValue.targets[0]!;
    const owned = target.entries[0]!;
    const response = hooksListResponse(custodyValue);
    response.data[0]!.hooks[0]!.trustStatus = 'untrusted';
    response.data[0]!.hooks.unshift(listedHook(owned, target.absolutePath, {
      key: `${target.absolutePath}:session_start:99:0`,
      trustStatus: 'trusted',
    }));
    const server = installAppServerResponse(response);
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks-list' },
    });

    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      createInvocationContext(
        invocation.signal,
        {} as PluginServices['exec'],
      ),
    ))).resolves.toMatchObject({
      ok: true,
      value: {
        readiness: {
          kind: 'needs_attention',
          diagnostic: readinessDiagnostic,
        },
      },
    });
    expect(server.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the expected positional key is missing or malformed', async () => {
    const custodyValue = custody();
    const target = custodyValue.targets[0]!;
    const response = hooksListResponse(custodyValue);
    response.data[0]!.hooks[0]!.key =
      `${target.absolutePath}:session_start:not-an-index:0`;
    response.data[0]!.hooks.unshift(listedHook(
      target.entries[0]!,
      target.absolutePath,
      { key: `${target.absolutePath}:session_start:7:0` },
    ));
    installAppServerResponse(response);
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks-list' },
    });

    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      createInvocationContext(
        invocation.signal,
        {} as PluginServices['exec'],
      ),
    ))).resolves.toMatchObject({
      ok: true,
      value: {
        readiness: {
          kind: 'needs_attention',
          diagnostic: readinessDiagnostic,
        },
      },
    });
  });

  it('correlates an exact positional key without parsing a Windows drive-letter path', async () => {
    const custodyValue = custody('C:\\Users\\alice\\.codex\\hooks.json');
    const server = installAppServerResponse(hooksListResponse(custodyValue));
    const contribution = createCodexExternalSessionHooksContribution({
      env: {
        CODEX_HOME: 'C:\\Users\\alice\\.codex',
        FOREIGN_SECRET: 'must-not-reach-codex',
      },
    });

    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'win32', custodyValue),
      createInvocationContext(
        invocation.signal,
        {} as PluginServices['exec'],
      ),
    ))).resolves.toMatchObject({
      ok: true,
      value: { readiness: { kind: 'ready' } },
    });
    expect(server.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['untrusted', { trustStatus: 'untrusted' }],
    ['modified', { trustStatus: 'modified' }],
    ['disabled', { enabled: false }],
    ['missing', null],
    ['wrong matcher', { matcher: 'foreign' }],
    ['wrong command', { command: 'foreign command' }],
    ['wrong timeout', { timeoutSec: 999 }],
    ['wrong handler type', { handlerType: 'prompt', command: null }],
    ['wrong source path', { sourcePath: '/tmp/foreign/hooks.json' }],
    ['partial trust', { trustStatus: 'managed' }],
  ] as const)('reports generic needs-attention for %s owned custody', async (
    label,
    override,
  ) => {
    const custodyValue = custody();
    const response = hooksListResponse(custodyValue);
    if (label === 'missing') {
      response.data[0]!.hooks.splice(0, 1);
    } else if (label === 'partial trust') {
      response.data[0]!.hooks[1]!.trustStatus = 'modified';
      Object.assign(response.data[0]!.hooks[0]!, override);
    } else {
      Object.assign(response.data[0]!.hooks[0]!, override);
    }
    const server = installAppServerResponse(response);
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks-list' },
    });

    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      createInvocationContext(
        invocation.signal,
        {} as PluginServices['exec'],
      ),
    ))).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'supported',
        readiness: {
          kind: 'needs_attention',
          diagnostic: readinessDiagnostic,
        },
      },
    });
    expect(server.dispose).toHaveBeenCalledTimes(1);
  });

  it('fails closed on malformed and unavailable probes and disposes an acquired client once', async () => {
    const custodyValue = custody();
    const malformed = installAppServerResponse({
      data: [{
        cwd: '/tmp/workspace',
        hooks: [{ ...listedHook(
          custodyValue.targets[0]!.entries[0]!,
          custodyValue.targets[0]!.absolutePath,
        ), unknownField: true }],
        warnings: [],
        errors: [],
      }],
    });
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks-list' },
    });
    const context = createInvocationContext(
      invocation.signal,
      {} as PluginServices['exec'],
    );

    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      context,
    ))).resolves.toMatchObject({
      ok: true,
      value: {
        readiness: {
          kind: 'needs_attention',
          diagnostic: readinessDiagnostic,
        },
      },
    });
    expect(malformed.dispose).toHaveBeenCalledTimes(1);

    const dispose = vi.fn(async () => undefined);
    appServerMocks.createCodexNativeAppServerClient.mockResolvedValueOnce({
      request: vi.fn(async () => {
        throw new Error('app-server unavailable');
      }),
      dispose,
    });
    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      context,
    ))).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'supported',
        readiness: {
          kind: 'needs_attention',
          diagnostic: readinessDiagnostic,
        },
      },
    });
    expect(dispose).toHaveBeenCalledTimes(1);

    appServerMocks.createCodexNativeAppServerClient.mockRejectedValueOnce(
      new Error('app-server exited before initialization'),
    );
    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      context,
    ))).resolves.toMatchObject({
      ok: true,
      value: {
        kind: 'supported',
        readiness: {
          kind: 'needs_attention',
          diagnostic: readinessDiagnostic,
        },
      },
    });
  });

  it('fails closed when hooks/list exceeds its bounded message count', async () => {
    const custodyValue = custody();
    const valid = hooksListResponse(custodyValue);
    const server = installAppServerResponse({
      data: [{
        ...valid.data[0],
        warnings: Array.from({ length: 65 }, (_, index) => `warning-${index}`),
      }],
    });
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks-list' },
    });

    await expect(Promise.resolve(contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION, 'darwin', custodyValue),
      createInvocationContext(
        invocation.signal,
        {} as PluginServices['exec'],
      ),
    ))).resolves.toMatchObject({
      ok: true,
      value: {
        readiness: {
          kind: 'needs_attention',
          diagnostic: readinessDiagnostic,
        },
      },
    });
    expect(server.dispose).toHaveBeenCalledTimes(1);
  });

  it('uses the composed context signal for cancellation and leaves no client running', async () => {
    const custodyValue = custody();
    const controller = new AbortController();
    const dispose = vi.fn(async () => undefined);
    const request = vi.fn(async () => await new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new Error('aborted')),
        { once: true },
      );
    }));
    appServerMocks.createCodexNativeAppServerClient.mockResolvedValueOnce({
      request,
      dispose,
    });
    const exec = {} as PluginServices['exec'];
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks-list' },
    });
    const resultPromise = Promise.resolve(contribution.resolveInstallation(
      {
        ...resolveRequest(
          CODEX_EXTERNAL_SESSION_HOOK_VERSION,
          'darwin',
          custodyValue,
        ),
        signal: controller.signal,
      },
      createInvocationContext(controller.signal, exec),
    ));

    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledTimes(1);
    });
    controller.abort();
    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      code: 'cancelled',
    });
    expect(appServerMocks.createCodexNativeAppServerClient)
      .toHaveBeenCalledWith(expect.objectContaining({
        exec,
        signal: controller.signal,
      }));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('does not read or mutate the foreign legacy notify slot while resolving modern hooks', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-modern-hooks-'));
    const configPath = join(codexHome, 'config.toml');
    const foreignConfig = 'notify = ["foreign-notifier", "--keep-exactly"]\n';
    await writeFile(configPath, foreignConfig, 'utf8');
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: codexHome },
    });

    await contribution.resolveInstallation(
      resolveRequest(CODEX_EXTERNAL_SESSION_HOOK_VERSION),
      createInvocationContext(invocation.signal, {} as PluginServices['exec']),
    );

    await expect(readFile(configPath, 'utf8')).resolves.toBe(foreignConfig);
    expect(JSON.stringify(contribution.installationVariants)).not.toContain('notify');
  });

  it('maps SessionStart identity-only and clean Stop to qualified T/B facts', async () => {
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks' },
    });
    expect(validateAgentExternalSessionHookMapEventResult(
      await contribution.mapHookEvent(mapRequest()),
    )).toEqual({
      ok: true,
      value: {
        kind: 'mapped',
        sourceInput: { kind: 'codexHome', home: 'user' },
        remoteSessionId: 'codex-thread-a',
        facts: [],
      },
    });

    expect(validateAgentExternalSessionHookMapEventResult(
      await contribution.mapHookEvent(mapRequest({
        eventId: 'codex-stop',
        nativePayload: {
          session_id: 'codex-thread-a',
          turn_id: 'codex-turn-17',
          stop_hook_active: false,
          cwd: '/private/project',
          hook_event_name: 'Stop',
          last_assistant_message: 'private content',
          model: 'gpt-5',
          permission_mode: 'default',
          transcript_path: '/private/transcript.jsonl',
        },
      })),
    )).toEqual({
      ok: true,
      value: {
        kind: 'mapped',
        sourceInput: { kind: 'codexHome', home: 'user' },
        remoteSessionId: 'codex-thread-a',
        facts: [
          {
            kind: 'turn_phase',
            value: 'idle',
            evidenceClass: 'qualified_hook',
            observedAtMs: 100_000,
            expiresAtMs: 115_000,
          },
          {
            kind: 'completed_boundary',
            boundaryId: 'codex-turn-17',
            evidenceClass: 'qualified_hook',
            observedAtMs: 100_000,
          },
        ],
      },
    });
  });

  it('ignores recursive, unknown, mismatched, and malformed events without inventing interrupt completion', async () => {
    const contribution = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: '/tmp/codex-hooks' },
    });
    const ignoredCases: AgentExternalSessionHookMapEventRequest[] = [
      mapRequest({
        eventId: 'codex-stop',
        nativePayload: {
          session_id: 'codex-thread-a',
          turn_id: 'codex-turn-17',
          stop_hook_active: true,
        },
      }),
      mapRequest({ eventId: 'unknown-event' }),
      mapRequest({ variantId: 'unknown-variant' }),
      mapRequest({ nativePayload: { session_id: true } }),
      mapRequest({ nativePayload: [] }),
    ];

    for (const request of ignoredCases) {
      expect(await contribution.mapHookEvent(request)).toEqual({
        ok: true,
        value: { kind: 'ignored' },
      });
    }
  });

  it('feeds content-free path-free identity through the canonical source, link, and rollout-set owners', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-hook-contribution-'));
    const sessionsDir = join(codexHome, 'sessions', 'rollout-set');
    const rootFile = join(sessionsDir, 'rollout-root.jsonl');
    const sidechainFile = join(sessionsDir, 'rollout-sidechain.jsonl');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      rootFile,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-thread-a' } })}\n`,
      'utf8',
    );
    await writeFile(
      sidechainFile,
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'codex-thread-a' } })}\n`,
      'utf8',
    );

    const hooks = createCodexExternalSessionHooksContribution({
      env: { CODEX_HOME: codexHome },
    });
    const mapped = await hooks.mapHookEvent(mapRequest());
    if (!mapped.ok || mapped.value.kind !== 'mapped') {
      throw new Error('Expected mapped Codex SessionStart');
    }
    const contribution = createCodexExternalSessionsContribution({
      env: { CODEX_HOME: codexHome },
    });
    const resolvedSource = await contribution.resolveSource({
      ...invocation,
      source: mapped.value.sourceInput,
    });
    if (!resolvedSource.ok) throw new Error('Expected resolved Codex source');
    const linked = await contribution.resolveLinkIdentity({
      ...invocation,
      source: resolvedSource.value.source,
      remoteSessionId: mapped.value.remoteSessionId,
    });
    if (!linked.ok) throw new Error('Expected linked Codex identity');

    const observation = createCodexExternalSessionObservationContribution({
      env: { CODEX_HOME: codexHome },
    });
    const grouping = observation.describeResource(linked.value);
    expect(Object.keys(grouping).sort()).toEqual(['linkKey', 'resourceKey']);
    const reconciled = await observation.reconcileResource({
      purpose: 'resource_descriptors',
      resourceKey: grouping.resourceKey,
      links: [{
        linkKey: grouping.linkKey,
        linkedSource: linked.value,
      }],
      signal: new AbortController().signal,
    });
    const outcome = reconciled.outcomes[0];
    if (!outcome || outcome.kind !== 'described') {
      throw new Error('Expected an authoritative Codex resource descriptor');
    }
    expect(outcome.descriptor.watchFileChanges?.files).toEqual(
      [rootFile, sidechainFile].sort(),
    );
    expect(JSON.stringify(mapped)).not.toContain(codexHome);
    expect(JSON.stringify(mapped)).not.toMatch(
      /private content|private\/transcript|private\/project/u,
    );
    expect(mapped.value).not.toHaveProperty('createdAtMs');
    expect(mapped.value).not.toHaveProperty('linkData');
    expect(mapped.value).not.toHaveProperty('targetSessionId');
  });
});
