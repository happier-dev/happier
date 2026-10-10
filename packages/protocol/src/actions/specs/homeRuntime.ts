import { HOME_RUNTIME_ACTION_IDS_V1, HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1 as inputs,
  HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1 as outputs } from '../../home/runtime/actionsV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { stripBrowserDiagnosticUrlValues } from '../../browser/diagnostics/egress/url.js';

const titles = {
  'relay.access.status': 'Get relay access status', 'relay.access.configure': 'Configure relay access',
  'relay.access.disable': 'Disable relay access', 'relay.runtime.status': 'Get local runtime status',
  'relay.runtime.install_or_update': 'Install or update local runtime', 'relay.runtime.start': 'Start local runtime',
  'relay.runtime.stop': 'Stop local runtime', 'relay.runtime.restart': 'Restart local runtime',
  'relay.runtime.uninstall': 'Uninstall local runtime', 'relay.runtime.personal_home.inspect': 'Inspect Personal Home',
  'relay.runtime.personal_home.backup': 'Back up Personal Home', 'relay.runtime.personal_home.verify_backup': 'Verify Personal Home backup',
  'relay.runtime.personal_home.restore': 'Restore Personal Home', 'relay.runtime.personal_home.recover_restore': 'Recover interrupted Personal Home restore',
  'relay.runtime.personal_home.erase': 'Erase Personal Home', 'relay.runtime.personal_home.claim': 'Claim Personal Home from its hosting desktop',
  'relay.runtime.personal_home.relocate': 'Move Personal Home', 'relay.runtime.personal_home.choose_archive': 'Choose Personal Home backup archive',
  'relay.runtime.personal_home.choose_backup_destination': 'Choose Personal Home backup destination',
  'relay.runtime.open_path': 'Open runtime data or logs', 'relay.runtime.reveal_output': 'Reveal runtime output',
  'home.runtime.get': 'Get Home release information',
  'home.runtime.restart': 'Restart Home on connected Machine',
} as const;
const reads: ReadonlySet<string> = new Set(['relay.access.status', 'relay.runtime.status',
  'relay.runtime.personal_home.inspect', 'relay.runtime.personal_home.verify_backup', 'home.runtime.get']);
const presentation: ReadonlySet<string> = new Set(['relay.runtime.personal_home.choose_archive',
  'relay.runtime.personal_home.choose_backup_destination', 'relay.runtime.open_path', 'relay.runtime.reveal_output']);

/** Credential-bearing relay config remains exclusively in the admitted live invocation. */
function projectRelayAccessInput(value: unknown): unknown {
  const input = readRecord(value);
  const config = readRecord(input.config);
  return {
    ...(typeof input.providerId === 'string' ? { providerId: input.providerId } : {}),
    config: {
      ...(typeof config.providerId === 'string' ? { providerId: config.providerId } : {}),
      ...(typeof config.url === 'string' ? { url: stripBrowserDiagnosticUrlValues(config.url) } : {}),
      ...(typeof config.hostname === 'string' ? { hostname: config.hostname } : {}),
    },
    ...(typeof input.upstreamUrl === 'string' ? { upstreamUrl: stripBrowserDiagnosticUrlValues(input.upstreamUrl) } : {}),
  };
}

export const HOME_RUNTIME_ACTION_SPECS_V1 = HOME_RUNTIME_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
  const read = reads.has(id);
  const danger = !read && !presentation.has(id);
  return {
    id, title: titles[id], description: 'Use the addressed Home or answering client’s existing runtime and SystemTask owner.',
    safety: danger ? 'danger' : 'safe', sideEffectClass: read ? 'read' : danger ? 'danger' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: id === 'home.runtime.restart' ? 'machine' : 'client',
    placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: id.replaceAll('.', '_') },
    cli: { commands: [{ path: id.split('.').map(segment => segment.replaceAll('_', '-')), visibility: 'canonical' }], acceptsServerId: true },
    inputSchema: inputs[id], outputSchema: outputs[id],
    inputHints: { fields: [
      ...(id === 'home.runtime.restart' ? [{ path: 'machineId', title: 'Machine', widget: 'text' as const, required: true }] : []),
      ...(id === 'relay.runtime.personal_home.relocate' ? [
        { path: 'hostId', title: 'Destination host', widget: 'text' as const, required: true },
        { path: 'sourceServerId', title: 'Source Home', widget: 'text' as const, required: true },
      ] : []),
      ...(id.startsWith('relay.runtime.personal_home.') && !presentation.has(id) && id !== 'relay.runtime.personal_home.relocate'
        ? [{ path: 'purpose.canonicalServerUrl', title: 'Personal Home', widget: 'url' as const, required: true }] : []),
      ...(id === 'relay.runtime.personal_home.restore' || id === 'relay.runtime.personal_home.verify_backup'
        ? [{ path: 'personalHomeOperation.archivePath', title: 'Backup archive', widget: 'text' as const, required: true }] : []),
      ...(id === 'relay.runtime.personal_home.backup' ? [{ path: 'personalHomeOperation.outputPath', title: 'Backup output', widget: 'text' as const }] : []),
      ...(id === 'relay.runtime.personal_home.claim' ? [{ path: 'personalHomeOperation.accountId', title: 'Account', widget: 'text' as const, required: true }] : []),
      ...(id === 'relay.access.configure' ? [
        { path: 'providerId', title: 'Access provider', widget: 'text' as const, required: true },
        { path: 'config.url', title: 'Relay URL', widget: 'url' as const },
        { path: 'config.hostname', title: 'Relay hostname', widget: 'text' as const },
      ] : []),
      ...(id === 'relay.runtime.open_path' || id === 'relay.runtime.reveal_output' ? [{ path: 'path', title: 'Path', widget: 'text' as const, required: true }] : []),
    ] },
    ...(id === 'relay.access.configure' ? { approvalInputCustody: 'live_only', projectObservationInput: projectRelayAccessInput } : {}),
  };
});
