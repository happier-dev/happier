import { describe, expect, it } from 'vitest';

import { deriveTriageDetailMountInstanceKey } from './mountKey.js';

/**
 * The ceiling is owned by `protocol/src/plugins/ui/semanticCommands.ts:77`
 * (`PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES_V1`) and enforced by
 * `PluginUiInstanceKeyV1Schema`. It is a private package this plugin cannot
 * import, so the value is pinned here with its owner named. A key over the
 * ceiling does not throw: `TargetedPluginSurfaceHost.tsx` returns null on the
 * failed parse and the reader gets a generic "detail view unavailable" card that
 * reads as a Happier fault.
 */
const PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES = 256;

const utf8 = (value: string): number => new TextEncoder().encode(value).byteLength;

const INSTANCE_ID = '0'.repeat(36);

function entryRef(overrides: Partial<{ kindId: string; collisionScope: string; entryId: string }> = {}) {
  return {
    source: { pluginId: 'happier.scm.forge.azure-devops', localId: 'azure-devops-forge' },
    kindId: overrides.kindId ?? 'pull-request',
    collisionScope: overrides.collisionScope ?? 'contoso/DefaultCollection/project',
    entryId: overrides.entryId ?? '5',
  } as Parameters<typeof deriveTriageDetailMountInstanceKey>[0];
}

describe('the detail mount instance key', () => {
  it('stays under the host ceiling for a contract-legal entry reference', () => {
    // A self-hosted Azure DevOps Server collection base is ordinary and long:
    // `scm-azure-devops/src/triage/identity.ts` notes a Server collection reaches
    // lengths a dev.azure.com one never does. These are the protocol maxima:
    // MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1 = 192, identifiers = 128.
    const key = deriveTriageDetailMountInstanceKey(
      entryRef({ collisionScope: 'c'.repeat(192), kindId: 'k'.repeat(128), entryId: 'e'.repeat(128) }),
      INSTANCE_ID,
    );
    expect(utf8(key)).toBeLessThanOrEqual(PLUGIN_UI_INSTANCE_KEY_MAX_UTF8_BYTES);
  });

  it('separates entries that differ only by kind', () => {
    // GitLab issue #5 and merge request !5 in one project. This is the collision
    // the key exists to prevent; a bound that lost it would be worse than the
    // overflow it fixes.
    expect(deriveTriageDetailMountInstanceKey(entryRef({ kindId: 'issue' }), INSTANCE_ID))
      .not.toBe(deriveTriageDetailMountInstanceKey(entryRef({ kindId: 'merge-request' }), INSTANCE_ID));
  });

  it('separates the same entry observed through two connections', () => {
    expect(deriveTriageDetailMountInstanceKey(entryRef(), '1'.repeat(36)))
      .not.toBe(deriveTriageDetailMountInstanceKey(entryRef(), '2'.repeat(36)));
  });

  it('separates entries that differ only by collision scope', () => {
    expect(deriveTriageDetailMountInstanceKey(entryRef({ collisionScope: 'a/one' }), INSTANCE_ID))
      .not.toBe(deriveTriageDetailMountInstanceKey(entryRef({ collisionScope: 'a/two' }), INSTANCE_ID));
  });

  it('is stable for one entry so a refresh does not remount the source body', () => {
    expect(deriveTriageDetailMountInstanceKey(entryRef(), INSTANCE_ID))
      .toBe(deriveTriageDetailMountInstanceKey(entryRef(), INSTANCE_ID));
  });
});
