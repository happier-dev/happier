import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { AGENT_IDS } from '@happier-dev/agents';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { buildAgentBackendItems } from './buildAgentBackendItems';

function writeExecutable(dir: string, name: string): string {
    const path = join(dir, name);
    writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return path;
}

/** An environment in which every catalog backend's CLI resolves (single shared executable). */
function allAgentsResolvableEnv(): NodeJS.ProcessEnv {
    const dir = mkdtempSync(join(tmpdir(), 'happier-backend-items-all-'));
    chmodSync(dir, 0o755);
    const executable = writeExecutable(dir, 'cli');
    const env: NodeJS.ProcessEnv = {};
    for (const agentId of AGENT_IDS) {
        env[`HAPPIER_${agentId.toUpperCase()}_PATH`] = executable;
    }
    return env;
}

describe('buildAgentBackendItems', () => {
  it('omits disabled backends by default and reports them disabled when included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-backend-items-disabled-'));
    chmodSync(dir, 0o755);
    const disabledKey = buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'codex' });
    const settings = { backendEnabledByTargetKey: { [disabledKey]: false } };
    const processEnv = {
      HAPPIER_CLAUDE_PATH: writeExecutable(dir, 'claude'),
      HAPPIER_CODEX_PATH: writeExecutable(dir, 'codex'),
    };

    const defaultItems = buildAgentBackendItems({ settings, processEnv });
    expect(defaultItems.find((item) => item.agentId === 'codex')).toBeUndefined();
    expect(defaultItems.find((item) => item.agentId === 'claude')).toEqual(expect.objectContaining({ enabled: true }));

    const includingDisabled = buildAgentBackendItems({ settings, processEnv, includeDisabled: true });
    expect(includingDisabled.find((item) => item.agentId === 'codex')).toEqual(expect.objectContaining({ enabled: false }));
    expect(includingDisabled.find((item) => item.agentId === 'claude')).toEqual(expect.objectContaining({ enabled: true }));
  });

  it('reports every catalog backend enabled when no disable settings exist and every CLI resolves', () => {
    const processEnv = allAgentsResolvableEnv();
    expect(buildAgentBackendItems({ settings: {}, processEnv })).toHaveLength(AGENT_IDS.length);
    expect(buildAgentBackendItems({ settings: undefined, processEnv })).toHaveLength(AGENT_IDS.length);
  });

  it('omits backends whose CLI is not resolvable on this machine', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-backend-items-missing-'));
    chmodSync(dir, 0o755);

    const items = buildAgentBackendItems({
      settings: {},
      processEnv: {
        HAPPIER_CLAUDE_PATH: writeExecutable(dir, 'claude'),
        HAPPIER_CODEX_PATH: '/definitely-missing-happier-codex/codex',
      },
    });

    expect(items.find((item) => item.agentId === 'claude')).toEqual(expect.objectContaining({ enabled: true }));
    expect(items.find((item) => item.agentId === 'codex')).toBeUndefined();
  });
});
