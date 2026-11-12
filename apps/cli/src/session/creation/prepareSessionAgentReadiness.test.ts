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


it.each(['ready', 'unregistered', 'wrong-definition', 'not-installed'] as const)(
  'matches configured ACP inventory identity without borrowing another definition: %s', async state => {
    const result = await prepareSessionAgentReadiness({ machineId: 'machine', serverId: 'home',
      agentId: 'custom-acp', definitionId: 'qa-foldseed-acp',
      // Only the Machine Action transport is replaced; parsing and readiness stay real.
      invoke: async action => {
        if (state === 'not-installed' && action === SESSION_AGENT_READINESS_CHILDREN_V1.acquire.action) {
          return { ok: true, result: { ok: false, errorCode: 'install_unavailable', error: 'No installer is available' } };
        }
        if (action !== SESSION_AGENT_READINESS_CHILDREN_V1.inventory.action) throw new Error('Unexpected acquisition');
        const agentId = 'happier.agent.custom-acp/custom-acp';
        const definitionId = state === 'wrong-definition' ? 'another-definition' : 'qa-foldseed-acp';
        return { ok: true, result: state === 'unregistered'
          ? { items: [], unavailable: [{ agentId, definitionId, reason: 'probe_failed', errorCode: 'unknown-capability' }] }
          : { items: [{ agentId, definitionId, title: 'Foldseed', installed: state !== 'not-installed',
            version: null, latestVersion: null, update: { supported: false, command: null },
            signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
            install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [],
          }] } };
      },
    });
    if (state === 'ready' || state === 'unregistered') expect(result).toBeNull();
    else expect(result).toMatchObject({ result: { code: 'agent_cli_not_ready' } });
  },
);
