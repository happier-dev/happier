import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import {
  ExternalSessionAgentIdSchema,
  ExternalSessionRefSchema,
  PluginAgentContributionV2Schema,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { HostExternalSessionsAuthorService } from './privateContract';
import {
  createCurrentGlobalExternalSessionsAuthorBinding,
  createCurrentGlobalExternalSessionsAuthorService,
  type CurrentGlobalExternalSessionsAuthorService,
} from './currentGlobalAuthorService';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from './agentExternalSessionsInvocation';
import { createExternalSessionHostOperationOwner } from './hostOperationOwner';
import type { ExternalSessionFollowHostOperation } from './followHostOperation';
import type { ExternalSessionExecutionSurface } from './providerOps';

const mocks = vi.hoisted(() => ({
  ensureExternalSessionLink: vi.fn(),
  loadLinkedExternalSession: vi.fn(),
}));

vi.mock('@/api/session/external/linking/ensureExternalSessionLink', () => ({
  ensureExternalSessionLink: mocks.ensureExternalSessionLink,
}));

vi.mock('@/api/session/external/takeover/loadLinkedExternalSession', () => ({
  loadLinkedExternalSession: mocks.loadLinkedExternalSession,
}));

const unavailable = Object.freeze({
  status: 'unavailable' as const,
  code: 'test_unavailable',
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const externalSessionRef = ExternalSessionRefSchema.parse({
  agentId: ExternalSessionAgentIdSchema.parse('codex'),
  sourceId: 'codex:home',
  remoteSessionId: 'remote-1',
});

const configuredAgentDefinition = PluginAgentContributionV2Schema.parse({
  id: 'codex',
  title: 'Codex',
  runtime: { kind: 'custom' },
  primary: 'sessions',
  capabilities: {
    sessions: { open: ['create'], delivery: ['newTurn'], cancel: true },
    surfaces: ['externalSessions'],
  },
  surfaces: {
    externalSession: {
      sources: [{
        sourceKind: 'codexHome',
        terminalFollow: { userRowClassification: 'explicitV1' },
        schema: {
          fields: [
            { name: 'kind', kind: 'literal', value: 'codexHome' },
            { name: 'home', kind: 'enum', values: ['user'] },
          ],
        },
        key: {
          segments: [
            { kind: 'literal', value: 'codexHome' },
            { kind: 'homeMode', field: 'home' },
          ],
        },
        instances: [{ kind: 'default', constants: { home: 'user' } }],
      }],
    },
  },
});

const configuredAgent = Object.freeze({
  id: 'codex',
  identity: Object.freeze({ pluginId: 'happier.codex', localId: 'codex' }),
  richDefinition: Object.freeze({
    provenance: 'first_party' as const,
    definition: configuredAgentDefinition,
  }),
});

const multiSourceConfiguredAgentDefinition = PluginAgentContributionV2Schema.parse({
  ...configuredAgentDefinition,
  surfaces: {
    externalSession: {
      sources: [
        {
          sourceKind: 'codexPrimary',
          terminalFollow: { userRowClassification: 'explicitV1' },
          schema: {
            fields: [{ name: 'kind', kind: 'literal', value: 'codexPrimary' }],
          },
          key: { segments: [{ kind: 'literal', value: 'codexPrimary' }] },
          instances: [{ kind: 'default', constants: {} }],
        },
        {
          sourceKind: 'codexSecondary',
          terminalFollow: { userRowClassification: 'explicitV1' },
          schema: {
            fields: [{ name: 'kind', kind: 'literal', value: 'codexSecondary' }],
          },
          key: { segments: [{ kind: 'literal', value: 'codexSecondary' }] },
          instances: [{ kind: 'default', constants: {} }],
        },
      ],
    },
  },
});

const multiSourceConfiguredAgent = Object.freeze({
  ...configuredAgent,
  richDefinition: Object.freeze({
    provenance: 'first_party' as const,
    definition: multiSourceConfiguredAgentDefinition,
  }),
});

function createAuthorService(
  list: HostExternalSessionsAuthorService['list'],
): HostExternalSessionsAuthorService {
  return Object.freeze({
    capabilities: async () => Object.freeze({
      list: unavailable,
      attach: unavailable,
      takeover: unavailable,
      transcript: unavailable,
      follow: unavailable,
    }),
    list,
    attach: vi.fn(async () => Object.freeze({ sessionId: 'test-session' })),
    readTranscript: vi.fn(async () => Object.freeze({
      mode: 'page' as const,
      items: Object.freeze([]),
      nextCursor: null,
    })),
    followTranscript: vi.fn(async () => unavailable),
    takeover: vi.fn(async () => Object.freeze({
      sessionId: 'test-session',
      operationId: 'operation-1',
      revision: 1,
    })),
  });
}

function createCurrentOwner(
  authorService: HostExternalSessionsAuthorService,
): CurrentGlobalExternalSessionsAuthorService {
  return Object.freeze({
    authorService,
    sourceRefusals: Object.freeze([]),
    bindAuthorService: () => authorService,
    resolveAuthorSource: vi.fn(async () => Object.freeze({
      source: Object.freeze({ kind: 'testSource' }),
    })),
    compositionPort: Object.freeze({
      resolveFollowTarget: vi.fn(async () => Object.freeze({
        status: 'unavailable' as const,
        code: 'test_unavailable',
      })),
      followTranscript: vi.fn(async () => Object.freeze({
        status: 'unavailable' as const,
        code: 'test_unavailable',
      })),
    }),
    dispose: vi.fn(),
    bindCallerAuthorService: vi.fn(() => authorService),
  });
}

describe('current-global External Sessions author binding', () => {
  it('activates configured sources before reporting typed unavailable capabilities', async () => {
    const activateConfiguredSources = vi.fn(async () => {});
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => null,
      activateConfiguredSources,
    });

    expect(await binding.capabilities()).toEqual({
      list: {
        status: 'unavailable',
        code: 'plugin_external_sources_unavailable',
      },
      attach: {
        status: 'unavailable',
        code: 'plugin_external_sources_unavailable',
      },
      takeover: {
        status: 'unavailable',
        code: 'plugin_external_sources_unavailable',
      },
      transcript: {
        status: 'unavailable',
        code: 'plugin_external_sources_unavailable',
      },
      follow: {
        status: 'unavailable',
        code: 'plugin_external_sources_unavailable',
      },
    });
    expect(activateConfiguredSources).toHaveBeenCalledOnce();
    expect(activateConfiguredSources).toHaveBeenCalledWith(undefined);
  });

  it('reports caller cancellation without activating configured sources', async () => {
    const activateConfiguredSources = vi.fn(async () => {});
    const operation = new AbortController();
    operation.abort();
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => null,
      activateConfiguredSources,
    });

    expect(await binding.capabilities({ signal: operation.signal })).toEqual({
      list: { status: 'unavailable', code: 'plugin_operation_aborted' },
      attach: { status: 'unavailable', code: 'plugin_operation_aborted' },
      takeover: { status: 'unavailable', code: 'plugin_operation_aborted' },
      transcript: { status: 'unavailable', code: 'plugin_operation_aborted' },
      follow: { status: 'unavailable', code: 'plugin_operation_aborted' },
    });
    expect(activateConfiguredSources).not.toHaveBeenCalled();
  });

  it('fails closed when exact-demand activation clears the previously current owner', async () => {
    const list = vi.fn(async () => Object.freeze({
      items: Object.freeze([]),
      nextCursor: null,
    }));
    const staleService = createAuthorService(list);
    let current: CurrentGlobalExternalSessionsAuthorService | null =
      createCurrentOwner(staleService);
    const activateConfiguredSources = vi.fn(async (agentId?: string) => {
      expect(agentId).toBe('codex');
      current = null;
    });
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => current,
      activateConfiguredSources,
    });

    await expect(binding.list({ agentId: 'codex' })).rejects.toSatisfy((error: unknown) => (
      isPluginError(error)
      && error.code === 'plugin_external_sources_unavailable'
    ));
    expect(activateConfiguredSources).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it('routes through the freshly current owner after exact-demand activation replaces it', async () => {
    const staleList = vi.fn(async () => Object.freeze({
      items: Object.freeze([]),
      nextCursor: null,
    }));
    const freshPage = Object.freeze({
      items: Object.freeze([]),
      nextCursor: 'fresh-cursor',
    });
    const freshList = vi.fn(async () => freshPage);
    let current: CurrentGlobalExternalSessionsAuthorService | null =
      createCurrentOwner(createAuthorService(staleList));
    const freshOwner = createCurrentOwner(createAuthorService(freshList));
    const activateConfiguredSources = vi.fn(async () => {
      current = freshOwner;
    });
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => current,
      activateConfiguredSources,
    });

    await expect(binding.list({ agentId: 'codex' })).resolves.toBe(freshPage);
    expect(activateConfiguredSources).toHaveBeenCalledWith('codex');
    expect(staleList).not.toHaveBeenCalled();
    expect(freshList).toHaveBeenCalledOnce();
  });

  it('fences every new author operation by the caller generation before source activation or effects', async () => {
    const list = vi.fn(async () => Object.freeze({
      items: Object.freeze([]),
      nextCursor: null,
    }));
    const service = createAuthorService(list);
    const owner = createCurrentOwner(service);
    const activateConfiguredSources = vi.fn(async () => {});
    const invocationController = new AbortController();
    let callerGenerationCurrent = true;
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: invocationController.signal,
      isGenerationCurrent: () => callerGenerationCurrent,
      resolveCurrent: () => owner,
      activateConfiguredSources,
    });
    const ref = ExternalSessionRefSchema.parse({
      agentId: ExternalSessionAgentIdSchema.parse('codex'),
      sourceId: 'codex:home',
      remoteSessionId: 'remote-1',
    });

    callerGenerationCurrent = false;
    invocationController.abort();

    expect(await binding.capabilities()).toEqual({
      list: { status: 'unavailable', code: 'plugin_generation_retired' },
      attach: { status: 'unavailable', code: 'plugin_generation_retired' },
      takeover: { status: 'unavailable', code: 'plugin_generation_retired' },
      transcript: { status: 'unavailable', code: 'plugin_generation_retired' },
      follow: { status: 'unavailable', code: 'plugin_generation_retired' },
    });
    await expect(binding.list({ agentId: ref.agentId })).rejects.toMatchObject({
      code: 'plugin_generation_retired',
    });
    await expect(binding.attach(ref)).rejects.toMatchObject({
      code: 'plugin_generation_retired',
    });
    await expect(binding.readTranscript(ref, {
      mode: 'page',
      direction: 'older',
    })).rejects.toMatchObject({ code: 'plugin_generation_retired' });
    await expect(binding.followTranscript(ref, {}, vi.fn())).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_generation_retired',
    });
    await expect(binding.takeover(ref, {
      targetStorageMode: 'persisted',
      idempotencyKey: 'takeover-1',
    })).rejects.toMatchObject({ code: 'plugin_generation_retired' });

    expect(activateConfiguredSources).not.toHaveBeenCalled();
    expect(owner.bindCallerAuthorService).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(service.attach).not.toHaveBeenCalled();
    expect(service.readTranscript).not.toHaveBeenCalled();
    expect(service.followTranscript).not.toHaveBeenCalled();
    expect(service.takeover).not.toHaveBeenCalled();
  });

  it('strictly validates raw unary cancellation options before activation or service effects', async () => {
    const list = vi.fn(async () => Object.freeze({
      items: Object.freeze([]),
      nextCursor: null,
    }));
    const service = createAuthorService(list);
    const owner = createCurrentOwner(service);
    const activateConfiguredSources = vi.fn(async () => {});
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => owner,
      activateConfiguredSources,
    });
    let accessorReads = 0;
    const accessorOptions = Object.defineProperty({}, 'signal', {
      enumerable: true,
      get() {
        accessorReads += 1;
        return undefined;
      },
    });
    const takeoverRequest = {
      targetStorageMode: 'persisted',
      idempotencyKey: 'strict-options-takeover',
    } as unknown as Parameters<typeof binding.takeover>[1];

    const attempts = [
      () => binding.capabilities({ extra: true } as never),
      () => binding.list(undefined, { extra: true } as never),
      () => binding.attach(externalSessionRef, accessorOptions as never),
      () => binding.readTranscript(
        externalSessionRef,
        { mode: 'page', direction: 'older' },
        { signal: {} } as never,
      ),
      () => binding.takeover(
        externalSessionRef,
        takeoverRequest,
        { extra: true } as never,
      ),
    ];

    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({
        code: 'plugin_external_options_invalid',
      });
    }

    expect(accessorReads).toBe(0);
    expect(activateConfiguredSources).not.toHaveBeenCalled();
    expect(owner.bindCallerAuthorService).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(service.attach).not.toHaveBeenCalled();
    expect(service.readTranscript).not.toHaveBeenCalled();
    expect(service.takeover).not.toHaveBeenCalled();
  });

  it('reapplies caller cancellation before a late downstream deadline failure', async () => {
    let rejectList: ((error: unknown) => void) | undefined;
    const list = vi.fn(async () => await new Promise<never>((_resolve, reject) => {
      rejectList = reject;
    }));
    const owner = createCurrentOwner(createAuthorService(list));
    const invocationController = new AbortController();
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: invocationController.signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => owner,
      activateConfiguredSources: vi.fn(async () => {}),
    });

    const pending = binding.list();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    invocationController.abort();
    rejectList?.(new PluginError({
      code: 'plugin_operation_deadline_exceeded',
      message: 'deadline',
    }));

    await expect(pending).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
  });

  it('does not activate cold sources for pre-aborted list or follow invocations', async () => {
    const sourceOwner = createCurrentOwner(createAuthorService(vi.fn(async () => Object.freeze({
      items: Object.freeze([]),
      nextCursor: null,
    }))));
    let current: CurrentGlobalExternalSessionsAuthorService | null = null;
    const activateConfiguredSources = vi.fn(async () => {
      current = sourceOwner;
    });
    const invocationController = new AbortController();
    invocationController.abort();
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: invocationController.signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => current,
      activateConfiguredSources,
    });

    await expect(binding.list()).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
    await expect(binding.followTranscript(
      ExternalSessionRefSchema.parse({
        agentId: 'codex',
        sourceId: 'codex:home',
        remoteSessionId: 'remote-1',
      }),
      {},
      vi.fn(),
    )).resolves.toEqual({
      status: 'unavailable',
      code: 'plugin_operation_aborted',
    });

    expect(activateConfiguredSources).not.toHaveBeenCalled();
    expect(current).toBeNull();
    expect(sourceOwner.bindCallerAuthorService).not.toHaveBeenCalled();
  });

  it('settles a list promptly on caller abort while unresolved shared activation stays independent and inert', async () => {
    const activation = deferred();
    const list = vi.fn(async () => Object.freeze({
      items: Object.freeze([]),
      nextCursor: null,
    }));
    const owner = createCurrentOwner(createAuthorService(list));
    const operationController = new AbortController();
    const activateConfiguredSources = vi.fn(async () => await activation.promise);
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => owner,
      activateConfiguredSources,
    });

    const pending = binding.list(undefined, { signal: operationController.signal });
    await vi.waitFor(() => expect(activateConfiguredSources).toHaveBeenCalledOnce());
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
    operationController.abort();

    await rejection;
    expect(list).not.toHaveBeenCalled();

    activation.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps a concurrent invocation live when another caller abandons the same unresolved activation demand', async () => {
    const activation = deferred();
    const page = Object.freeze({
      items: Object.freeze([]),
      nextCursor: 'surviving-caller',
    });
    const list = vi.fn(async () => page);
    const owner = createCurrentOwner(createAuthorService(list));
    const abandonedController = new AbortController();
    const activateConfiguredSources = vi.fn(async () => await activation.promise);
    const binding = createCurrentGlobalExternalSessionsAuthorBinding({
      pluginId: 'acme.sessions',
      signal: new AbortController().signal,
      isGenerationCurrent: () => true,
      resolveCurrent: () => owner,
      activateConfiguredSources,
    });

    const abandoned = binding.list(undefined, {
      signal: abandonedController.signal,
    });
    const surviving = binding.list();
    await vi.waitFor(() => expect(activateConfiguredSources).toHaveBeenCalledTimes(2));
    const abandonedRejection = expect(abandoned).rejects.toMatchObject({
      code: 'plugin_operation_aborted',
    });
    abandonedController.abort();

    await abandonedRejection;
    activation.resolve();

    await expect(surviving).resolves.toBe(page);
    expect(list).toHaveBeenCalledOnce();
  });

  it('bounds unresolved activation by the External Sessions deadline and never runs a late effectful attach', async () => {
    vi.useFakeTimers();
    try {
      const activation = deferred();
      const service = createAuthorService(vi.fn(async () => Object.freeze({
        items: Object.freeze([]),
        nextCursor: null,
      })));
      const owner = createCurrentOwner(service);
      const activateConfiguredSources = vi.fn(async () => await activation.promise);
      const binding = createCurrentGlobalExternalSessionsAuthorBinding({
        pluginId: 'acme.sessions',
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
        resolveCurrent: () => owner,
        activateConfiguredSources,
      });

      const pending = binding.attach(externalSessionRef);
      await Promise.resolve();
      expect(activateConfiguredSources).toHaveBeenCalledOnce();
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'plugin_operation_deadline_exceeded',
      });
      await vi.advanceTimersByTimeAsync(EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs);

      await rejection;
      expect(service.attach).not.toHaveBeenCalled();

      activation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.attach).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives generation retirement precedence over cancellation and deadline during unresolved activation', async () => {
    vi.useFakeTimers();
    try {
      const activation = deferred();
      const service = createAuthorService(vi.fn(async () => Object.freeze({
        items: Object.freeze([]),
        nextCursor: null,
      })));
      const owner = createCurrentOwner(service);
      const generationController = new AbortController();
      const operationController = new AbortController();
      let generationCurrent = true;
      const binding = createCurrentGlobalExternalSessionsAuthorBinding({
        pluginId: 'acme.sessions',
        signal: generationController.signal,
        isGenerationCurrent: () => generationCurrent,
        resolveCurrent: () => owner,
        activateConfiguredSources: vi.fn(async () => await activation.promise),
      });

      const pending = binding.takeover(externalSessionRef, {
        targetStorageMode: 'persisted',
        idempotencyKey: 'takeover-1',
      }, { signal: operationController.signal });
      await Promise.resolve();
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'plugin_generation_retired',
      });
      vi.advanceTimersByTime(EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs);
      operationController.abort();
      generationCurrent = false;
      generationController.abort();

      await rejection;
      expect(service.takeover).not.toHaveBeenCalled();

      activation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.takeover).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('current-global External Sessions takeover source resolution', () => {
  it('reports current link-admission availability in capabilities and candidate hints', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-current-global-capabilities-'));
    const hostOwner = createExternalSessionHostOperationOwner();
    const executeFollow = vi.fn<ExternalSessionFollowHostOperation['execute']>();
    const installation = await hostOwner.install({
      followOperation: Object.freeze({ execute: executeFollow }),
    });
    try {
      mocks.ensureExternalSessionLink.mockReset();
      mocks.loadLinkedExternalSession.mockReset();
      let machineId: string | null = null;
      const startPluginTakeover = vi.fn(async () => Object.freeze({
        ok: true as const,
        operation: Object.freeze({
          sessionId: 'linked-session-1',
          operationId: 'operation-1',
          revision: 1,
        }),
      }));
      const surface: ExternalSessionExecutionSurface = Object.freeze({
        externalLinkedTakeoverWriterSafety: 'native_prevention',
        validateSource: async ({ source }) => ({ ok: true as const, source }),
        listCandidates: async () => ({
          candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
          nextCursor: null,
        }),
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
          source,
          remoteSessionId,
        }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      });
      const service = await createCurrentGlobalExternalSessionsAuthorService({
        contributionGenerationId: 'registry:g1',
        agents: [configuredAgent],
        activeServerDir,
        readCredentials: async () => ({ token: 'token', encryption: null }),
        resolveMachineId: () => machineId,
        resolveAgentRuntime: () => Object.freeze({
          generationId: 'generation-1',
          retirementSignal: new AbortController().signal,
          isCurrent: () => true,
          surface,
        }),
        externalSessionHostOperationOwner: hostOwner,
        isCurrent: () => true,
      });
      const author = service.bindCallerAuthorService({
        pluginId: 'synthetic.non-bundled',
        takeoverStart: startPluginTakeover,
      });

      expect(await author.capabilities()).toEqual({
        list: { status: 'available' },
        attach: {
          status: 'unavailable',
          code: 'plugin_external_machine_unavailable',
        },
        takeover: {
          status: 'unavailable',
          code: 'plugin_external_machine_unavailable',
        },
        transcript: { status: 'available' },
        follow: {
          status: 'unavailable',
          code: 'plugin_external_machine_unavailable',
        },
      });
      const unavailablePage = await author.list();
      expect(unavailablePage.items[0]).toMatchObject({
        capabilities: ['transcript'],
        takeover: {
          status: 'unavailable',
          code: 'plugin_external_machine_unavailable',
        },
      });
      const ref = unavailablePage.items[0]?.ref;
      if (!ref) throw new Error('expected configured candidate');
      await expect(author.attach(ref)).rejects.toMatchObject({
        code: 'plugin_external_machine_unavailable',
      });
      await expect(author.followTranscript(ref, {}, vi.fn())).resolves.toEqual({
        status: 'unavailable',
        code: 'plugin_external_machine_unavailable',
      });
      await expect(author.takeover(ref, {
        targetStorageMode: 'persisted',
        idempotencyKey: 'takeover-machine-admission',
      })).rejects.toMatchObject({
        code: 'plugin_external_machine_unavailable',
      });
      expect(mocks.ensureExternalSessionLink).not.toHaveBeenCalled();
      expect(executeFollow).not.toHaveBeenCalled();
      expect(startPluginTakeover).not.toHaveBeenCalled();

      machineId = 'machine-1';

      expect(await author.capabilities()).toEqual({
        list: { status: 'available' },
        attach: { status: 'available' },
        takeover: {
          status: 'available',
          storageModes: ['external-linked', 'persisted'],
        },
        transcript: { status: 'available' },
        follow: { status: 'available' },
      });
      const availablePage = await author.list();
      expect(availablePage.items[0]).toMatchObject({
        capabilities: ['attach', 'transcript', 'follow'],
        takeover: {
          status: 'available',
          storageModes: ['external-linked', 'persisted'],
        },
      });
      service.dispose();
    } finally {
      await installation.dispose();
      await hostOwner.retire();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('agrees between the follow capability and follow execution when host operations were never installed', async () => {
    const activeServerDir = await mkdtemp(
      join(tmpdir(), 'happier-current-global-follow-uninstalled-'),
    );
    // Deliberately NOT installed. The owner object is constructed unconditionally at daemon
    // startup (startDaemon.ts), but a generation is installed into it only during machine-RPC
    // registration. Owner-existence and install-state are different facts, and the states where
    // they differ are real: pre-machine-bootstrap, machine reconnect, and logout/teardown.
    const hostOwner = createExternalSessionHostOperationOwner();
    try {
      mocks.ensureExternalSessionLink.mockReset();
      mocks.loadLinkedExternalSession.mockReset();
      const surface: ExternalSessionExecutionSurface = Object.freeze({
        externalLinkedTakeoverWriterSafety: 'native_prevention',
        validateSource: async ({ source }) => ({ ok: true as const, source }),
        listCandidates: async () => ({
          candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
          nextCursor: null,
        }),
        resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
          source,
          remoteSessionId,
        }),
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      });
      const service = await createCurrentGlobalExternalSessionsAuthorService({
        contributionGenerationId: 'registry:g1',
        agents: [configuredAgent],
        activeServerDir,
        readCredentials: async () => ({ token: 'token', encryption: null }),
        resolveMachineId: () => 'machine-1',
        resolveAgentRuntime: () => Object.freeze({
          generationId: 'generation-1',
          retirementSignal: new AbortController().signal,
          isCurrent: () => true,
          surface,
        }),
        externalSessionHostOperationOwner: hostOwner,
        isCurrent: () => true,
      });
      const author = service.bindCallerAuthorService({
        pluginId: 'synthetic.non-bundled',
        takeoverStart: vi.fn(),
      });
      const capabilities = await author.capabilities();
      const page = await author.list();
      const ref = page.items[0]?.ref;
      if (!ref) throw new Error('expected configured candidate');
      const followed = await author.followTranscript(ref, {}, vi.fn());

      // The capability surface exists so callers can pre-check. It must not advertise an
      // operation that cannot run: capability and execution answer one question and must agree.
      expect({
        capability: capabilities.follow.status,
        execution: followed.status,
      }).toEqual({ capability: 'unavailable', execution: 'unavailable' });

      // ...and the emitted code must not claim retirement. Nothing is retired here: the
      // generation is current, it simply was never installed into the host-operation owner.
      // Reporting `plugin_generation_retired` is what made this failure unattributable and
      // sent the original investigation down the wrong path.
      expect(followed).toMatchObject({
        status: 'unavailable',
        code: 'plugin_external_follow_unavailable',
      });
      service.dispose();
    } finally {
      await hostOwner.retire();
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });

  it('selects the exact public ref source before canonical link and durable Start', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-current-global-takeover-'));
    try {
      const events: string[] = [];
      const selectedSource = Object.freeze({ kind: 'codexSecondary' });
      const resolveLinkIdentity = vi.fn(async (input: Readonly<{
        source: Readonly<{ kind: string }>;
        remoteSessionId: string;
      }>) => Object.freeze({
        source: input.source,
        remoteSessionId: input.remoteSessionId,
      }));
      const surface: ExternalSessionExecutionSurface = Object.freeze({
        validateSource: async ({ source }) => ({ ok: true as const, source }),
        listCandidates: async ({ source }) => ({
          candidates: [{
            remoteSessionId: 'remote-shared',
            title: source.kind,
            updatedAtMs: 1,
          }],
          nextCursor: null,
        }),
        resolveLinkIdentity,
        pageTranscript: async () => ({
          items: [],
          nextCursor: null,
          tailCursor: null,
          hasMore: false,
          truncated: false,
        }),
        readAfterTranscript: async () => ({ outcome: 'already_current' as const }),
      });
      mocks.ensureExternalSessionLink.mockImplementation(async (input: Readonly<{
        source: Readonly<{ kind: string }>;
      }>) => {
        events.push(`link:${input.source.kind}`);
        return { sessionId: 'linked-session-1' };
      });
      mocks.loadLinkedExternalSession.mockResolvedValue({
        ok: true,
        session: {
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'remote-shared',
          source: selectedSource,
          linkGeneration: 'link-generation-1',
          sessionPath: '/local/selected/workspace',
          metadata: {
            externalSessionV1: {
              v: 1,
              agentId: 'codex',
              machineId: 'machine-1',
              remoteSessionId: 'remote-shared',
              source: selectedSource,
              linkedAtMs: 1,
              qualifiedIdentity: {
                v: 1,
                agent: { pluginId: 'happier.codex', localId: 'codex' },
                source: { kind: 'codexSecondary', contractVersion: 1 },
              },
            },
          },
          rawSession: null,
        },
      });
      const startPluginTakeover = vi.fn(async () => {
        events.push('start');
        return Object.freeze({
          ok: true as const,
          operation: Object.freeze({
            sessionId: 'linked-session-1',
            operationId: 'operation-1',
            revision: 1,
          }),
        });
      });
      const service = await createCurrentGlobalExternalSessionsAuthorService({
        contributionGenerationId: 'registry:g1',
        agents: [multiSourceConfiguredAgent],
        activeServerDir,
        readCredentials: async () => ({ token: 'token', encryption: null }),
        resolveMachineId: () => 'machine-1',
        resolveAgentRuntime: () => Object.freeze({
          generationId: 'generation-1',
          retirementSignal: new AbortController().signal,
          isCurrent: () => true,
          surface,
        }),
        isCurrent: () => true,
      });
      const author = service.bindCallerAuthorService({
        pluginId: 'synthetic.non-bundled',
        takeoverStart: startPluginTakeover,
      });
      const listed = await author.list();
      expect(listed.items).toHaveLength(2);
      expect(listed.items.map((candidate) => candidate.ref.remoteSessionId)).toEqual([
        'remote-shared',
        'remote-shared',
      ]);
      const selected = listed.items.find(
        (candidate) => candidate.title === 'codexSecondary',
      );
      if (!selected) throw new Error('expected exact secondary-source candidate');

      await expect(author.takeover(selected.ref, {
        targetStorageMode: 'persisted',
        idempotencyKey: 'takeover-exact-secondary',
      })).resolves.toEqual({
        sessionId: 'linked-session-1',
        operationId: 'operation-1',
        revision: 1,
      });

      expect(resolveLinkIdentity).toHaveBeenCalledOnce();
      expect(resolveLinkIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          source: selectedSource,
          remoteSessionId: 'remote-shared',
        }),
      );
      expect(mocks.ensureExternalSessionLink).toHaveBeenCalledOnce();
      expect(mocks.ensureExternalSessionLink).toHaveBeenCalledWith(
        expect.objectContaining({ source: selectedSource }),
        expect.anything(),
      );
      expect(mocks.loadLinkedExternalSession).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedIdentity: expect.objectContaining({ source: selectedSource }),
        }),
        expect.anything(),
      );
      expect(events).toEqual(['link:codexSecondary', 'start']);
      expect(startPluginTakeover).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            targetDirectory: '/local/selected/workspace',
          }),
        }),
        expect.anything(),
      );
      service.dispose();
    } finally {
      await rm(activeServerDir, { recursive: true, force: true });
    }
  });
});

