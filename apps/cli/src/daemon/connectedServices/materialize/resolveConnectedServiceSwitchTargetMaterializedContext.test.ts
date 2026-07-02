import { describe, expect, it } from 'vitest';

import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../connectedServiceChildEnvironment';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';
import { resolveConnectedServiceSwitchTargetMaterializedContext } from './resolveConnectedServiceSwitchTargetMaterializedContext';

describe('resolveConnectedServiceSwitchTargetMaterializedContext', () => {
  it('keeps an inherited connected materialized root unchanged', () => {
    const result = resolveConnectedServiceSwitchTargetMaterializedContext({
      agentId: 'pi',
      baseDir: '/tmp/connected-services',
      inheritedEnv: {
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: '/tmp/already-materialized/pi',
      },
      effectiveIdentity: { v: 1, id: 'csm_pi', createdAt: 1, source: 'first_spawn' },
    });

    expect(result).toEqual({
      targetMaterializedEnv: {
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: '/tmp/already-materialized/pi',
      },
      targetMaterializedRoot: '/tmp/already-materialized/pi',
    });
  });

  it('reconstructs the deterministic target root when a tracked env has no materialized root', () => {
    const baseDir = '/tmp/connected-services';
    const expectedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir,
      agentId: 'pi',
      materializationKey: 'csm_pi',
    });

    const result = resolveConnectedServiceSwitchTargetMaterializedContext({
      agentId: 'pi',
      baseDir,
      inheritedEnv: { UNRELATED: '1' },
      effectiveIdentity: { v: 1, id: 'csm_pi', createdAt: 1, source: 'first_spawn' },
    });

    expect(result).toEqual({
      targetMaterializedEnv: {
        UNRELATED: '1',
        [HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]: expectedRoot,
      },
      targetMaterializedRoot: expectedRoot,
    });
  });

  it('fails closed when no root can be inherited or reconstructed', () => {
    expect(resolveConnectedServiceSwitchTargetMaterializedContext({
      agentId: 'pi',
      baseDir: '/tmp/connected-services',
      inheritedEnv: null,
      effectiveIdentity: null,
    })).toEqual({
      targetMaterializedEnv: null,
      targetMaterializedRoot: null,
    });
  });
});
