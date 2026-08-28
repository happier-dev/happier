import { describe, expect, it, vi } from 'vitest';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
  createGithubAutomationEventCheckpointRowId,
  createGithubAutomationEventCheckpointRowV1,
} from './observations/githubAutomationEventCheckpoint.js';
import {
  PluginEventAutomationSetupResultV1Schema,
} from '@happier-dev/plugin-sdk/events';

import {
  resetGithubRepositoryEventHistoryGap,
  setupGithubRepositoryEventSource,
} from './githubAutomationEventActions.js';
import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from './observations/githubProviderContracts.js';
import { GITHUB_AUTOMATION_EVENT_LOCAL_IDS } from './githubAutomationEvents.js';

const GITHUB_ACCOUNT = {
  service: {
    pluginId: 'happier.scm.forge.github',
    localId: 'github-account',
  },
  accountId: 'account-github-primary',
} as const;

function jsonResponse(value: unknown, status = 200) {
  return {
    status,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function automationContext(params: Readonly<{
  connectedAccounts: Readonly<{ materialize: ReturnType<typeof vi.fn> }>;
  http: Readonly<{ request: ReturnType<typeof vi.fn> }>;
  signal?: AbortSignal;
}>): PluginInvocationContext {
  return {
    plugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
    contribution: {
      id: 'automation/setup-repository-event-v1',
      qualifiedId: 'happier.scm.forge.github/actions/automation/setup-repository-event-v1',
    },
    surface: 'plugin',
    invokedAtMs: 1_760_000_700_000,
    signal: params.signal ?? new AbortController().signal,
    // Boundary fixture intentionally supplies only the Action services exercised here.
    services: {
      connectedAccounts: params.connectedAccounts,
      http: params.http,
    } as unknown as PluginInvocationContext['services'],
  };
}

describe('GitHub Automation Event source setup', () => {
  it('resolves the user repository through the exact selected account without returning materialized credentials', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: Readonly<{ url: string }>) => {
        expect(request.url).toBe('https://api.github.com/repos/acme/widgets');
        return jsonResponse({
          id: 77,
          name: 'widgets',
          full_name: 'acme/widgets',
          owner: { login: 'acme' },
        });
      }),
    };

    const result = await setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, automationContext({ connectedAccounts, http }));

    expect(PluginEventAutomationSetupResultV1Schema.parse(result)).toEqual({
      v: 1,
      sourceInstanceId: 'github:repository:77',
      sourceContractVersion: 1,
      sourceConfig: {
        v: 1,
        credentialRef: GITHUB_ACCOUNT,
        repository: {
          v: 1,
          repositoryId: '77',
          owner: 'acme',
          name: 'widgets',
          nameWithOwner: 'acme/widgets',
        },
      },
      displayLabel: 'acme/widgets',
    });
    expect(connectedAccounts.materialize).toHaveBeenCalledOnce();
    expect(connectedAccounts.materialize).toHaveBeenCalledWith(
      'github-connected-account',
      {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
      expect.objectContaining({
        expectedAccount: GITHUB_ACCOUNT,
        signal: expect.anything(),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('exact-account-token');
  });

  it('fails with a typed repository-not-found result without inventing a credential fallback', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = { request: vi.fn(async () => jsonResponse({ message: 'Not Found' }, 404)) };

    await expect(setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/missing',
    }, automationContext({ connectedAccounts, http }))).rejects.toMatchObject({
      code: 'github_repository_not_found',
    });
    expect(connectedAccounts.materialize).toHaveBeenCalledOnce();
  });

  it('keeps non-404 GitHub resolution failures distinct from a missing repository', async () => {
    const token = 'exact-account-token';
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: `Bearer ${token}` },
      })),
    };
    const http = { request: vi.fn(async () => jsonResponse({ message: token }, 503)) };

    const error = await setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, automationContext({ connectedAccounts, http })).then(
      () => null,
      (rejection: unknown) => rejection,
    );

    expect(error).toMatchObject({
      code: 'github_repository_unavailable',
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(token);
  });

  it('turns malformed successful GitHub repository data into a typed failure', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async () => jsonResponse({
        id: 'not-a-decimal-id',
        name: 'widgets',
        full_name: 'acme/widgets',
        owner: { login: 'acme' },
      })),
    };

    await expect(setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, automationContext({ connectedAccounts, http }))).rejects.toMatchObject({
      code: 'github_repository_response_invalid',
    });
  });

  it('honors the invocation cancellation signal before issuing provider I/O', async () => {
    const controller = new AbortController();
    const reason = new Error('GitHub source setup retired');
    controller.abort(reason);
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = { request: vi.fn() };

    await expect(setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, automationContext({ connectedAccounts, http, signal: controller.signal }))).rejects.toBe(reason);
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('stops after cancellation races with exact-account materialization', async () => {
    const controller = new AbortController();
    const reason = new Error('GitHub source setup retired during account materialization');
    const connectedAccounts = {
      materialize: vi.fn(async () => {
        controller.abort(reason);
        return {
          kind: 'httpHeaders' as const,
          headers: { Authorization: 'Bearer exact-account-token' },
        };
      }),
    };
    const http = { request: vi.fn() };

    await expect(setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, automationContext({ connectedAccounts, http, signal: controller.signal }))).rejects.toBe(reason);
    expect(connectedAccounts.materialize).toHaveBeenCalledOnce();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('preserves an exact-account currentness refusal without falling back to another credential', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => {
        throw new PluginError({
          code: 'plugin_final_generation_retired',
          message: 'Plugin generation is no longer current',
        });
      }),
    };
    const http = { request: vi.fn() };

    await expect(setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, automationContext({ connectedAccounts, http }))).rejects.toMatchObject({
      code: 'plugin_final_generation_retired',
    });
    expect(connectedAccounts.materialize).toHaveBeenCalledWith(
      'github-connected-account',
      {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
      expect.objectContaining({
        expectedAccount: GITHUB_ACCOUNT,
        signal: expect.anything(),
      }),
    );
    expect(http.request).not.toHaveBeenCalled();
  });

  it('rejects a different Connected Account before materialization', async () => {
    const connectedAccounts = { materialize: vi.fn() };
    const http = { request: vi.fn() };

    await expect(setupGithubRepositoryEventSource({
      credentialRef: {
        service: {
          pluginId: 'happier.scm.forge.github',
          localId: 'other-account',
        },
        accountId: 'account-other',
      },
      repository: 'acme/widgets',
    }, automationContext({ connectedAccounts, http }))).rejects.toMatchObject({
      code: 'github_setup_credential_invalid',
    });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('rejects a malformed repository before materialization', async () => {
    const connectedAccounts = { materialize: vi.fn() };
    const http = { request: vi.fn() };

    await expect(setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets/extra',
    }, automationContext({ connectedAccounts, http }))).rejects.toMatchObject({
      code: 'github_setup_repository_invalid',
    });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('rejects tampered setup input before materialization', async () => {
    const connectedAccounts = { materialize: vi.fn() };
    const http = { request: vi.fn() };

    await expect(setupGithubRepositoryEventSource({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
      unexpected: 'tampered',
    }, automationContext({ connectedAccounts, http }))).rejects.toMatchObject({
      code: 'github_setup_input_invalid',
    });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });
});

