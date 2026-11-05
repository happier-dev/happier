import { describe, expect, it } from 'vitest';
import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { createLocalRunControllerV1 } from './localRunController.js';
import { bindLocalActFormV1, invokeLocalActFormV1, openLocalActFormV1, executeLocalActFormIntentV1 } from './mountedForm.js';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { PLUGIN_MANIFEST } from '../../../manifest.js';
import { LocalActRunFormInputV1Schema, type LocalActRunSeedV1 } from '../../../actions/local/contracts.js';
import { githubLocalRunOpenIntentV1 } from '../localRunEntry.js';

function scopeBoundary(): PluginEphemeralSharedScope {
  const entries = new Map<string, { value: unknown; dispose(): void; refs: number }>();
  return { acquire<T>(key: string, create: () => { value: T; dispose(): void }) {
    let entry = entries.get(key);
    if (!entry) { const created = create(); entry = { ...created, refs: 0 }; entries.set(key, entry); }
    entry.refs++;
    const held = entry;
    // The host's opaque generic shared-value boundary preserves the constructor's value type.
    return { value: held.value as T, release() { if (--held.refs === 0) { held.dispose(); entries.delete(key); } } };
  } };
}
const seed = { target: { kind: 'session', sessionId: 'session-a6' },
  workspace: { serverId: 'home', workspaceId: 'checkout', machineId: 'primary', rootPath: '/repo' } } as const;
describe('local form safe mounted intent', () => {
  it.each([
    [seed.target, 'github-local-act'],
    [{ kind: 'project', projectId: 'project-workflows' }, 'github-local-act-project'],
  ] as const)('opens the declared %j target, edits only its actual mount and refuses retirement', async (target, localId) => {
    const intent = target.kind === 'project'
      ? githubLocalRunOpenIntentV1({ target, workspace: seed.workspace })
      : { operation: { kind: 'open' as const, seed: { ...seed, target } } };
    const requestedSeed = intent.operation.seed;
    const scope = scopeBoundary();
    let effects = 0;
    const host = { executeAction: (async () => { effects++; throw new Error('No execution during form intents'); }) as PluginUiHostApi['executeAction'] };
    const controller = createLocalRunControllerV1({ accountId: 'account', host, seed: requestedSeed });
    let unbind = () => {};
    const result = await executeLocalActFormIntentV1(intent, {
      ephemeralSharedScope: scope, ui: { openSurface: async (view, input) => {
      expect(view).toEqual({ pluginId: PLUGIN_MANIFEST.id, localId });
      expect(input).toEqual({ seed: requestedSeed });
      const destination = PLUGIN_MANIFEST.contributes.ui?.views?.find(candidate => candidate.id === localId);
      expect(destination).toMatchObject({ container: 'detailsPane', target: { kind: target.kind } });
      unbind = bindLocalActFormV1(scope, 'host-mounted-id', requestedSeed, controller);
    } }, signal: new AbortController().signal });
    expect(result).toEqual({ kind: 'opened', mountId: 'host-mounted-id' });
    expect(await invokeLocalActFormV1(scope, { mountId: 'host-mounted-id', operation: { kind: 'readSelection' } }))
      .toMatchObject({ status: 'applied', selection: { workspace: seed.workspace, architecture: '' } });
    const selection = { ...controller.getSnapshot().selection, architecture: 'linux/arm64', matrix: ['node:22'] };
    expect(await invokeLocalActFormV1(scope, { mountId: 'host-mounted-id', operation: { kind: 'setSelection', selection } }))
      .toEqual({ status: 'applied' });
    expect(controller.getSnapshot().selection.architecture).toBe('linux/arm64');
    expect(effects).toBe(0);
    unbind(); controller.dispose();
    expect(await invokeLocalActFormV1(scope, { mountId: 'host-mounted-id', operation: { kind: 'readSelection' } }))
      .toEqual({ status: 'unavailable' });
    expect(await executeLocalActFormIntentV1({ mountId: 'host-mounted-id', operation: { kind: 'readSelection' } }, {
      ephemeralSharedScope: null, ui: { openSurface: async () => {} }, signal: AbortSignal.abort(),
    })).toEqual({ status: 'unavailable' });
  });
  it('requires an explicit producer target rather than deriving one from the checkout', () => {
    expect(LocalActRunFormInputV1Schema.safeParse({ operation: { kind: 'open', seed: { workspace: seed.workspace } } }).success).toBe(false);
  });
  it('does not acknowledge a different Session mount for an identical checkout and workflow', async () => {
    const scope = scopeBoundary();
    const host = { executeAction: (async () => { throw new Error('No launch'); }) as PluginUiHostApi['executeAction'] };
    const controller = createLocalRunControllerV1({ accountId: 'account', host, seed });
    const otherSeed: LocalActRunSeedV1 = { ...seed, target: { kind: 'session', sessionId: 'session-c3' } };
    const unbindOther = bindLocalActFormV1(scope, 'other-session-mount', otherSeed, controller);
    let settled = false;
    const opened = openLocalActFormV1(scope, seed, { openSurface: async () => {} }, new AbortController().signal)
      .then(result => { settled = true; return result; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    const unbind = bindLocalActFormV1(scope, 'requested-session-mount', seed, controller);
    expect(await opened).toEqual({ kind: 'opened', mountId: 'requested-session-mount' });
    unbind(); unbindOther(); controller.dispose();
  });
  it('declares a Project details pane backed by the same forge renderer as the Session pane', () => {
    const views = PLUGIN_MANIFEST.contributes.ui?.views;
    const session = views?.find(view => view.id === 'github-local-act');
    const project = views?.find(view => view.id === 'github-local-act-project');
    expect(project).toMatchObject({ container: 'detailsPane', target: { kind: 'project' }, renderer: 'github-forge-renderer' });
    expect(session).toMatchObject({ renderer: 'github-forge-renderer' });
    expect(PLUGIN_MANIFEST.contributes.ui?.renderers?.find(renderer => renderer.id === project?.renderer))
      .toMatchObject({ kind: 'reactNative', artifact: 'github-forge-native' });
  });
});