describe('current-global External Sessions follow lifecycle', () => {
  it('settles explicit disposal acknowledgement before retiring its bound host-operation port', async () => {
    mocks.ensureExternalSessionLink.mockResolvedValue({
      sessionId: 'linked-session-1',
    });
    const hostOwner = createExternalSessionHostOperationOwner();
    const followOperation: ExternalSessionFollowHostOperation = Object.freeze({
      execute: vi.fn(async (request) => {
        let terminated = false;
        const terminate = async (reason: 'disposed' | 'retired') => {
          if (terminated) return;
          terminated = true;
          await request.listener({
            kind: 'terminated',
            reason,
            cursor: 'cursor-1',
          });
        };
        request.retirementSignal?.addEventListener(
          'abort',
          () => { void terminate('retired').catch(() => undefined); },
          { once: true },
        );
        return Object.freeze({
          status: 'following' as const,
          startingCursor: 'cursor-1',
          subscription: Object.freeze({
            dispose: async () => await terminate('disposed'),
          }),
        });
      }),
    });
    const installation = await hostOwner.install({
      followOperation,
    });
    const runtimeRetirement = new AbortController();
    const surface: ExternalSessionExecutionSurface = Object.freeze({
      validateSource: async ({ source }) => ({ ok: true as const, source }),
      listCandidates: async () => ({
        candidates: [{ remoteSessionId: 'remote-1', updatedAtMs: 1 }],
        nextCursor: null,
      }),
      resolveLinkIdentity: async ({ source, remoteSessionId }) => ({
        source,
        remoteSessionId,
      }),
      pageTranscript: async () => ({
        items: [],
        nextCursor: null,
        tailCursor: 'cursor-1',
        hasMore: false,
        truncated: false,
      }),
      readAfterTranscript: async () => ({
        outcome: 'already_current' as const,
      }),
    });
    const service = await createCurrentGlobalExternalSessionsAuthorService({
      contributionGenerationId: 'registry:g1',
      agents: [configuredAgent],
      readCredentials: async () => ({ token: 'token', encryption: null }),
      resolveMachineId: () => 'machine-1',
      resolveAgentRuntime: () => Object.freeze({
        generationId: 'generation-1',
        retirementSignal: runtimeRetirement.signal,
        isCurrent: () => true,
        surface,
      }),
      externalSessionHostOperationOwner: hostOwner,
      isCurrent: () => true,
    });
    const author = service.bindCallerAuthorService({
      pluginId: 'synthetic.non-bundled',
    });
    const listed = await author.list();
    const ref = listed.items[0]?.ref;
    if (!ref) throw new Error('expected configured candidate');
    const listener = vi.fn(async () => undefined);
    const result = await author.followTranscript(ref, {}, listener);
    expect(result.status).toBe('following');
    if (result.status !== 'following') throw new Error('expected follow');

    await result.subscription.dispose();

    expect(listener).toHaveBeenCalledWith({
      kind: 'terminated',
      reason: 'disposed',
      cursor: 'cursor-1',
    });
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({
      reason: 'retired',
    }));
    service.dispose();
    await installation.dispose();
    await hostOwner.retire();
  });
});
