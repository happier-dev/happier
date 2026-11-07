import { describe, expect, it } from 'vitest';
import type { PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { createForgeCiMountedViewV1 } from '@happier-dev/forge-ci/ui';
import { bindGithubCiMountedViewV1, invokeGithubCiMountedViewV1 } from './mounted.js';

// The host-owned sharing boundary; the real CI model and dispatcher run beneath it.
function sharing(): PluginEphemeralSharedScope {
  const values = new Map<string, unknown>();
  return { acquire<T>(key: string, create: () => { value: T; dispose(): void }) {
    if (!values.has(key)) values.set(key, create().value);
    return { value: values.get(key) as T, release() {} };
  } };
}
describe('CI mounted Action binding', () => {
  it('reaches the exact shared model and retracts its callback when unmounted', async () => {
    const scope = sharing();
    const view = createForgeCiMountedViewV1({ mountId: 'ci', phone: false });
    const input = { mountId: 'ci', operation: { kind: 'setTimestampsVisible', visible: false } } as const;
    expect(await invokeGithubCiMountedViewV1(scope, input, new AbortController().signal)).toEqual({ status: 'unavailable' });
    const release = bindGithubCiMountedViewV1(scope, view);
    expect(await invokeGithubCiMountedViewV1(scope, input, new AbortController().signal)).toEqual({ status: 'applied' });
    expect(view.getSnapshot()?.timestampsVisible).toBe(false);
    release();
    expect(await invokeGithubCiMountedViewV1(scope, input, new AbortController().signal)).toEqual({ status: 'unavailable' });
  });
});
