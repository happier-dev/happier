import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  derivePluginDaemonContributionRegistrationRights,
  ingestPluginManifestV2,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST } from './manifest.js';

describe('Kimi plugin manifest', () => {
  it('declares the Kimi runtime with ACP continuation support', () => {
    const result = ingestPluginManifestV2(PLUGIN_MANIFEST);
    expect(result).toMatchObject({ ok: true });
    expect(ingestPluginManifestV2(JSON.stringify(PLUGIN_MANIFEST))).toEqual(result);
    expect(PLUGIN_MANIFEST).toHaveProperty('entrypoints.daemon', './.happier-plugin/daemon.js');
    expect(PLUGIN_MANIFEST.contributes.agents).toEqual([
      expect.objectContaining({
        id: 'kimi',
        runtime: { kind: 'custom' },
        primary: 'sessions',
        capabilities: expect.objectContaining({
          surfaces: ['terminal', 'externalSessions'],
          sessions: expect.objectContaining({
            open: ['create', 'resume', 'fork'],
            delivery: ['newTurn', 'followUp'],
            cancel: true,
            configuration: true,
          }),
          tools: { delivery: 'native_mcp' },
        }),
      }),
    ]);
  });

  it('declares one native history source for the custom ACP runtime', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents[0];
    expect(agent.capabilities.surfaces).toContain('externalSessions');
    expect(agent.surfaces?.externalSession).toEqual({
      externalLinkedTakeover: { writerSafety: 'unsupported' },
      sources: [{
        sourceKind: 'kimiCodeHome',
        contentSearch: true,
        schema: { fields: [
          { kind: 'literal', name: 'kind', value: 'kimiCodeHome' },
          { kind: 'string', name: 'homeDir', nullish: true },
        ] },
        key: { segments: [{ kind: 'literal', value: 'kimiCodeHome' }] },
        instances: [{ kind: 'default', constants: {} }],
      }],
    });
    expect(agent).toMatchObject({ primary: 'sessions', runtime: { kind: 'custom' } });
    expect(agent.capabilities.sessions?.open).toContain('resume');
  });

  it('requires its plugin-authored native reader registration', () => {
    expect(derivePluginDaemonContributionRegistrationRights(
      PLUGIN_MANIFEST.contributes as unknown as Readonly<Record<string, unknown>>,
    )).toContainEqual(expect.objectContaining({
      family: 'agents',
      localId: 'kimi',
      requiredFields: expect.arrayContaining(['factory', 'externalSessions']),
    }));
  });

  it('declares the custom runtime entrypoint without legacy Python settings', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents[0];
    expect(agent.runtime).toEqual({ kind: 'custom' });
    expect(agent).not.toHaveProperty('cliSessionCommand');
    expect(PLUGIN_MANIFEST.contributes).not.toHaveProperty('hooks');
    expect(PLUGIN_MANIFEST.contributes.settings ?? []).toEqual([]);
    expect(PLUGIN_MANIFEST.hostAccess.required).toContainEqual(expect.objectContaining({
      id: 'kimi-process',
      capability: 'process',
      scope: { executables: [{ kind: 'systemTool', id: 'kimi-cli' }] },
    }));
  });

  it('installs and authenticates through the current Kimi Code vendor contract', () => {
    const agent = PLUGIN_MANIFEST.contributes.agents[0];
    expect(agent?.cli).toMatchObject({
      displayName: 'Kimi Code CLI',
      executable: { binaryName: 'kimi', sourcePreference: 'system-first' },
      install: {
        managed: null,
        guideUrl: 'https://moonshotai.github.io/kimi-code/docs/en/reference/kimi-command.html',
        docsUrl: 'https://moonshotai.github.io/kimi-code/',
      },
      auth: {
        support: 'login_terminal',
        loginLaunches: [{ kind: 'primary', args: ['login'] }],
      },
    });
    expect(JSON.stringify(agent?.cli?.install)).toContain('code.kimi.com/kimi-code/install.sh');
    expect(JSON.stringify(agent?.cli?.install)).toContain('code.kimi.com/kimi-code/install.ps1');
  });

  it('resolves only the current Kimi Code executable', () => {
    // The retired Python `kimi-cli` binary must not be launchable as Kimi Code:
    // it negotiates a different ACP capability set, so resolving it would give a
    // session that fails one control at a time instead of an obviously wrong
    // install. `kimi-cli` remains only a session flavor alias.
    const systemTool = PLUGIN_MANIFEST.contributes.systemTools
      .find((tool) => tool.id === 'kimi-cli');
    expect(systemTool?.executableNames).toEqual(['kimi']);
    expect(PLUGIN_MANIFEST.contributes.agents[0]?.cli?.executable)
      .toMatchObject({ systemCommandResolutionStrategy: 'path-first' });
  });

  it('declares capability-based readiness so selection never orders by semver', () => {
    // Retired `kimi-cli` releases sort above current Kimi Code releases, and a
    // legacy install may own the `kimi` name while answering `kimi acp` without
    // the `migrate` command surface. The readiness declaration below is the
    // provider-owned data the generic system-tool resolution owner consumes:
    // fingerprints plus command surface decide, versions are never read.
    const systemTool = PLUGIN_MANIFEST.contributes.systemTools
      .find((tool) => tool.id === 'kimi-cli');
    expect(systemTool?.readiness).toMatchObject({
      acpProbeArgs: ['acp'],
      currentFingerprint: {
        loadSession: true,
        sessionCapabilities: ['list', 'resume', 'close', 'delete', 'fork'],
        mcpHttp: true,
        mcpSse: true,
      },
      legacyFingerprint: {
        loadSession: true,
        sessionCapabilities: ['list', 'resume'],
        absentSessionCapabilities: ['close', 'delete', 'fork'],
        mcpHttp: true,
        mcpSse: false,
      },
      commandSurfaceArgs: ['migrate', '--help'],
      legacyExecutableNames: ['kimi-cli'],
    });
    expect(systemTool?.readiness?.legacyGuidance).toContain('kimi migrate');
    expect(systemTool?.readiness).not.toHaveProperty('minimumVersion');
  });

  /**
   * `.happier-plugin/plugin.json` is the artifact the host actually ingests.
   * Asserting only `PLUGIN_MANIFEST` let a stale generated copy keep shipping
   * `tools.delivery: 'shell_bridge'` long after the source declared native MCP.
   */
  it('publishes the declared MCP delivery and executable set in the ingested artifact', async () => {
    const published = JSON.parse(await readFile(
      fileURLToPath(new URL('../.happier-plugin/plugin.json', import.meta.url)),
      'utf8',
    )) as {
      contributes?: {
        agents?: readonly {
          runtime?: { kind?: string };
          capabilities?: { tools?: { delivery?: string } };
        }[];
        systemTools?: readonly { id?: string; executableNames?: readonly string[] }[];
      };
    };

    const publishedAgent = published.contributes?.agents?.[0];
    // Kimi delivers Happier tools as native ACP MCP servers. A stale artifact
    // kept claiming `shell_bridge` here, which is what the host would have
    // acted on, so this asserts the shipped bytes rather than the source object.
    expect(publishedAgent?.capabilities?.tools?.delivery).toBe('native_mcp');
    expect(publishedAgent?.capabilities?.tools?.delivery)
      .toBe(PLUGIN_MANIFEST.contributes.agents[0]?.capabilities?.tools?.delivery);
    expect(publishedAgent?.runtime?.kind).toBe('custom');
    expect(published.contributes?.systemTools?.find((tool) => tool.id === 'kimi-cli')?.executableNames)
      .toEqual(['kimi']);
  });
});
