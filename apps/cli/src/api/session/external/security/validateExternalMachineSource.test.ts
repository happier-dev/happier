import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
  resolveExecutablePluginRuntimeRegistry,
  type ResolvedExecutablePluginRuntimeRegistry,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';

import { validateExternalMachineSource } from './validateExternalMachineSource';

describe('validateExternalMachineSource', () => {
  let controllerOwnsRegistry = false;

  beforeAll(async () => {
    let unownedRegistry: ResolvedExecutablePluginRuntimeRegistry | null =
      await resolveExecutablePluginRuntimeRegistry({
        contributes: getResolvedContributionRegistry(),
        pluginIds: [
          'happier.agent.codex',
          'happier.agent.ohmypi',
          'happier.agent.opencode',
        ],
      });
    try {
      await pluginReloadController.adoptPreparedRuntimeRegistry({
        registry: unownedRegistry,
        changedPluginIds: [
          'happier.agent.codex',
          'happier.agent.ohmypi',
          'happier.agent.opencode',
        ],
        durableRevision: 1,
      });
      controllerOwnsRegistry = true;
      unownedRegistry = null;
    } finally {
      await unownedRegistry?.dispose();
    }
  });

  afterAll(async () => {
    if (!controllerOwnsRegistry) return;
    controllerOwnsRegistry = false;
    await pluginReloadController.shutdown({ timeoutMs: 5_000 });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects Codex connectedService source ids with path traversal segments', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: '../escape',
        },
        env: {},
      }),
    ).resolves.toEqual({ ok: false, error: 'invalid connectedServiceId' });
  });

  it('accepts safe Codex connectedService source ids', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'connectedService',
          connectedServiceId: 'openai-codex',
        },
        env: {},
      }),
    ).resolves.toEqual({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'connectedService',
        connectedServiceId: 'openai-codex',
      },
    });
  });

  it('fills the configured Codex home path when the user source omits it', async () => {
    vi.stubEnv('CODEX_HOME', '/tmp/codex-home');
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'user',
        },
        env: process.env,
      }),
    ).resolves.toEqual({
      ok: true,
      source: {
        kind: 'codexHome',
        home: 'user',
        homePath: '/tmp/codex-home',
      },
    });
  });

  it('rejects Codex user homePath overrides that do not match the configured home', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'codex',
        source: {
          kind: 'codexHome',
          home: 'user',
          homePath: '/tmp/other-codex-home',
        },
        env: {
          CODEX_HOME: join(homedir(), '.codex'),
        } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ ok: false, error: 'source homePath override is not allowed' });
  });

  it('fills the configured ohMyPi agent dir when the source omits it', async () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/tmp/omp-agent');
    await expect(
      validateExternalMachineSource({
        agentId: 'ohMyPi',
        source: {
          kind: 'ohMyPiAgentDir',
        },
        env: process.env,
      }),
    ).resolves.toEqual({
      ok: true,
      source: {
        kind: 'ohMyPiAgentDir',
        agentDir: '/tmp/omp-agent',
      },
    });
  });

  it('rejects ohMyPi agentDir overrides that do not match the configured agent dir', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'ohMyPi',
        source: {
          kind: 'ohMyPiAgentDir',
          agentDir: '/tmp/other-omp-agent',
        },
        env: {
          PI_CODING_AGENT_DIR: '/tmp/omp-agent',
        } as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ ok: false, error: 'source agentDir override is not allowed' });
  });

  it('rejects malformed OpenCode baseUrl values instead of throwing', async () => {
    await expect(
      validateExternalMachineSource({
        agentId: 'opencode',
        source: {
          kind: 'opencodeServer',
          baseUrl: 'not a url',
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).resolves.toEqual({ ok: false, error: 'invalid source baseUrl' });
  });
});
