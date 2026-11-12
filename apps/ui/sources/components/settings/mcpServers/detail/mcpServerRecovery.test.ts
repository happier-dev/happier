import { describe, expect, it, vi } from 'vitest';
import { McpServerCatalogEntryV1Schema } from '@happier-dev/protocol/mcp/servers/settingsV1';
import { createMcpServerRecovery, type McpRecoveryEditor } from './mcpServerRecovery';
import { mcpServerStatus, mcpServerMachineStatuses } from '../status/mcpServerStatus';
import { resolveSavedSecretReference } from '@/sync/store/settings/savedSecretCatalogSnapshot';

const server = McpServerCatalogEntryV1Schema.parse({ id: 'linear', name: 'linear', transport: 'http', env: {}, createdAt: 1, updatedAt: 1,
  remote: { url: 'https://mcp.linear.app/mcp', auth: { kind: 'oauth' }, headers: { Authorization: { t: 'template', template: 'Bearer {key}', vars: { key: { t: 'savedSecret', secretId: 'missing' } } } } } });

function setup(initial = server) {
  let draft = initial;
  let editor: McpRecoveryEditor | undefined;
  const route = vi.fn();
  const commit = vi.fn();
  const recovery = createMcpServerRecovery({ server: initial, missingKeys: new Set(['Authorization', 'TOKEN']), scopeServerId: 'home / one',
    isMissingReference: ref => resolveSavedSecretReference(null, [], ref).status !== 'ready',
    onChangeServer: update => { draft = update(draft); }, onCommit: commit,
    openEditor: next => { editor = next; }, openRoute: route });
  const fixes = { ...recovery, signIn: () => {}, reconnect: () => {}, grantAccess: () => {}, tryAgain: () => {} };
  return { recovery, fixes, route, commit, editor: () => editor, draft: () => draft };
}

describe('MCP detail recovery destinations', () => {
  it('pressing Add key edits the missing ValueRef and preserves its header template', () => {
    const state = setup();
    const status = mcpServerStatus({ entry: server, signIn: null, tests: {}, machines: [], fixes: state.fixes,
      savedSecretCatalog: { resolveReference: ref => resolveSavedSecretReference(null, [], ref) } }).find(row => row.kind === 'key');
    status!.fix!.onPress();
    expect(state.editor()).toMatchObject({ kind: 'header', initialKey: 'Authorization', initialValueRef: { t: 'savedSecret', secretId: 'missing' } });
    expect(state.editor()!.onSubmit({ key: 'Authorization', valueRef: { t: 'savedSecret', secretId: 'replacement' } })).toBe(true);
    expect(state.draft().remote!.headers.Authorization).toEqual({ t: 'template', template: 'Bearer {key}', vars: { key: { t: 'savedSecret', secretId: 'replacement' } } });
    expect(state.commit).toHaveBeenCalled();
  });
  it('pressing How to fix opens that machine runtime setup under the exact Home', () => {
    const state = setup();
    const statuses = mcpServerMachineStatuses({ machines: [{ machineId: 'machine / two', name: 'MacBook', online: true }],
      tests: { 'machine / two': { ok: false, runtimeMissing: 'uv', errorCode: 'spawn_failed', checkedAt: 1 } }, fixes: state.fixes });
    statuses.get('machine / two')!.fix!.onPress();
    expect(state.route).toHaveBeenCalledWith('/machines/machine%20%2F%20two?serverId=home%20%2F%20one&tab=setup&page=tools');
  });
  it('API-key recovery saves a secret-backed bearer header and retires OAuth only on submit', () => {
    const state = setup(McpServerCatalogEntryV1Schema.parse({ ...server, remote: { ...server.remote, headers: {} } }));
    state.recovery.useApiKey();
    expect(state.editor()).toMatchObject({ kind: 'header', initialKey: 'Authorization' });
    expect(state.draft().remote!.auth).toEqual({ kind: 'oauth' });
    expect(state.editor()!.onSubmit({ key: 'Authorization', valueRef: { t: 'savedSecret', secretId: 'api-key' } })).toBe(true);
    expect(state.draft().remote).toEqual({ url: server.remote!.url, headers: { Authorization: { t: 'template', template: 'Bearer {api_key}', vars: { api_key: { t: 'savedSecret', secretId: 'api-key' } } } } });
    expect(state.commit).toHaveBeenCalled();
  });
  it('an environment recovery keeps other values and an API-key cancel keeps OAuth', () => {
    const local = McpServerCatalogEntryV1Schema.parse({ ...server, transport: 'stdio', remote: undefined,
      stdio: { command: 'uvx', args: [] }, env: { TOKEN: { t: 'savedSecret', secretId: 'missing' }, REGION: { t: 'literal', v: 'eu' } } });
    const state = setup(local);
    state.recovery.addKey();
    expect(state.editor()).toMatchObject({ kind: 'env', initialKey: 'TOKEN' });
    expect(state.editor()!.onSubmit({ key: 'other', valueRef: { t: 'savedSecret', secretId: 'replacement' } })).toBe(false);
    expect(state.commit).not.toHaveBeenCalled();
    state.editor()!.onSubmit({ key: 'TOKEN', valueRef: { t: 'savedSecret', secretId: 'replacement' } });
    expect(state.draft().env).toEqual({ TOKEN: { t: 'savedSecret', secretId: 'replacement' }, REGION: { t: 'literal', v: 'eu' } });
    const api = setup();
    api.recovery.useApiKey();
    expect(api.draft()).toBe(server);
    expect(api.commit).not.toHaveBeenCalled();
  });
});
