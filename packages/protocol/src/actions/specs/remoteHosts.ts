import { REMOTE_HOST_ACTION_INPUT_SCHEMAS_V1 as inputs, REMOTE_HOST_ACTION_OUTPUT_SCHEMAS_V1 as outputs,
  type RemoteHostActionIdV1 } from '../../remoteHosts/remoteHostActionsV1.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import type { ActionInputHints } from '../actionInputHints.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { stripBrowserDiagnosticUrlValues } from '../../browser/diagnostics/egress/url.js';

function projectRemoteHostObservation(value: unknown): unknown {
  const record = readRecord(value);
  const host = readRecord(record.host);
  const operation = readRecord(record.operation);
  const config = readRecord(operation.config);
  const target = readRecord(record.target);
  const key = readRecord(record.key);
  const projectKey = (value: unknown) => {
    const row = readRecord(value);
    return { host: '[redacted]', ...(typeof row.port === 'number' ? { port: row.port } : {}),
      ...(typeof row.algorithm === 'string' ? { algorithm: row.algorithm } : {}),
      ...(typeof row.fingerprintSha256 === 'string' ? { fingerprintSha256: row.fingerprintSha256 } : {}) };
  };
  return {
    ...(typeof key.fingerprintSha256 === 'string' ? { key: projectKey(key) } : {}),
    ...(Array.isArray(record.keys) ? { keys: record.keys.map(projectKey) } : {}),
    ...(target.kind === 'native' || target.kind === 'desktop' ? { target: { kind: target.kind, identity: '[redacted]' } } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    ...(typeof record.hostId === 'string' ? { hostId: record.hostId } : typeof host.id === 'string' ? { hostId: host.id } : {}),
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
    ...(typeof record.revision === 'number' ? { revision: record.revision } : {}),
    ...(operation.kind === 'disable' ? { operation: { kind: 'disable' } }
      : operation.kind === 'configure' ? { operation: { kind: 'configure', config: {
        ...(typeof config.providerId === 'string' ? { providerId: config.providerId } : {}),
        ...(config.providerId === 'lan' && typeof config.url === 'string' ? { url: stripBrowserDiagnosticUrlValues(config.url) } : {}),
        ...(config.providerId === 'cloudflareNamed' && typeof config.hostname === 'string' ? { hostname: config.hostname } : {}),
      } } } : {}),
  };
}

// The same safe fields feed the default preview and shared approval admission.
// Credential values belong exclusively to the existing live-only invocation.
const relayConfigurationFields: ActionInputHints['fields'] = [
  { path: 'hostId', title: 'Remote host', widget: 'text', required: true },
  { path: 'operation.kind', title: 'Operation', widget: 'select', required: true,
    options: [{ value: 'configure', label: 'Configure relay' }, { value: 'disable', label: 'Disable relay' }] },
  { path: 'operation.config.providerId', title: 'Relay provider', widget: 'select', required: true,
    visibleWhen: { op: 'eq', path: 'operation.kind', value: 'configure' },
    options: [
      { value: 'localOnly', label: 'Local only' }, { value: 'lan', label: 'LAN' },
      { value: 'tailscaleServe', label: 'Tailscale Serve' }, { value: 'tailscaleFunnel', label: 'Tailscale Funnel' },
      { value: 'cloudflareNamed', label: 'Cloudflare named tunnel' },
    ] },
  { path: 'operation.config.url', title: 'Relay URL', widget: 'url', required: true,
    visibleWhen: { op: 'eq', path: 'operation.config.providerId', value: 'lan' } },
  { path: 'operation.config.hostname', title: 'Relay hostname', widget: 'text', required: true,
    visibleWhen: { op: 'eq', path: 'operation.config.providerId', value: 'cloudflareNamed' } },
];

function remoteHostSpec<Id extends RemoteHostActionIdV1>(id: Id, title: string, summary: string, options: Readonly<{
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
    // Composite saves may contain Plain SavedSecret content. Only the admitted
    // live invocation keeps it; durable approval state uses the safe projection.
    ...(id === 'remote_hosts.save' || id === 'remote_hosts.relay.configure' || id === 'remote_hosts.trusted_keys.remove'
      || id === 'remote_hosts.trusted_keys.clear' || id === 'remote_hosts.tunnel.stop' ? { approvalInputCustody: 'live_only' as const } : {}),
    inputHints: { description: summary, fields: id === 'remote_hosts.relay.configure' ? relayConfigurationFields
      : id === 'remote_hosts.trusted_keys.remove' ? [{ path: 'key', title: 'Exact trusted host key', widget: 'json', required: true }]
      : id === 'remote_hosts.trusted_keys.clear' ? [{ path: 'keys', title: 'Reviewed trusted host keys', widget: 'json', required: true }]
      : id === 'remote_hosts.tunnel.stop' ? [{ path: 'target', title: 'Exact local tunnel target', widget: 'json', required: true }] : [] },
    ...(!options.client ? { cli: { acceptsServerId: true, commands: [{ path: id.split('.').map(segment => segment.replaceAll('_', '-')), visibility: 'canonical' as const }] } } : {}),
  };
}
export const REMOTE_HOST_ACTION_SPECS_V1 = [
  remoteHostSpec('remote_hosts.trusted_keys.list', 'List trusted SSH host keys', 'Read this device’s trusted SSH host keys.', { client: true, read: true }),
  remoteHostSpec('remote_hosts.trusted_keys.remove', 'Remove trusted SSH host key', 'Remove the exact reviewed key from this device.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.trusted_keys.clear', 'Clear trusted SSH host keys', 'Remove only the reviewed set of trusted keys from this device.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.tunnel.stop', 'Stop SSH tunnel', 'Release the exact native lease or stop the exact desktop tunnel.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.list', 'List remote hosts',
    'See the remote hosts saved in your account.', { read: true,  }),
  remoteHostSpec('remote_hosts.read', 'Read remote host',
    'See one saved remote host: its address, how it connects and what is set up on it.', { read: true,  }),
  remoteHostSpec('remote_hosts.add', 'Add remote host',
    'Open the form for adding a computer you reach over SSH.', { client: true,  }),
  remoteHostSpec('remote_hosts.edit', 'Edit remote host',
    'Open a saved remote host for editing.', { client: true,  }),
  remoteHostSpec('remote_hosts.save', 'Save remote host',
    'Save a remote host with its address and sign-in details.', { danger: true }),
  remoteHostSpec('remote_hosts.duplicate', 'Duplicate remote host',
    'Make a copy of a saved remote host to adjust.', {  }),
  remoteHostSpec('remote_hosts.delete', 'Delete remote host',
    'Remove a saved remote host from your account. Nothing on the host itself changes.', { danger: true }),
  remoteHostSpec('remote_hosts.connect', 'Connect to remote host',
    'Open a connection to a saved remote host from this device.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.setup_as_machine', 'Set up remote host as a machine',
    'Install Happier on the host and add it to your machines, so sessions can run there.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.use', 'Use remote host as relay',
    'Choose this host as the relay your devices connect through.', { client: true,  }),
  remoteHostSpec('remote_hosts.relay.configure', 'Configure relay on remote host',
    'Set how the relay on this host is reached and who may use it.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.test', 'Test relay on remote host',
    'Check that your devices can reach the relay on this host.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.cli.install_or_update', 'Install or update Happier on remote host',
    'Install the Happier command-line app on the host, or bring it up to date.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.daemon.install_or_update', 'Install or update background service on remote host',
    'Install the Happier background service on the host, or bring it up to date.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.daemon.start', 'Start background service on remote host',
    'Start the Happier background service, so the host can run sessions.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.daemon.stop', 'Stop background service on remote host',
    'Stop the Happier background service. Sessions on the host cannot be reached until it starts again.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.daemon.restart', 'Restart background service on remote host',
    'Stop and start the Happier background service on the host.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.status', 'Check relay on remote host',
    'See whether the relay on this host is installed and running.', { client: true, read: true,  }),
  remoteHostSpec('remote_hosts.relay.access.status', 'Get relay access status on remote host',
    'Read the admitted host’s existing relay access configuration and reachability.', { client: true, read: true }),
  remoteHostSpec('remote_hosts.relay.install_or_update', 'Install or update relay on remote host',
    'Install the relay on the host, or bring it up to date.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.start', 'Start relay on remote host',
    'Start the relay, so devices can connect through this host.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.stop', 'Stop relay on remote host',
    'Stop the relay. Devices that connect through this host lose that path until it starts again.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.relay.restart', 'Restart relay on remote host',
    'Stop and start the relay on this host.', { client: true, danger: true }),
  remoteHostSpec('remote_hosts.credential.change', 'Change remote host sign-in',
    'Replace the key or password used to sign in to this host.', { danger: true }),
  remoteHostSpec('remote_hosts.personal_home.erase', 'Erase personal Home on remote host',
    'Permanently delete the personal Home kept on this host, with everything in it.', { client: true, danger: true }),
] as const satisfies readonly PreNormalizedActionSpec[];
