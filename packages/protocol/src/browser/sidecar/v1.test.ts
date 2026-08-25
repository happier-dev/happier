import { describe, expect, it } from 'vitest';

describe('browser sidecar protocol contracts', () => {
  it('parses sidecar runtime status and keeps CDP internals out of the public shape', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const parsed = mod.BrowserSidecarRuntimeStatusV1Schema.parse({
      v: 1,
      sidecarId: 'sidecar_1',
      state: 'running',
      source: 'managedBrowserPackage',
      profileId: 'profile_1',
      boundViewIds: ['view_1'],
      resourcePressure: {
        memoryRssBytes: 100_000_000,
        cpuPercent: 12,
      },
      updatedAtMs: 1_900_000,
    });

    expect(parsed.state).toBe('running');
    expect('debuggerUrl' in parsed).toBe(false);
  });

  it('rejects public sidecar launch results that expose debugger URLs', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserSidecarLaunchResultV1Schema.safeParse({
      v: 1,
      accepted: true,
      sidecarId: 'sidecar_1',
      state: 'running',
      profileBinding: {
        profileId: 'profile_1',
        storageMode: 'ephemeral',
        ownerKind: 'session',
        ownerId: 'session_1',
      },
      debuggerUrl: 'ws://127.0.0.1/devtools/browser/secret',
    });

    expect(result.success).toBe(false);
  });

  it('parses fail-closed launch results for feature and policy gates', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;

    expect(mod.BrowserSidecarLaunchResultV1Schema.parse({
      v: 1,
      accepted: false,
      state: 'unavailable',
      errorCode: 'feature_disabled',
      disabledReason: 'browser.sidecar feature disabled',
    })).toMatchObject({
      accepted: false,
      errorCode: 'feature_disabled',
    });

    // E2-F1 retired `browser_policy_denied`. Its only producer was the `browserUseAllowed`
    // conjunct in `sidecar/productSource.ts`, deleted because it was a second decision-maker for a
    // question the `browser.sidecar` feature bit already owns — that denial is now reported as
    // `feature_disabled` above, from the single fail-close point in `createSidecarLaunchPlan`.
    // The member is rejected rather than merely unused so re-adding a second policy authority
    // cannot pass silently.
    expect(mod.BrowserSidecarLaunchResultV1Schema.safeParse({
      v: 1,
      accepted: false,
      state: 'unavailable',
      errorCode: 'browser_policy_denied',
      disabledReason: 'browser use denied by policy',
    }).success).toBe(false);
  });

  it('accepts a managed binary provenance with pinned version + verified sha256 digest', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod?.BrowserSidecarBinaryProvenanceV1Schema).toBeDefined();
    if (!mod?.BrowserSidecarBinaryProvenanceV1Schema) return;

    const parsed = mod.BrowserSidecarBinaryProvenanceV1Schema.parse({
      origin: 'managed_package',
      pinnedVersion: '127.0.6533.88',
      channel: 'stable',
      integrityDigest: `sha256:${'a'.repeat(64)}`,
      license: 'BSD-3-Clause',
    });

    expect(parsed.origin).toBe('managed_package');
    expect(parsed.pinnedVersion).toBe('127.0.6533.88');
    expect(parsed.channel).toBe('stable');
  });

  it('rejects provenance without a verified sha256 integrity digest', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod?.BrowserSidecarBinaryProvenanceV1Schema).toBeDefined();
    if (!mod?.BrowserSidecarBinaryProvenanceV1Schema) return;

    expect(mod.BrowserSidecarBinaryProvenanceV1Schema.safeParse({
      origin: 'managed_package',
      pinnedVersion: '127.0.6533.88',
      channel: 'stable',
      integrityDigest: 'not-a-digest',
      license: 'BSD-3-Clause',
    }).success).toBe(false);

    expect(mod.BrowserSidecarBinaryProvenanceV1Schema.safeParse({
      origin: 'managed_package',
      pinnedVersion: '',
      channel: 'stable',
      integrityDigest: `sha256:${'a'.repeat(64)}`,
      license: 'BSD-3-Clause',
    }).success).toBe(false);
  });

  it('rejects a non-managed provenance origin (system/floating Chrome stays fail-closed)', async () => {
    const mod = await import('./v1.js').catch(() => null);

    expect(mod?.BrowserSidecarBinaryProvenanceV1Schema).toBeDefined();
    if (!mod?.BrowserSidecarBinaryProvenanceV1Schema) return;

    expect(mod.BrowserSidecarBinaryProvenanceV1Schema.safeParse({
      origin: 'system_path',
      pinnedVersion: '127.0.6533.88',
      channel: 'stable',
      integrityDigest: `sha256:${'a'.repeat(64)}`,
      license: 'BSD-3-Clause',
    }).success).toBe(false);
  });
});
