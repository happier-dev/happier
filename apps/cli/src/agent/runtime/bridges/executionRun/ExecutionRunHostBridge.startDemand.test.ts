import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const filesystemReads = vi.hoisted(() => ({
  directory: '',
  inventories: 0,
  retainedPaths: new Set<string>(),
  retainedOpens: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const { createBundledPluginPublicationFsFixture } = await import('@/plugins/projection/registry/builtIn/locators.testkit');
  return createBundledPluginPublicationFsFixture(actual);
});

// Count actual filesystem demand while preserving registry parsing, sealing,
// reconciliation, admission and native-runtime composition.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      if (String(args[0]) === filesystemReads.directory) filesystemReads.inventories++;
      return actual.readdir(...args);
    },
    open: (...args: Parameters<typeof actual.open>) => {
      if (filesystemReads.retainedPaths.has(String(args[0]))) filesystemReads.retainedOpens++;
      return actual.open(...args);
    },
  };
});

import { configuration } from '@/configuration';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { retainExecutionRunState } from '@/daemon/executionRunRegistry';
import { resolveExecutionRunPolicy } from '@/agent/executionRuns/policy/executionRunPolicy';
import { createExecutionRunRpcActionExecutor } from '@/rpc/handlers/executionRuns/dispatchExecutionRunRpcAction';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { withAdmittedSessionRun, type AdmittedSessionRunFixture } from './testkit/admittedSessionRun';
import { deriveExecutionRunIdFromActionRequestId } from './startExecutionRun';

async function retainCompletedRun(fixture: AdmittedSessionRunFixture, runId: string) {
  const agentId = readAgentRoutingIdForContributionIdentity(indexAgentRoutingIdsByContributionIdentity(
    fixture.admittedRuntime.registry.contributes.agents), fixture.agentIdentity);
  if (!agentId) throw new Error('The admitted Agent must have a routing identity');
  await retainExecutionRunState({ runId, callId: `call-${runId}`, sidechainId: `sidechain-${runId}`,
    sessionId: fixture.session.sessionId, depth: 0, intent: 'delegate',
    backendTarget: { kind: 'builtInAgent', agentId }, backendId: agentId,
    instructions: 'Previously completed work.', permissionMode: 'read_only', retentionPolicy: 'resumable',
    runClass: 'bounded', ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2 });
}

describe('ExecutionRunHostBridge new Run demand', () => {
  it.each(['execution.run.start', 'execution.run.ensure_or_start'] as const)(
    '%s starts a new Voice conversation without enumerating or opening unrelated retained Runs', async actionId => {
    await withAdmittedSessionRun({ directOwner: true, run: async fixture => {
      vi.stubEnv('HAPPIER_FEATURE_VOICE__ENABLED', '1');
      vi.stubEnv('HAPPIER_FEATURE_VOICE_AGENT__ENABLED', '1');
      const actions = createExecutionRunRpcActionExecutor({ manager: fixture.bridge!,
        context: { cwd: fixture.directory, sessionId: fixture.session.sessionId,
          getServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
            voice: { enabled: true, agent: { enabled: true } },
          } }) }) },
        isExecutionRunsEnabled: () => true,
        policy: resolveExecutionRunPolicy({ defaults: { maxConcurrentRuns: null, boundedTimeoutMs: null,
          reviewBoundedTimeoutMs: null, maxTurns: null } }),
      });
      // Distinct persisted records expose inventory work; no guessed account
      // size or timing threshold is needed for the zero-demand contract.
      for (const runId of ['unrelated-retained-a', 'unrelated-retained-b']) {
        await retainCompletedRun(fixture, runId);
      }
      const directory = join(configuration.happyHomeDir, 'tmp', 'daemon-execution-runs');
      filesystemReads.retainedPaths = new Set(readdirSync(directory)
        .filter(entry => entry.startsWith('state-') && entry.endsWith('.sealed'))
        .map(entry => join(directory, entry)));
      expect(filesystemReads.retainedPaths.size).toBeGreaterThanOrEqual(2);

      filesystemReads.inventories = 0;
      filesystemReads.retainedOpens = 0;
      filesystemReads.directory = directory;
      try {
        const request = { sessionId: fixture.session.sessionId,
          backendTarget: { kind: 'agent', identity: fixture.agentIdentity }, instructions: 'Voice conversation.',
          permissionMode: 'read_only', retentionPolicy: 'resumable', intent: 'voice_agent',
          modelSelection: null, connectedServices: null,
          runClass: 'long_lived', ioMode: 'streaming', bootstrapMode: 'none', initialContextMode: 'first_turn',
          chatModelId: 'voice-model', commitModelId: 'voice-model',
        };
        const started = await actions.execute(actionId, actionId === 'execution.run.start' ? request
          : { sessionId: fixture.session.sessionId, start: request },
        { authority: 'present_user', surface: 'rpc', defaultSessionId: fixture.session.sessionId });
        expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
        const voice = fixture.bridge!.listPublic().find(run => run.intent === 'voice_agent');
        expect(voice?.error).toBeUndefined();
        expect(voice).toMatchObject({ intent: 'voice_agent', status: 'running' });
        expect(fixture.nativeOpen).toHaveBeenCalledTimes(1);
        expect({ inventories: filesystemReads.inventories, unrelatedRetainedOpens: filesystemReads.retainedOpens })
          .toEqual({ inventories: 0, unrelatedRetainedOpens: 0 });
      } finally {
        filesystemReads.directory = '';
        filesystemReads.retainedPaths.clear();
      }
      expect(fixture.bridge!.get('unrelated-retained-a')).toBeNull();
      expect(await actions.execute('execution.run.list', { sessionId: fixture.session.sessionId },
        { authority: 'present_user', surface: 'rpc', defaultSessionId: fixture.session.sessionId }))
        .toMatchObject({ ok: true });
      expect(fixture.bridge!.get('unrelated-retained-a')).toMatchObject({ status: 'succeeded' });
    } });
  });

  it('recovers a request-bound completed Run before deciding whether to start it again', async () => {
    await withAdmittedSessionRun({ directOwner: true, run: async fixture => {
      const actionRequestId = 'already-admitted-request';
      const runId = deriveExecutionRunIdFromActionRequestId(actionRequestId);
      await retainCompletedRun(fixture, runId);
      expect(fixture.bridge!.get(runId)).toBeNull();
      const started = await fixture.start({ actionRequestId: ` ${actionRequestId} ` });
      expect(started.runId).toBe(runId);
      expect(fixture.bridge!.get(runId)).toMatchObject({ status: 'succeeded' });
      expect(fixture.nativeOpen).not.toHaveBeenCalled();
    } });
  });
});
