import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';
import { PLUGIN_MANIFEST } from './manifest.js';
import {
  createGithubWebhookActionHandlerV1,
  type GithubWebhookActionHandlerV1,
} from './webhookAction.js';

const GITHUB_WEBHOOK_ACTION_ID = 'github/accept-webhook';

async function disposeActivation(cleanup: Awaited<ReturnType<typeof activate>>): Promise<void> {
  if (typeof cleanup === 'function') await cleanup();
}

const rawBody = new TextEncoder().encode(JSON.stringify({
  ref: 'refs/heads/main',
  before: 'a',
  after: 'b',
  head_commit: { timestamp: '2026-08-10T12:01:02Z' },
  repository: { id: 77, full_name: 'acme/widgets' },
  sender: { id: 99, login: 'octocat', type: 'User' },
}));

const issueCommentRawBody = new TextEncoder().encode(JSON.stringify({
  action: 'created',
  repository: { id: 77, full_name: 'acme/widgets' },
  issue: { id: 300, number: 12 },
  comment: {
    id: 444,
    body: 'Please investigate this failure.',
    created_at: '2026-08-10T12:00:00Z',
    updated_at: '2026-08-10T12:00:00Z',
    user: { id: 99, login: 'octocat', type: 'User' },
  },
}));

const input = {
  v: 1 as const,
  endpoint: {
    webhookContribution: { pluginId: 'happier.scm.forge.github', localId: 'github-events' },
    sourceInstanceId: 'github-source-1',
  },
  delivery: {
    deliveryId: 'delivery-1',
    attempt: 1,
    replay: 0,
    receivedAtMs: 1,
    providerDeliveryId: 'github-delivery-1',
  },
  request: {
    contentType: 'application/json',
    headers: [{ name: 'x-github-event' as const, value: 'push' }],
    rawBodyBytes: rawBody.byteLength,
    rawBodyBase64: Buffer.from(rawBody).toString('base64'),
  },
  verified: { verifier: 'github_hmac_sha256_v1' as const, eventType: 'push' },
};

const issueCommentInput = {
  ...input,
  request: {
    ...input.request,
    headers: [{ name: 'x-github-event' as const, value: 'issue_comment' }],
    rawBodyBytes: issueCommentRawBody.byteLength,
    rawBodyBase64: Buffer.from(issueCommentRawBody).toString('base64'),
  },
  verified: { verifier: 'github_hmac_sha256_v1' as const, eventType: 'issue_comment' },
};

