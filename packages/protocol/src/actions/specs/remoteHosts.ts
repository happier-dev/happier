import { REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1 as inputs, REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  type RemoteHostActionIdV1 } from '../../remoteHosts/remoteHostActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { readRecord } from '../../inputs/inputRecords.js';

function projectRemoteHostObservation(value: unknown): unknown {
  const record = readRecord(value);
  const host = readRecord(record.host);
  return {
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof record.hostId === 'string' ? { hostId: record.hostId } : typeof host.id === 'string' ? { hostId: host.id } : {}),
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    ...(typeof record.revision === 'number' ? { revision: record.revision } : {}),
  };
}
function remoteHostSpec<Id extends RemoteHostActionIdV1>(id: Id, title: string, options: Readonly<{
  client?: boolean; read?: boolean; danger?: boolean;
}>): PreNormalizedActionSpec & Readonly<{ id: Id; inputSchema: (typeof inputs)[Id]; outputSchema: (typeof outputs)[Id] }> {
  return {
    id, title, safety: options.danger ? 'danger' : 'safe',
    sideEffectClass: options.read ? 'read' : options.danger ? 'danger' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: options.client ? 'client' : 'account', placements: [],
    surfaces: { ui: true, cli: !options.client, agent: true, mcp: true, voice: false, rpc: !options.client },
    bindings: { mcpToolName: id.replaceAll('.', '_'), ...(!options.client ? { rpcMethod: id } : {}) },
    inputSchema: inputs[id], outputSchema: outputs[id],
    projectObservationInput: projectRemoteHostObservation, projectObservationOutput: projectRemoteHostObservation,
    inputHints: { fields: [] },
    ...(!options.client ? { cli: { acceptsServerId: true, commands: [{ path: id.split('.').map(segment => segment.replaceAll('_', '-')), visibility: 'canonical' as const }] } } : {}),
  };
}
export const REMOTE_HOST_ACTION_SPECS_V1 = [
  remoteHostSpec('remote_hosts.list', 'list remote host', { read: true,  }),
  remoteHostSpec('remote_hosts.read', 'read remote host', { read: true,  }),
  remoteHostSpec('remote_hosts.add', 'add remote host', { client: true,  }),
  remoteHostSpec('remote_hosts.edit', 'edit remote host', { client: true,  }),
  remoteHostSpec('remote_hosts.save', 'save remote host', { danger: true }),
  remoteHostSpec('remote_hosts.duplicate', 'duplicate remote host', {  }),
  remoteHostSpec('remote_hosts.delete', 'delete remote host', { danger: true }),
  remoteHostSpec('remote_hosts.connect', 'connect remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.setup_as_machine', 'setup as machine remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.use', 'relay use remote host', { client: true,  }),
  remoteHostSpec('remote_hosts.relay.configure', 'relay configure remote host', { client: true,  }),
  remoteHostSpec('remote_hosts.relay.test', 'relay test remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.cli.install_or_update', 'cli install or update remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.daemon.install_or_update', 'daemon install or update remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.daemon.start', 'daemon start remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.daemon.stop', 'daemon stop remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.daemon.restart', 'daemon restart remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.status', 'relay status remote host', { client: true, read: true,  }),
  remoteHostSpec('remote_hosts.relay.install_or_update', 'relay install or update remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.start', 'relay start remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.stop', 'relay stop remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.restart', 'relay restart remote host', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.credential.change', 'credential change remote host', { danger: true }),
  remoteHostSpec('remote_hosts.personal_home.erase', 'personal home erase remote host', { client: true, danger: true }),
] as const satisfies readonly PreNormalizedActionSpec[];

