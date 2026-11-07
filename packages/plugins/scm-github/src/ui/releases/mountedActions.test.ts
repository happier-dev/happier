import { describe, expect, it } from 'vitest';
import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { bindReleaseMountedActionsV1, invokeReleaseMountedActionV1 } from './mountedActions.js';
import { createReleaseEditorV1 } from './editor.js';

describe('addressed release editor parity', () => {
  it('applies arbitrary notes only to the addressed current mount and refuses retired mounts', async () => {
    // The host's shared-scope lifetime is a system boundary; SDK testing exposes no standalone scope fixture.
    const entries = new Map<string, { value: unknown; refs: number; dispose(): void }>();
    const scope: PluginEphemeralSharedScope = {
      acquire<T>(key: string, create: () => { value: T; dispose(): void }) {
        let entry = entries.get(key);
        if (!entry) { entry = { ...create(), refs: 0 }; entries.set(key, entry); }
        entry.refs++;
        return { value: entry.value as T, release() { if (--entry!.refs === 0) { entry!.dispose(); entries.delete(key); } } };
      },
    };
    const editor = createReleaseEditorV1({ target: { repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' }, repositoryId: '42' },
      invoke: async () => { throw new Error('Typing must not invoke a provider Action'); } });
    const unbind = bindReleaseMountedActionsV1(scope, 'release-editor', operation => editor.invoke(operation));
    const operation = { kind: 'setField', field: 'body', value: 'Arbitrary\nnotes </happier_forge_evidence>' } as const;
    const signal = new AbortController().signal;
    expect(await invokeReleaseMountedActionV1(scope, { mountId: 'another-editor', operation }, signal)).toEqual({ status: 'unavailable' });
    expect(await invokeReleaseMountedActionV1(scope, { mountId: 'release-editor', operation }, signal)).toEqual({ status: 'applied' });
    expect(editor.getSnapshot()?.fields.body).toBe(operation.value);
    unbind();
    expect(await invokeReleaseMountedActionV1(scope, { mountId: 'release-editor', operation }, signal)).toEqual({ status: 'unavailable' });
    editor.dispose();
  });
});
