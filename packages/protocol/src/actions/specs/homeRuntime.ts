import { lazyActionSpecArray } from '../lazyActionSpecValue.js';
import { HOME_RUNTIME_ACTION_IDS_V1, HOME_RUNTIME_ACTION_INPUT_SCHEMAS_V1 as inputs,
  HOME_RUNTIME_ACTION_OUTPUT_SCHEMAS_V1 as outputs } from '../../home/runtime/actionsV1.js';
import { readRecord } from '../../inputs/inputRecords.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';
import { stripBrowserDiagnosticUrlValues } from '../../browser/diagnostics/egress/url.js';
import { projectRelayAccessConfigV1 } from '../../system/tasks/relayAccessConfigV1.js';

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
  'relay.runtime.task.cancel': 'Cancel local runtime task',
  'home.runtime.get': 'Get Home runtime information',
  'home.runtime.restart': 'Restart Home on connected Machine',
} as const;
const reads: ReadonlySet<string> = new Set(['relay.access.status', 'relay.runtime.status',
  'relay.runtime.personal_home.inspect', 'relay.runtime.personal_home.verify_backup', 'home.runtime.get']);
const presentation: ReadonlySet<string> = new Set(['relay.runtime.personal_home.choose_archive',
  'relay.runtime.personal_home.choose_backup_destination', 'relay.runtime.reveal_output']);

/** User-supplied URLs may contain credentials, even with reference-only provider credentials. */
function projectRelayAccessInput(value: unknown): unknown {
  const input = readRecord(value);
  return {
    config: projectRelayAccessConfigV1(input.config),
    ...(typeof input.upstreamUrl === 'string' ? { upstreamUrl: stripBrowserDiagnosticUrlValues(input.upstreamUrl) } : {}),
  };
}

function createHomeRuntimeActionSpecsV1() {
  return HOME_RUNTIME_ACTION_IDS_V1.map((id): PreNormalizedActionSpec => {
  const read = reads.has(id);
  const danger = !read && !presentation.has(id);
  return {
    id, approval: { result: 'required' }, title: titles[id], description: 'Use the addressed Home or answering client’s existing runtime and SystemTask owner.',
    ...(id === 'home.runtime.restart' || id === 'relay.runtime.restart'
      ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
    ...(id === 'relay.runtime.personal_home.claim' ? { irreversible: true as const } : {}),
    safety: danger ? 'danger' : 'safe', sideEffectClass: read ? 'read' : danger ? 'danger' : 'write',
    requiredAuthority: 'account_automation', executionPlacement: id === 'home.runtime.restart' ? 'machine' : 'client',
    placements: [], surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: id === 'home.runtime.restart', rpc: false },
    bindings: { mcpToolName: id.replaceAll('.', '_') },
    ...(id === 'home.runtime.restart' ? {
      cli: { commands: [{ path: id.split('.').map(segment => segment.replaceAll('_', '-')), visibility: 'canonical' as const }], acceptsServerId: true },
    } : {}),
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
        { path: 'config', title: 'Access selection', widget: 'json' as const, required: true },
      ] : []),
      ...(id === 'relay.runtime.open_path' || id === 'relay.runtime.reveal_output' ? [{ path: 'path', title: 'Path', widget: 'text' as const, required: true }] : []),
      ...(id === 'relay.runtime.task.cancel' ? [{ path: 'taskId', title: 'Local task', widget: 'text' as const, required: true }] : []),
    ] },
    ...(id === 'relay.access.configure' ? { approvalInputCustody: 'live_only', projectObservationInput: projectRelayAccessInput } : {}),
  };
});
}

export const HOME_RUNTIME_ACTION_SPECS_V1: ReturnType<typeof createHomeRuntimeActionSpecsV1> = lazyActionSpecArray(createHomeRuntimeActionSpecsV1);
