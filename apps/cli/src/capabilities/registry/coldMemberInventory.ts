import type { CapabilitiesDetectRequest, CapabilitiesDetectResponse } from '../types';
import { detectAgentSetupFacts } from '../snapshots/cliSnapshot';
import { createAcpAgentInventoryCapability } from './machineAgentsInventory';

/** An absent member home has no personal installs to probe. Publish declared
 * setup options without reading the daemon's home or starting native setup. */
export async function readColdMemberInventory(request: CapabilitiesDetectRequest,
  accountId: string | undefined): Promise<CapabilitiesDetectResponse> {
  const results: CapabilitiesDetectResponse['results'] = {};
  const checkedAt = Date.now();
  for (const item of request.requests ?? []) {
    if (item.id.startsWith('cli.')) {
      const facts = await detectAgentSetupFacts(item.id.slice(4), false, true);
      results[item.id] = { ok: true, checkedAt, data: {
        ...facts, available: false, installed: false, preparation: 'member_not_prepared',
        version: null, latestVersion: null, update: { supported: false, command: null },
        install: { ...facts.install, executionScope: 'member' },
      } };
    } else if (item.id === 'tool.acpAgentInventory') {
      results[item.id] = { ok: true, checkedAt, data: await createAcpAgentInventoryCapability().detect({
        request: item, context: { cliSnapshot: null, accountId, agentInstallExecutionScope: 'member', memberNotPrepared: true },
      }) };
    } else {
      results[item.id] = { ok: false, checkedAt,
        error: { code: 'member_not_prepared', message: 'Private execution has not been prepared' } };
    }
  }
  return { protocolVersion: 1, results };
}
