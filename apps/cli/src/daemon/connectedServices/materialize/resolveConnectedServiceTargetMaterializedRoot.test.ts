import { describe, expect, it } from 'vitest';

import { resolveConnectedServiceTargetMaterializedRoot } from './resolveConnectedServiceTargetMaterializedRoot';

describe('resolveConnectedServiceTargetMaterializedRoot', () => {
  it('prefers the explicit shared target materialized root env when present', () => {
    expect(resolveConnectedServiceTargetMaterializedRoot({
      agentId: 'opencode',
      targetMaterializedEnv: {
        HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT: '/tmp/materialized/shared',
        HAPPIER_OPENCODE_SERVER_STATE_PATH: '/tmp/materialized/ignored/state.json',
      },
    })).toBe('/tmp/materialized/shared');
  });

  it('derives the legacy materialized root when all absolute env values share one parent', () => {
    expect(resolveConnectedServiceTargetMaterializedRoot({
      agentId: 'codex',
      targetMaterializedEnv: {
        CODEX_HOME: '/tmp/materialized/codex-home',
        CODEX_SQLITE_HOME: '/tmp/materialized/state.sqlite',
      },
    })).toBe('/tmp/materialized');
  });

  it('returns null when legacy env values do not identify a unique parent root', () => {
    expect(resolveConnectedServiceTargetMaterializedRoot({
      agentId: 'gemini',
      targetMaterializedEnv: {
        GEMINI_CLI_HOME: '/tmp/materialized-a/home',
        HOME: '/tmp/materialized-b/home',
      },
    })).toBeNull();
  });

  it('returns null for unsupported agents or missing env', () => {
    expect(resolveConnectedServiceTargetMaterializedRoot({
      agentId: 'opencode',
      targetMaterializedEnv: {
        OPENCODE_AUTH_CONTENT: '{}',
      },
    })).toBeNull();
    expect(resolveConnectedServiceTargetMaterializedRoot({
      agentId: 'pi',
      targetMaterializedEnv: null,
    })).toBeNull();
  });
});