describe('GitHub webhook Action', () => {
  it('declares the account-endpoint routed verifier and registers its same-plugin handler', async () => {
    expect(PLUGIN_MANIFEST.contributes.webhooks).toEqual([expect.objectContaining({
      id: 'github-events',
      verifier: { kind: 'github_hmac_sha256_v1', routing: 'accountEndpoint' },
      handlerAction: { localId: GITHUB_WEBHOOK_ACTION_ID },
    })]);
    const declaredAction = (PLUGIN_MANIFEST.contributes.actions ?? []).find(
      (action) => action.id === GITHUB_WEBHOOK_ACTION_ID,
    );
    expect(declaredAction).toEqual(expect.objectContaining({
      id: GITHUB_WEBHOOK_ACTION_ID,
      inputSchema: expect.objectContaining({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: expect.objectContaining({ v: { const: 1 } }),
        additionalProperties: false,
      }),
      resultSchema: expect.objectContaining({
        $schema: 'http://json-schema.org/draft-07/schema#',
        anyOf: expect.any(Array),
      }),
    }));
    const register = vi.fn();

    const cleanup = await activate({
      actions: { register },
      backgroundServices: { register: vi.fn() },
      connectedAccounts: { register: vi.fn() },
      scm: { registerHostingProvider: vi.fn() },
    } as never);

    try {
      expect(register).toHaveBeenCalledWith(
        GITHUB_WEBHOOK_ACTION_ID,
        expect.any(Function),
      );
    } finally {
      await disposeActivation(cleanup);
    }
  });

  it('re-reads the complete current source set for every delivery without retaining provider-local membership', async () => {
    const register = vi.fn();
    const cleanup = await activate({
      actions: { register },
      backgroundServices: { register: vi.fn() },
      connectedAccounts: { register: vi.fn() },
      scm: { registerHostingProvider: vi.fn() },
    } as never);
    try {
      const registered = register.mock.calls.find(([actionId]) => actionId === GITHUB_WEBHOOK_ACTION_ID);
      expect(registered).toBeDefined();
      const handler = registered?.[1] as GithubWebhookActionHandlerV1;
      const firstExecute = vi.fn(async (actionId: string) => {
        if (actionId === 'automation.event.sources.list') {
          return {
            kind: 'page' as const,
            revision: '7',
            definitions: [sourceDefinition('automation-1', 'github:repository:77')],
            nextCursor: null,
          };
        }
        if (actionId === 'automation.event.admit') {
          return { results: [{ kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const }] };
        }
        throw new Error(`unexpected Action ${actionId}`);
      });
      const secondExecute = vi.fn(async (actionId: string, actionInput: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          expect(actionInput).toEqual({ transport: { kind: 'durablePush' } });
          return {
            kind: 'page' as const,
            revision: '8',
            definitions: [sourceDefinition('automation-1', 'github:repository:77')],
            nextCursor: null,
          };
        }
        if (actionId === 'automation.event.admit') {
          return { results: [{ kind: 'rejoined' as const, runId: 'run-1', checkpointSafe: true as const }] };
        }
        throw new Error(`unexpected Action ${actionId}`);
      });

      await expect(handler(input, contextWithActions(firstExecute))).resolves.toEqual({
        kind: 'settled',
        disposition: 'accepted',
      });
      await expect(handler(input, contextWithActions(secondExecute))).resolves.toEqual({
        kind: 'settled',
        disposition: 'accepted',
      });
    } finally {
      await disposeActivation(cleanup);
    }
  });

  it('does not carry source membership across activated plugin generations', async () => {
    const firstRegister = vi.fn();
    const firstCleanup = await activate({
      actions: { register: firstRegister },
      backgroundServices: { register: vi.fn() },
      connectedAccounts: { register: vi.fn() },
      scm: { registerHostingProvider: vi.fn() },
    } as never);

    try {
      const firstHandler = (
        firstRegister.mock.calls.find(([actionId]) => actionId === GITHUB_WEBHOOK_ACTION_ID)?.[1]
      ) as GithubWebhookActionHandlerV1;
      await expect(firstHandler(input, contextWithActions(vi.fn(async (actionId: string) => {
        if (actionId === 'automation.event.sources.list') {
          return {
            kind: 'page' as const,
            revision: '7',
            definitions: [sourceDefinition('automation-1', 'github:repository:77')],
            nextCursor: null,
          };
        }
        if (actionId === 'automation.event.admit') {
          return { results: [{ kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const }] };
        }
        throw new Error(`unexpected Action ${actionId}`);
      })))).resolves.toEqual({ kind: 'settled', disposition: 'accepted' });
    } finally {
      await disposeActivation(firstCleanup);
    }

    const secondRegister = vi.fn();
    const secondCleanup = await activate({
      actions: { register: secondRegister },
      backgroundServices: { register: vi.fn() },
      connectedAccounts: { register: vi.fn() },
      scm: { registerHostingProvider: vi.fn() },
    } as never);

    try {
      const secondHandler = (
        secondRegister.mock.calls.find(([actionId]) => actionId === GITHUB_WEBHOOK_ACTION_ID)?.[1]
      ) as GithubWebhookActionHandlerV1;
      const secondExecute = vi.fn(async (actionId: string, actionInput: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          expect(actionInput).toEqual({ transport: { kind: 'durablePush' } });
          return {
            kind: 'page' as const,
            revision: '8',
            definitions: [sourceDefinition('automation-1', 'github:repository:77')],
            nextCursor: null,
          };
        }
        if (actionId === 'automation.event.admit') {
          return { results: [{ kind: 'admitted' as const, runId: 'run-2', checkpointSafe: true as const }] };
        }
        throw new Error(`unexpected Action ${actionId}`);
      });

      await expect(secondHandler(input, contextWithActions(secondExecute))).resolves.toEqual({
        kind: 'settled',
        disposition: 'accepted',
      });
    } finally {
      await disposeActivation(secondCleanup);
    }
  });

  it('reads every current durable-push source page and fans one normalized delivery into the canonical admission owner', async () => {
    const execute = vi.fn(async (actionId: string, actionInput: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        const input = actionInput as Readonly<{ cursor?: string }>;
        return input.cursor === undefined
          ? {
            kind: 'page' as const,
            revision: '7',
            definitions: [sourceDefinition('automation-1', 'github:repository:77')],
            nextCursor: 'page-2',
          }
          : {
            kind: 'page' as const,
            revision: '7',
            definitions: [
              sourceDefinition('automation-2', 'github:repository:77'),
              sourceDefinition('automation-ignored', 'github:repository:88'),
            ],
            nextCursor: null,
          };
      }
      if (actionId === 'automation.event.admit') {
        return {
          results: [
            { kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const },
            { kind: 'rejoined' as const, runId: 'run-2', checkpointSafe: true as const },
          ],
        };
      }
      throw new Error(`unexpected Action ${actionId}`);
    });
    const handler = createGithubWebhookActionHandlerV1();

    await expect(handler(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'settled',
      disposition: 'accepted',
    });
    expect(execute).toHaveBeenNthCalledWith(1, 'automation.event.sources.list', {
      transport: { kind: 'durablePush' },
    }, { signal: expect.any(AbortSignal) });
    expect(execute).toHaveBeenNthCalledWith(2, 'automation.event.sources.list', {
      transport: { kind: 'durablePush' },
      cursor: 'page-2',
    }, { signal: expect.any(AbortSignal) });
    expect(execute).toHaveBeenNthCalledWith(3, 'automation.event.admit', {
      eventRef: {
        pluginId: 'happier.scm.forge.github',
        localId: 'automation/repository-pushed-v1',
      },
      occurrenceId: 'github:repository:77:delivery:github-delivery-1',
      occurredAt: 1,
      observationReceivedAt: 1,
      payload: {
        repository: { repositoryId: '77', nameWithOwner: 'acme/widgets' },
        ref: 'refs/heads/main',
        before: 'a',
        after: 'b',
      },
      definitions: [
        definitionSelector('automation-1'),
        definitionSelector('automation-2'),
      ],
    }, { signal: expect.any(AbortSignal) });
  });

  it('uses a revision-confirmed endpoint-local lookup and retries instead of settling when any admission is unsafe', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page' as const,
          revision: '7',
          definitions: [sourceDefinition('automation-1', 'github:repository:77')],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.admit') {
        return {
          results: [{ kind: 'blocked' as const, reason: 'temporarilyUnavailable' as const, checkpointSafe: false as const }],
        };
      }
      throw new Error(`unexpected Action ${actionId}`);
    });
    const context = contextWithActions(execute);
    const handler = createGithubWebhookActionHandlerV1();

    await expect(handler(input, context)).resolves.toEqual({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
    execute.mockClear();

    await expect(handler(input, context)).resolves.toEqual({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
    expect(execute).toHaveBeenNthCalledWith(1, 'automation.event.sources.list', {
      transport: { kind: 'durablePush' },
    }, { signal: expect.any(AbortSignal) });
  });

  it('returns a generic retry without admitting or retaining members when the authoritative source lookup fails', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') throw new Error('source_unavailable');
      throw new Error(`unexpected Action ${actionId}`);
    });

    await expect(createGithubWebhookActionHandlerV1()(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('automation.event.sources.list', {
      transport: { kind: 'durablePush' },
    }, { signal: expect.any(AbortSignal) });
  });

  it('passes every current source page to one complete semantic admission', async () => {
    const firstPage = ['automation-001', 'automation-002'].map((automationId) => sourceDefinition(
      automationId,
      'github:repository:77',
    ));
    const finalPage = [sourceDefinition('automation-003', 'github:repository:77')];
    const execute = vi.fn(async (actionId: string, actionInput: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        const listInput = actionInput as Readonly<{ cursor?: string }>;
        return listInput.cursor === undefined
          ? { kind: 'page' as const, revision: '7', definitions: firstPage, nextCursor: 'page-2' }
          : { kind: 'page' as const, revision: '7', definitions: finalPage, nextCursor: null };
      }
      if (actionId === 'automation.event.admit') {
        const admission = actionInput as Readonly<{ definitions: readonly unknown[] }>;
        return {
          results: admission.definitions.map((_, index) => ({
            kind: 'admitted' as const,
            runId: `run-${index}`,
            checkpointSafe: true as const,
          })),
        };
      }
      throw new Error(`unexpected Action ${actionId}`);
    });
    const handler = createGithubWebhookActionHandlerV1();

    await expect(handler(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'settled',
      disposition: 'accepted',
    });
    const admissions = execute.mock.calls.filter(([actionId]) => actionId === 'automation.event.admit');
    expect(admissions).toHaveLength(1);
    expect((admissions[0]![1] as Readonly<{ definitions: readonly unknown[] }>).definitions).toHaveLength(3);
  });

  it('exhausts an opaque durable-push cursor chain beyond the former page ceiling before admitting the full source set', async () => {
    const definitions = Array.from({ length: 21 }, (_, index) => sourceDefinition(
      `automation-${String(index + 1).padStart(3, '0')}`,
      'github:repository:77',
    ));
    const sourceListInputs: unknown[] = [];
    const execute = vi.fn(async (actionId: string, actionInput: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        sourceListInputs.push(actionInput);
        const pageIndex = sourceListInputs.length - 1;
        return {
          kind: 'page' as const,
          revision: '7',
          definitions: [definitions[pageIndex]!],
          nextCursor: pageIndex === definitions.length - 1 ? null : `page-${pageIndex + 1}`,
        };
      }
      if (actionId === 'automation.event.admit') {
        const admission = actionInput as Readonly<{ definitions: readonly unknown[] }>;
        return {
          results: admission.definitions.map((_, index) => ({
            kind: 'admitted' as const,
            runId: `run-${index}`,
            checkpointSafe: true as const,
          })),
        };
      }
      throw new Error(`unexpected Action ${actionId}`);
    });

    await expect(createGithubWebhookActionHandlerV1()(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'settled',
      disposition: 'accepted',
    });

    expect(sourceListInputs).toEqual(definitions.map((_, index) => (
      index === 0
        ? { transport: { kind: 'durablePush' } }
        : { transport: { kind: 'durablePush' }, cursor: `page-${index}` }
    )));
    const admissions = execute.mock.calls.filter(([actionId]) => actionId === 'automation.event.admit');
    expect(admissions).toHaveLength(1);
    expect((admissions[0]![1] as Readonly<{ definitions: readonly unknown[] }>).definitions).toHaveLength(
      definitions.length,
    );
  });

  it('retries an empty continuation page instead of acknowledging from a partial current-source scan', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId !== 'automation.event.sources.list') throw new Error(`unexpected Action ${actionId}`);
      return {
        kind: 'page' as const,
        revision: '7',
        definitions: [],
        nextCursor: 'page-2',
      };
    });

    await expect(createGithubWebhookActionHandlerV1()(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('retries the delivery when one result in the complete semantic admission is checkpoint-unsafe', async () => {
    const firstPage = ['automation-001', 'automation-002'].map((automationId) => sourceDefinition(
      automationId,
      'github:repository:77',
    ));
    const finalPage = [sourceDefinition('automation-003', 'github:repository:77')];
    const execute = vi.fn(async (actionId: string, actionInput: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        const listInput = actionInput as Readonly<{ cursor?: string }>;
        return listInput.cursor === undefined
          ? { kind: 'page' as const, revision: '7', definitions: firstPage, nextCursor: 'page-2' }
          : { kind: 'page' as const, revision: '7', definitions: finalPage, nextCursor: null };
      }
      if (actionId === 'automation.event.admit') {
        const admission = actionInput as Readonly<{ definitions: readonly unknown[] }>;
        return {
          results: admission.definitions.map((_, index) => (
            index === 0
              ? {
              kind: 'blocked' as const,
              reason: 'temporarilyUnavailable' as const,
              checkpointSafe: false as const,
              }
              : {
              kind: 'admitted' as const,
              runId: `run-safe-${index}`,
              checkpointSafe: true as const,
              }
          )),
        };
      }
      throw new Error(`unexpected Action ${actionId}`);
    });

    await expect(createGithubWebhookActionHandlerV1()(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
    const admissions = execute.mock.calls.filter(([actionId]) => actionId === 'automation.event.admit');
    expect(admissions).toHaveLength(1);
    expect((admissions[0]![1] as Readonly<{ definitions: readonly unknown[] }>).definitions).toHaveLength(3);
  });

  it('does not settle an unmatched valid repository delivery until the host source-list has confirmed its current scope', async () => {
    const execute = vi.fn(async (actionId: string) => {
      if (actionId !== 'automation.event.sources.list') throw new Error(`unexpected Action ${actionId}`);
      return { kind: 'page' as const, revision: '7', definitions: [], nextCursor: null };
    });
    const handler = createGithubWebhookActionHandlerV1();

    await expect(handler(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'settled',
      disposition: 'ignored',
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('settles a delivery no consumer exists for instead of retrying it into a dead letter', async () => {
    const execute = vi.fn();
    const handler = createGithubWebhookActionHandlerV1();
    // An issue comment normalizes cleanly but reaches no Channels or Automation
    // owner. Retrying it would consume every attempt and then dead-letter, so
    // the handler settles it and invokes no feature Action at all.
    await expect(handler(issueCommentInput, contextWithActions(execute))).resolves.toEqual({
      kind: 'settled',
      disposition: 'ignored',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports the canonical durable-push source health the pull twin already reports', async () => {
    const reports: unknown[] = [];
    const execute = vi.fn(async (actionId: string, actionInput: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page' as const,
          revision: '7',
          definitions: [sourceDefinition('automation-1', 'github:repository:77')],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.admit') {
        return { results: [{ kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const }] };
      }
      if (actionId === 'automation.event.source.status.report') {
        reports.push(actionInput);
        return {};
      }
      throw new Error(`unexpected Action ${actionId}`);
    });
    const handler = createGithubWebhookActionHandlerV1();
    const context = contextWithActions(execute);

    await expect(handler(input, context)).resolves.toEqual({
      kind: 'settled',
      disposition: 'accepted',
    });
    expect(reports).toEqual([
      {
        kind: 'catalogReconciliation',
        scope: { kind: 'durablePush', webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw' },
        observedRevision: '7',
        adoptedRevision: '7',
        state: 'current',
        scanStartedAt: null,
        nextRetryAt: null,
      },
      {
        kind: 'source',
        ...definitionSelector('automation-1'),
        eventRef: {
          pluginId: 'happier.scm.forge.github',
          localId: 'automation/repository-pushed-v1',
        },
        state: 'observing',
        code: 'none',
        lastObservedAt: 1,
        lastDispositionAt: 1,
        nextRetryAt: null,
        observedDelta: 1,
        admittedDelta: 1,
        skippedDelta: 0,
      },
    ]);

    // Every delivery adopts one complete current scan; the provider retains no
    // source membership that could route a later delivery after an edit.
    reports.length = 0;
    await expect(handler(input, context)).resolves.toEqual({
      kind: 'settled',
      disposition: 'accepted',
    });
    expect(reports).toEqual([
      expect.objectContaining({ kind: 'catalogReconciliation', adoptedRevision: '7' }),
      expect.objectContaining({ kind: 'source', state: 'observing' }),
    ]);
  });

  it('reports attention on the same source when the admission the delivery needs is unavailable', async () => {
    const reports: unknown[] = [];
    const execute = vi.fn(async (actionId: string, actionInput: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page' as const,
          revision: '7',
          definitions: [sourceDefinition('automation-1', 'github:repository:77')],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.admit') {
        return {
          results: [{
            kind: 'blocked' as const,
            reason: 'temporarilyUnavailable' as const,
            checkpointSafe: false as const,
          }],
        };
      }
      if (actionId === 'automation.event.source.status.report') {
        reports.push(actionInput);
        return {};
      }
      throw new Error(`unexpected Action ${actionId}`);
    });
    const handler = createGithubWebhookActionHandlerV1();

    await expect(handler(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
    expect(reports).toContainEqual(expect.objectContaining({
      kind: 'source',
      automationId: 'automation-1',
      state: 'attention',
      code: 'admissionUnavailable',
      // A retried delivery is re-observed, so the terminal counters stay put
      // rather than double counting the same occurrence on every attempt.
      observedDelta: 0,
      admittedDelta: 0,
      skippedDelta: 0,
    }));
  });

  it('maps admitted, rejoined, and skipped result positions to their exact trigger health counters', async () => {
    const reports: unknown[] = [];
    const execute = vi.fn(async (actionId: string, actionInput: unknown) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page' as const,
          revision: '7',
          definitions: [
            sourceDefinition('automation-1', 'github:repository:77'),
            sourceDefinition('automation-2', 'github:repository:77'),
            sourceDefinition('automation-3', 'github:repository:77'),
          ],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.admit') {
        return {
          results: [
            { kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const },
            { kind: 'rejoined' as const, runId: 'run-2', checkpointSafe: true as const },
            { kind: 'skipped' as const, reason: 'filtered' as const, checkpointSafe: true as const },
          ],
        };
      }
      if (actionId === 'automation.event.source.status.report') {
        reports.push(actionInput);
        return {};
      }
      throw new Error(`unexpected Action ${actionId}`);
    });

    await expect(createGithubWebhookActionHandlerV1()(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'settled',
      disposition: 'accepted',
    });
    expect(reports).toContainEqual(expect.objectContaining({
      kind: 'source',
      triggerId: 'trigger-automation-1',
      observedDelta: 1,
      admittedDelta: 1,
      skippedDelta: 0,
    }));
    expect(reports).toContainEqual(expect.objectContaining({
      kind: 'source',
      triggerId: 'trigger-automation-2',
      observedDelta: 1,
      admittedDelta: 0,
      skippedDelta: 0,
    }));
    expect(reports).toContainEqual(expect.objectContaining({
      kind: 'source',
      triggerId: 'trigger-automation-3',
      observedDelta: 1,
      admittedDelta: 0,
      skippedDelta: 1,
    }));
  });

  it('settles an admitted delivery even when its health report cannot be recorded', async () => {
    // Failing the delivery to fix telemetry would re-deliver an occurrence the
    // admission owner has already accepted.
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page' as const,
          revision: '7',
          definitions: [sourceDefinition('automation-1', 'github:repository:77')],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.admit') {
        return { results: [{ kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const }] };
      }
      if (actionId === 'automation.event.source.status.report') {
        throw new Error('status_unavailable');
      }
      throw new Error(`unexpected Action ${actionId}`);
    });
    const handler = createGithubWebhookActionHandlerV1();

    await expect(handler(input, contextWithActions(execute))).resolves.toEqual({
      kind: 'settled',
      disposition: 'accepted',
    });
  });

  it('does not settle a delivery whose invocation is cancelled while its health is being reported', async () => {
    // The health report is the last step before `accepted`, and it deliberately
    // swallows a failed report so telemetry never re-delivers an occurrence the
    // admission owner already accepted. Cancellation is the one exception: an
    // aborted invocation must not settle, so the report's error handling has to
    // distinguish the two rather than swallowing both.
    const controller = new AbortController();
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page' as const,
          revision: '7',
          definitions: [sourceDefinition('automation-1', 'github:repository:77')],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.admit') {
        return { results: [{ kind: 'admitted' as const, runId: 'run-1', checkpointSafe: true as const }] };
      }
      if (actionId === 'automation.event.source.status.report') {
        controller.abort();
        throw new Error('status_unavailable');
      }
      throw new Error(`unexpected Action ${actionId}`);
    });
    const handler = createGithubWebhookActionHandlerV1();

    await expect(handler(input, contextWithActions(execute, controller.signal))).rejects
      .toThrow('status_unavailable');
  });

  it('does not settle a delivery after invocation cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const handler = createGithubWebhookActionHandlerV1();

    await expect(handler(input, {
      signal: controller.signal,
    } as never)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function definitionSelector(automationId: string) {
  return {
    automationId,
    triggerId: `trigger-${automationId}`,
    triggerRevision: 1,
    sourceSelectorId: `00000000-0000-4000-8000-${automationId.replace(/[^0-9]/gu, '').padStart(12, '0').slice(-12)}`,
  };
}

function sourceDefinition(automationId: string, sourceInstanceId: string) {
  return {
    ...definitionSelector(automationId),
    eventRef: {
      pluginId: 'happier.scm.forge.github',
      localId: 'automation/repository-pushed-v1',
    },
    sourceInstanceId,
    sourceContractVersion: 1,
    sourceConfig: {},
    observationTransport: {
      kind: 'durablePush' as const,
      webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      endpointMaterializationRef: {
        pluginId: 'happier.scm.forge.github',
        machineId: 'machine-1',
        materializationId: 'materialization-1',
      },
      observationStartsAt: 0,
    },
    filter: null,
    maximumObservationAgeMs: null,
  };
}

function contextWithActions(execute: ReturnType<typeof vi.fn>, signal?: AbortSignal) {
  return {
    surface: 'plugin',
    caller: {
      kind: 'host',
      domain: 'ingress',
      originSurface: 'webhook',
      contribution: {
        id: 'github-events',
        qualifiedId: 'happier.scm.forge.github/github-events',
      },
    },
    signal: signal ?? new AbortController().signal,
    services: {
      actions: { execute },
    },
  } as never;
}
