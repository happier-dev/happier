import { describe, expect, it } from 'vitest';

import { AgentDefinitionV1Schema } from '../agentDefinitionV1.js';
import { ingestPluginManifestV2 } from '../manifest/ingest.js';
import { isPluginAgentCliAuthBackgroundCheckSafe } from './agentCliMetadata.js';
import { PluginAgentContributionV2Schema } from './v2.js';

function nativeAgent(cli: unknown) {
  return {
    id: 'grok',
    title: 'Grok',
    runtime: { kind: 'custom' },
    primary: 'sessions',
    capabilities: {
      sessions: {
        open: ['create'],
        delivery: ['newTurn'],
        cancel: true,
      },
    },
    cli,
  };
}

function validCliMetadata() {
  return {
    executable: {
      binaryName: 'grok',
      alternativeBinaryNames: ['grok-cli'],
      knownUserBinDirSuffixes: ['.grok/bin', '.local/bin'],
      sourcePreference: 'system-first',
      acceptsJavaScriptFileOverride: false,
    },
    install: {
      managed: null,
      manual: {
        kind: 'vendor_recipe',
        recipes: {
          darwin: [{ cmd: 'brew', args: ['install', 'grok'] }],
          linux: [{ cmd: 'sh', args: ['-c', 'install-grok'] }],
          win32: [{ cmd: 'winget', args: ['install', 'grok'] }],
        },
      },
      guideUrl: 'https://x.ai/cli',
      docsUrl: 'https://docs.x.ai/cli',
    },
    auth: {
      support: 'login_terminal',
      environmentVariables: ['XAI_API_KEY'],
      missingCredentialState: 'unknown',
      loginLaunches: [
        { kind: 'primary', args: ['login'] },
        { kind: 'device_code', args: ['login', '--device-auth'] },
      ],
    },
  };
}

