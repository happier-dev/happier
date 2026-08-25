import { describe, expect, it, vi } from 'vitest';

import { createGithubWebhookActionHandlerV1 } from './webhookAction.js';

const rawBody = new TextEncoder().encode(JSON.stringify({
  ref: 'refs/heads/main',
  before: 'a',
  after: 'b',
  head_commit: { timestamp: '2026-08-10T12:01:02Z' },
  repository: { id: 77, full_name: 'acme/widgets' },
  sender: { id: 99, login: 'octocat', type: 'User' },
}));

const webhookInput = {
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

function sourceDefinition(automationId: string) {
  return {
    automationId,
    templateVersion: 1,
    sourceSelectorId: `00000000-0000-4000-8000-${automationId.replace(/[^0-9]/gu, '').padStart(12, '0').slice(-12)}`,
    eventRef: {
      pluginId: 'happier.scm.forge.github',
      localId: 'automation/repository-event-v1',
    },
    sourceInstanceId: 'github:repository:77',
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

/**
 * The webhook handler reads only the caller, cancellation, and Action service;
 * the host stamps the rest of the invocation context. The fixture keeps its
 * literal shape so overriding spreads stay checkable, and each call site
 * supplies the handler's parameter cast.
 */
function webhookContext(execute: ReturnType<typeof vi.fn>) {
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
    signal: new AbortController().signal,
    services: { actions: { execute } },
  };
}

describe('GitHub webhook Action caller admission', () => {
  it('rejects a plugin-to-plugin invocation before trusting synthesized verified delivery input', async () => {
    const execute = vi.fn(async () => ({
      kind: 'page' as const,
      revision: '7',
      definitions: [],
      nextCursor: null,
    }));

    await expect(createGithubWebhookActionHandlerV1()(null, {
      surface: 'plugin',
      caller: {
        kind: 'plugin',
        pluginId: 'attacker.plugin',
        contribution: { id: 'attack', qualifiedId: 'attacker.plugin/attack' },
        materialization: {
          pluginId: 'attacker.plugin',
          machineId: 'machine-attacker',
          materializationId: 'materialization-attacker',
        },
      },
      signal: new AbortController().signal,
      services: { actions: { execute } },
    } as never)).resolves.toEqual({
      kind: 'deadLetter',
      code: 'github_webhook_caller_invalid',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a host webhook invocation whose contribution is not the GitHub endpoint contribution', async () => {
    const execute = vi.fn();

    await expect(createGithubWebhookActionHandlerV1()(webhookInput, {
      ...webhookContext(execute),
      caller: {
        kind: 'host',
        domain: 'ingress',
        originSurface: 'webhook',
        contribution: {
          id: 'other-events',
          qualifiedId: 'happier.scm.forge.github/other-events',
        },
      },
    } as never)).resolves.toEqual({
      kind: 'deadLetter',
      code: 'github_webhook_caller_invalid',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('retries the one complete semantic admission after its transport fails', async () => {
    const definitions = Array.from({ length: 21 }, (_, index) => sourceDefinition(
      `automation-${String(index + 1).padStart(3, '0')}`,
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
        if (admission.definitions.length === definitions.length) {
          throw new Error('admission_transport_unavailable');
        }
        return {
          results: admission.definitions.map((_, index) => ({
            kind: 'admitted' as const,
            runId: `run-safe-${index}`,
            checkpointSafe: true as const,
          })),
        };
      }
      throw new Error(`unexpected Action ${actionId}`);
    });

    await expect(createGithubWebhookActionHandlerV1()(webhookInput, webhookContext(execute) as never)).resolves.toEqual({
      kind: 'retry',
      code: 'github.automation-unavailable',
    });
    const admissions = execute.mock.calls.filter(([actionId]) => actionId === 'automation.event.admit');
    expect(admissions).toHaveLength(1);
    expect((admissions[0]![1] as Readonly<{ definitions: readonly unknown[] }>).definitions).toHaveLength(
      definitions.length,
    );
    expect(sourceListInputs).toEqual(definitions.map((_, index) => (
      index === 0
        ? { transport: { kind: 'durablePush' } }
        : { transport: { kind: 'durablePush' }, cursor: `page-${index}` }
    )));
  });

  it('propagates cancellation from a failed admission instead of turning it into a retry', async () => {
    const controller = new AbortController();
    const execute = vi.fn(async (actionId: string) => {
      if (actionId === 'automation.event.sources.list') {
        return {
          kind: 'page' as const,
          revision: '7',
          definitions: [sourceDefinition('automation-1')],
          nextCursor: null,
        };
      }
      if (actionId === 'automation.event.admit') {
        controller.abort();
        throw controller.signal.reason;
      }
      throw new Error(`unexpected Action ${actionId}`);
    });

    await expect(createGithubWebhookActionHandlerV1()(webhookInput, {
      ...webhookContext(execute),
      signal: controller.signal,
    } as never)).rejects.toMatchObject({ name: 'AbortError' });
    expect(execute.mock.calls.filter(([actionId]) => actionId === 'automation.event.admit')).toHaveLength(1);
  });
});