describe('GitHub Automation Event history-gap reset', () => {
  it('exhausts opaque source cursors beyond the former page ceiling without overriding the Action page size', async () => {
    const source = {
      automationId: 'automation-a',
      triggerId: 'trigger-a',
      triggerRevision: 1,
      eventRef: { pluginId: GITHUB_PLUGIN_ID, localId: GITHUB_AUTOMATION_EVENT_LOCAL_IDS.push },
      sourceInstanceId: 'github:repository:77',
      sourceSelectorId: '00000000-0000-4000-8000-000000000001',
      sourceContractVersion: 1,
      sourceConfig: {
        v: 1,
        credentialRef: GITHUB_ACCOUNT,
        repository: {
          v: 1,
          repositoryId: '77',
          owner: 'acme',
          name: 'widgets',
          nameWithOwner: 'acme/widgets',
        },
      },
      observationTransport: {
        kind: 'checkpointedPull' as const,
        watcherMaterializationRef: {
          pluginId: GITHUB_PLUGIN_ID,
          machineId: 'machine-1',
          materializationId: 'materialization-1',
        },
      },
      filter: null,
      maximumObservationAgeMs: null,
    } satisfies Extract<PluginActionResultById['automation.event.sources.list'], Readonly<{ kind: 'page' }>>['definitions'][number];
    const row = createGithubAutomationEventCheckpointRowV1({
      checkpointRowId: createGithubAutomationEventCheckpointRowId({
        automationId: source.automationId,
        triggerId: source.triggerId,
        eventRef: source.eventRef,
        sourceSelectorId: source.sourceSelectorId,
      }),
      automationId: source.automationId,
      triggerId: source.triggerId,
      eventRef: source.eventRef,
      sourceSelectorId: source.sourceSelectorId,
      sourceInstanceId: source.sourceInstanceId,
      sourceContractVersion: source.sourceContractVersion,
      cursor: {
        v: 1,
        observationStartsAtMs: 1,
        observedAtMs: 1,
        seenEventIds: [],
        etag: 'old-etag',
      },
      lastContiguousOccurrenceId: null,
      baseline: { kind: 'currentHead', establishedAt: 1 },
      lastEvaluatedTriggerRevision: 1,
      continuity: {
        v: 1,
        endpointKind: 'repositoryEvents',
        repositoryId: '77',
        historyGap: true,
      },
    });
    const collection = {
      get: vi.fn(async () => ({ rowId: row.id, revision: 1, value: row })),
      put: vi.fn(async () => ({ rowId: row.id, revision: 2, value: row })),
    };
    const pages = Array.from({ length: 21 }, (_, index) => (
      index === 20
        ? source
        : {
          ...source,
          automationId: `automation-${index + 1}`,
          sourceSelectorId: `00000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`,
        }
    ));
    const sourceListInputs: unknown[] = [];
    let sourcePageCalls = 0;
    const actions = {
      execute: vi.fn(async (actionId: string, actionInput: unknown) => {
        if (actionId === 'automation.event.sources.list') {
          sourceListInputs.push(actionInput);
          const request = actionInput as Readonly<{ knownRevision?: string }>;
          return request.knownRevision === undefined
            ? {
              kind: 'page' as const,
              revision: '7',
              definitions: [pages[sourcePageCalls]!],
              nextCursor: sourcePageCalls++ === pages.length - 1 ? null : `page-${sourcePageCalls}`,
            }
            : { kind: 'unchanged' as const, revision: '7' };
        }
        if (actionId === 'automation.event.source.status.report') return {};
        throw new Error(`unexpected Action ${actionId}`);
      }),
    };
    const context = {
      plugin: { id: GITHUB_PLUGIN_ID, version: '0.0.0' },
      contribution: {
        id: 'automation/reset-repository-event-baseline-v1',
        qualifiedId: `${GITHUB_PLUGIN_ID}/actions/automation/reset-repository-event-baseline-v1`,
      },
      surface: 'plugin' as const,
      signal: new AbortController().signal,
      services: {
        actions,
        connectedAccounts: {
          materialize: vi.fn(async () => ({
            kind: 'httpHeaders' as const,
            headers: { Authorization: 'Bearer exact-account-token' },
          })),
        },
        http: {
          request: vi.fn(async () => jsonResponse([])),
        },
        storage: { account: { collection: vi.fn(() => collection) } },
      },
    } as unknown as PluginInvocationContext;

    await expect(resetGithubRepositoryEventHistoryGap({
      automationId: source.automationId,
      triggerId: source.triggerId,
      triggerRevision: source.triggerRevision,
      sourceSelectorId: source.sourceSelectorId,
    }, context)).resolves.toEqual({ kind: 'baselined' });

    // The provider consumes the persisted source ref through ordinary exact
    // materialization. It never substitutes a listed account or a caller
    // selection; the host operation binding is what authorizes this ref.
    expect(context.services.connectedAccounts.materialize).toHaveBeenCalledWith(
      GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
      { signal: context.signal, expectedAccount: GITHUB_ACCOUNT },
    );

    expect(sourceListInputs).toEqual([
      ...pages.map((_, index) => (
        index === 0
          ? { transport: { kind: 'checkpointedPull' } }
          : { transport: { kind: 'checkpointedPull' }, cursor: `page-${index}` }
      )),
      { transport: { kind: 'checkpointedPull' }, knownRevision: '7' },
      { transport: { kind: 'checkpointedPull' }, knownRevision: '7' },
      { transport: { kind: 'checkpointedPull' }, knownRevision: '7' },
    ]);
  });
});