describe('native Agent CLI/auth metadata', () => {
  it('accepts one strict provider-neutral executable, install, auth, and login block', () => {
    const parsed = PluginAgentContributionV2Schema.parse(nativeAgent(validCliMetadata()));

    expect(parsed.cli).toEqual(validCliMetadata());
  });

  it('rejects retired host-owned auth parser metadata', () => {
    const cli = validCliMetadata();
    expect(PluginAgentContributionV2Schema.safeParse(nativeAgent({
      ...cli,
      auth: {
        ...cli.auth,
        probe: { parser: 'unknown', backgroundChecks: 'safe' },
      },
    })).success).toBe(false);
  });

  it('derives background-safe auth only from declared static facts or an explicit noninteractive probe', () => {
    const cli = validCliMetadata();
    const staticCredential = PluginAgentContributionV2Schema.parse(nativeAgent(cli)).cli;
    if (!staticCredential) throw new Error('Expected CLI metadata');

    expect(isPluginAgentCliAuthBackgroundCheckSafe(staticCredential)).toBe(true);
    expect(isPluginAgentCliAuthBackgroundCheckSafe({ auth: { environmentVariables: [] } })).toBe(false);
    expect(isPluginAgentCliAuthBackgroundCheckSafe({ auth: { credentialPaths: [] } })).toBe(false);

    const noninteractiveProbe = PluginAgentContributionV2Schema.parse(nativeAgent({
      ...cli,
      auth: {
        support: 'status_only',
        nonInteractiveStatusProbe: true,
        loginLaunches: [],
      },
    })).cli;
    if (!noninteractiveProbe) throw new Error('Expected CLI metadata');
    expect(isPluginAgentCliAuthBackgroundCheckSafe(noninteractiveProbe)).toBe(true);

    const manualOnly = PluginAgentContributionV2Schema.parse(nativeAgent({
      ...cli,
      auth: {
        support: 'status_only',
        loginLaunches: [],
      },
    })).cli;
    if (!manualOnly) throw new Error('Expected CLI metadata');
    expect(isPluginAgentCliAuthBackgroundCheckSafe(manualOnly)).toBe(false);
  });

  it('preserves bounded first-party resolver, setup, and machine-login compatibility facts', () => {
    const cli = validCliMetadata();
    const parsed = PluginAgentContributionV2Schema.parse(nativeAgent({
      ...cli,
      displayName: 'Acme CLI',
      executable: {
        ...cli.executable,
        alternativeBinaryFallbackEnabledEnvVar: 'HAPPIER_ACME_FALLBACK_ENABLED',
        knownUserBinDirSuffixes: null,
      },
      install: {
        ...cli.install,
        manual: { kind: 'command' },
        recommendationOrder: 20,
      },
      auth: {
        ...cli.auth,
        machineLoginKey: 'acme-code',
      },
    }));

    expect(parsed.cli).toMatchObject({
      displayName: 'Acme CLI',
      executable: {
        alternativeBinaryFallbackEnabledEnvVar: 'HAPPIER_ACME_FALLBACK_ENABLED',
        knownUserBinDirSuffixes: null,
      },
      install: {
        manual: { kind: 'command' },
        recommendationOrder: 20,
      },
      auth: {
        machineLoginKey: 'acme-code',
      },
    });
  });

  it('accepts bounded GitHub release extraction limits and rejects unsafe declarations', () => {
    const cli = validCliMetadata();
    const managed = {
      kind: 'github_release_binary' as const,
      githubRepo: 'openai/codex',
      binaryName: 'codex',
      assetNameByPlatform: {
        darwin: { arm64: 'codex-package-aarch64-apple-darwin.tar.gz', x64: 'codex-package-x86_64-apple-darwin.tar.gz' },
        linux: { arm64: 'codex-package-aarch64-unknown-linux-musl.tar.gz', x64: 'codex-package-x86_64-unknown-linux-musl.tar.gz' },
        win32: { arm64: 'codex-package-aarch64-pc-windows-msvc.tar.gz', x64: 'codex-package-x86_64-pc-windows-msvc.tar.gz' },
      },
      archiveEntriesByPlatform: {
        darwin: [{ archivePath: 'bin/codex', destinationPath: 'bin/codex' }],
        linux: [{ archivePath: 'bin/codex', destinationPath: 'bin/codex' }],
        win32: [{ archivePath: 'bin/codex.exe', destinationPath: 'bin/codex.exe' }],
      },
      archiveExtractionLimits: {
        maxFileBytes: 384 * 1024 * 1024,
        maxExpandedBytes: 384 * 1024 * 1024,
      },
    };
    const candidate = nativeAgent({
      ...cli,
      install: { ...cli.install, managed },
    });

    expect(PluginAgentContributionV2Schema.parse(candidate).cli?.install.managed).toEqual(managed);
    expect(PluginAgentContributionV2Schema.safeParse(nativeAgent({
      ...cli,
      install: {
        ...cli.install,
        managed: {
          ...managed,
          archiveExtractionLimits: {
            maxFileBytes: 384 * 1024 * 1024,
            maxExpandedBytes: (384 * 1024 * 1024) - 1,
          },
        },
      },
    })).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse(nativeAgent({
      ...cli,
      install: {
        ...cli.install,
        managed: {
          ...managed,
          archiveExtractionLimits: {
            maxFileBytes: (512 * 1024 * 1024) + 1,
            maxExpandedBytes: (512 * 1024 * 1024) + 1,
          },
        },
      },
    })).success).toBe(false);
  });

  it('preserves managed GitHub archive declarations through full manifest ingestion', () => {
    const cli = validCliMetadata();
    const managed = {
      kind: 'github_release_binary' as const,
      githubRepo: 'openai/codex',
      binaryName: 'codex',
      assetNameByPlatform: {
        darwin: { arm64: 'codex-package-aarch64-apple-darwin.tar.gz', x64: 'codex-package-x86_64-apple-darwin.tar.gz' },
        linux: { arm64: 'codex-package-aarch64-unknown-linux-musl.tar.gz', x64: 'codex-package-x86_64-unknown-linux-musl.tar.gz' },
        win32: { arm64: 'codex-package-aarch64-pc-windows-msvc.tar.gz', x64: 'codex-package-x86_64-pc-windows-msvc.tar.gz' },
      },
      archiveEntriesByPlatform: {
        darwin: [{ archivePath: 'bin/codex', destinationPath: 'bin/codex' }],
        linux: [{ archivePath: 'bin/codex', destinationPath: 'bin/codex' }],
        win32: [{ archivePath: 'bin/codex.exe', destinationPath: 'bin/codex.exe' }],
      },
      archiveExtractionLimits: { maxFileBytes: 1024, maxExpandedBytes: 2048 },
    };
    const result = ingestPluginManifestV2({
      schemaVersion: 2,
      id: 'com.acme.fixture',
      version: '1.0.0',
      displayName: 'Fixture',
      engines: { happier: '^1.0.0' },
      runtime: { apiVersion: 1 },
      entrypoints: { daemon: './dist/plugin.js' },
      hostAccess: { required: [], optional: [] },
      contributes: {
        agents: [nativeAgent({ ...cli, install: { ...cli.install, managed } })],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.contributes.agents?.[0]?.cli?.install.managed).toEqual(managed);
  });

  it('rejects unknown fields and plugin-authored login commands', () => {
    const cli = validCliMetadata();
    expect(PluginAgentContributionV2Schema.safeParse(nativeAgent({
      ...cli,
      executable: { ...cli.executable, unknownResolutionPolicy: true },
    })).success).toBe(false);
    expect(PluginAgentContributionV2Schema.safeParse(nativeAgent({
      ...cli,
      auth: {
        ...cli.auth,
        loginLaunches: [{ kind: 'primary', command: '/tmp/grok', args: ['login'] }],
      },
    })).success).toBe(false);
  });

  it('rejects duplicate ordered login kinds', () => {
    const cli = validCliMetadata();
    expect(PluginAgentContributionV2Schema.safeParse(nativeAgent({
      ...cli,
      auth: {
        ...cli.auth,
        loginLaunches: [
          { kind: 'primary', args: ['login'] },
          { kind: 'primary', args: ['auth', 'login'] },
        ],
      },
    })).success).toBe(false);
  });

  it('rejects login-terminal metadata without a primary launch', () => {
    const cli = validCliMetadata();
    expect(PluginAgentContributionV2Schema.safeParse(nativeAgent({
      ...cli,
      auth: {
        ...cli.auth,
        loginLaunches: [{ kind: 'device_code', args: ['login', '--device-auth'] }],
      },
    })).success).toBe(false);
  });

  it('rejects legacy-only agentCliRuntime authoring', () => {
    expect(PluginAgentContributionV2Schema.safeParse({
      ...nativeAgent(validCliMetadata()),
      agentCliRuntime: {
        binaryName: 'grok',
        sourcePreferenceDefault: 'system-first',
      },
    }).success).toBe(false);
  });

  it('rejects legacy AgentDefinitionV1 CLI runtime authoring', () => {
    expect(AgentDefinitionV1Schema.safeParse({
      id: 'grok',
      display: {
        name: 'Grok',
        tags: [],
      },
      ownedBackendIds: [],
      agentCliRuntime: {
        id: 'grok',
        title: 'Grok',
        binaryName: 'grok',
        sourcePreferenceDefault: 'system-first',
        managedInstall: null,
        manualInstallKind: 'none',
        manualInstallRecipes: null,
        acceptsJavaScriptFileOverride: false,
      },
    }).success).toBe(false);
  });
});
