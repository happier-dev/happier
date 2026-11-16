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
  it('adapts the admitted source-neutral PR request to the existing mounted form without executing a job', async () => {
    const scope = scopeBoundary();
    const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
    const cause = { repository, workflowPath: '.github/workflows/test.yml', sourceHeadSha: 'a'.repeat(40) };
    const expectedSeed = { ...seed, workflowPath: cause.workflowPath, sourceHeadSha: cause.sourceHeadSha };
    const host = { version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: [] }), notify: async () => undefined,
      presentActionFailure: async () => undefined,
      executeAction: (async () => { throw new Error('Opening must not execute'); }) as PluginUiHostApi['executeAction'] };
    const controller = createLocalRunControllerV1({ accountId: 'account', host, seed: expectedSeed });
    let unbind = () => {};
    try {
      const input = LocalActRunFormInputV1Schema.parse({ operation: { kind: 'openPullRequest',
        session: { serverId: 'home', sessionId: seed.target.sessionId },
        acceptedWorkspace: { repository, checkout: seed.workspace }, pullRequestUrl: 'https://github.com/acme/widgets/pull/7', cause } });
      await expect(executeLocalActFormIntentV1(input, { ephemeralSharedScope: scope, signal: new AbortController().signal,
        ui: { openSurface: async (view, launch) => {
          expect(view).toEqual({ pluginId: PLUGIN_MANIFEST.id, localId: 'github-local-act' });
          expect(launch).toEqual({ seed: expectedSeed });
          unbind = bindLocalActFormV1(scope, 'source-neutral-mount', expectedSeed, controller);
        } },
      })).resolves.toEqual({ kind: 'opened', mountId: 'source-neutral-mount' });
      for (const bad of [
        { ...input, operation: { ...input.operation, pullRequestUrl: 'https://github.com/acme/other/pull/7' } },
        { ...input, operation: { ...input.operation, cause: { ...cause, repository: { ...repository, repository: 'acme/other' } } } },
      ]) await expect(executeLocalActFormIntentV1(LocalActRunFormInputV1Schema.parse(bad), {
        ephemeralSharedScope: scope, signal: new AbortController().signal,
        ui: { openSurface: async () => { throw new Error('Mismatched repository must not open'); } },
      })).resolves.toEqual({ kind: 'unavailable' });
    } finally { unbind(); controller.dispose(); }
  });
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
    const host = { version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: [] }), notify: async () => undefined, executeAction: (async () => { effects++; throw new Error('No execution during form intents'); }) as PluginUiHostApi['executeAction'] };
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
    const host = { version: () => ({ apiVersion: '1.0.0', wireVersion: 1, methods: [] }), notify: async () => undefined, executeAction: (async () => { throw new Error('No launch'); }) as PluginUiHostApi['executeAction'] };
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
