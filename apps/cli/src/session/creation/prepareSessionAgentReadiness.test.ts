import { expect, it } from 'vitest';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';

import { prepareSessionAgentReadiness } from './prepareSessionAgentReadiness';

it.each(['inventory', 'acquire', 'status'] as const)(
  'preserves the %s Action failure before Session birth', async phase => {
    const failure: ActionExecuteFailure = { ok: false, errorCode: 'machine_target_not_current',
      error: 'Machine is unavailable', details: { phase, retryable: true }, effectAttempted: false };
    const actions: string[] = [];
    // Action invocation crosses the Home/daemon transport boundary. Keep the
    // readiness decision and its real inventory/install parsers beneath it.
    const result = await prepareSessionAgentReadiness({ machineId: 'machine', serverId: 'home', agentId: 'codex',
      invoke: async action => {
        actions.push(action);
        if (action === SESSION_AGENT_READINESS_CHILDREN_V1[phase].action) return failure;
        if (action === SESSION_AGENT_READINESS_CHILDREN_V1.inventory.action) return { ok: true, result: { items: [{
          agentId: 'codex', title: 'Codex', installed: false, version: null, latestVersion: null,
          update: { supported: false, command: null },
          signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
          install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
        }] } };
        if (action === SESSION_AGENT_READINESS_CHILDREN_V1.acquire.action) return { ok: true,
          result: { ok: true, jobId: 'install-job' } };
        throw new Error(`Unexpected readiness Action: ${action}`);
      },
    });
    expect(result).toEqual({ result: failure });
    expect(actions).toEqual((phase === 'inventory' ? ['inventory'] : phase === 'acquire'
      ? ['inventory', 'acquire'] : ['inventory', 'acquire', 'status'])
      .map(role => SESSION_AGENT_READINESS_CHILDREN_V1[role as keyof typeof SESSION_AGENT_READINESS_CHILDREN_V1].action));
  },
);
