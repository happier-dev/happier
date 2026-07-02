import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';

describe('resolveConnectedServiceMaterializedRootDir', () => {
  it('derives the deterministic root the spawn path uses: <baseDir>/<sha256(materializationKey)>/<agentId>', () => {
    // This MUST match materializeConnectedServicesForSpawn, which roots at
    // normalizeMaterializationKeyForPath(materializationKey) (= sha256 of the key) so the inactive-switch
    // reconstruction is byte-identical to what the next spawn materializes into.
    const key = 'csm_1700000000000_abcd';
    const expectedSegment = createHash('sha256').update(key, 'utf8').digest('hex');
    expect(resolveConnectedServiceMaterializedRootDir({
      baseDir: '/home/user/.happier/daemon/connected-services/materialized',
      agentId: 'pi',
      materializationKey: key,
    })).toBe(join('/home/user/.happier/daemon/connected-services/materialized', expectedSegment, 'pi'));
  });

  it('places a different agentId under the same segment as a sibling', () => {
    const key = 'session-123';
    const segment = createHash('sha256').update(key, 'utf8').digest('hex');
    expect(resolveConnectedServiceMaterializedRootDir({
      baseDir: '/base',
      agentId: 'codex',
      materializationKey: key,
    })).toBe(join('/base', segment, 'codex'));
  });
});
