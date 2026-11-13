import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ socketPath: '' }));
// Only Herdr's OS session-list transport is substituted. Version probing, the
// real socket client, host adapter, launch-spec producer and Agent parser run.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(actual.execFile);
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const command = args[0];
      if (command === 'tmux' || /(?:^|[/\\])zellij(?:\.exe)?$/.test(command)) {
        // Availability of unrelated terminal hosts is an OS boundary, not a
        // dependency on the developer's live tmux server or bundled Zellij.
        return actual.spawn(process.execPath, ['--version'], args[2]);
      }
      return actual.spawn(...args);
    },
    execFile: Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
      [Symbol.for('nodejs.util.promisify.custom')]: async (file: string, args: string[], options: object) => {
        if (file === process.execPath && args.join(' ') === 'session list --json') {
          return { stdout: JSON.stringify({ sessions: [{ name: 'work terminals', socket_path: boundary.socketPath, running: true }] }), stderr: '' };
        }
        return await execFileAsync(file, args, options);
      },
    }),
  };
});

import { resolveCodexCliSessionExtraOptions } from '@happier-dev/plugins-codex/agent/cli/command';
import { buildAgentCliSessionCommandBuildInput, partitionProviderSessionArgs } from '@/cli/providerSessionArgPartition';
import { isSupportedHerdrVersion } from '@/integrations/herdr/runtimeBinary';
import { withHerdrApi } from '@/integrations/herdr/herdrApi.testkit';
import { withTempDir } from '@/testkit/fs/tempDir';
import { parseProcessOwnerTag } from '@/processes/ownerTag';

import { spawnAdapterHostedSessionAndWaitForWebhook } from './spawnAdapterHostedSessionAndWaitForWebhook';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('daemon-hosted executable Agent command', () => {
  it.skipIf(process.platform === 'win32').each(['installation_unavailable', 'server_version_unsupported'] as const)('publishes a bounded %s detail from the real host producer', async (reason) => {
    await withTempDir('happier-hosted-refusal-', async (home) => {
      vi.stubEnv('HERDR_BIN_PATH', reason === 'installation_unavailable' ? join(home, 'absent-herdr') : process.execPath);
      vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', fileURLToPath(new URL('../../index.ts', import.meta.url)));
      await withHerdrApi(async (api) => {
        boundary.socketPath = api.socketPath;
        api.setServerVersion('0.9.1');
        const result = await spawnAdapterHostedSessionAndWaitForWebhook({
          terminalRequest: { requested: 'herdr', herdr: { sessionName: 'work terminals' } },
          directory: home, trackedSpawnOptions: { directory: home }, normalizedExistingSessionId: 'session-hosted-command', effectiveResume: '',
          effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
          sessionControlArgs: [], directoryCreated: false, extraEnvForChildWithMessage: {}, processEnv: process.env, happyHomeDir: home,
          trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(), spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
          onChildExited: () => {},
          spawnLifecycleCallbacks: {
            registerConnectedServiceSpawnTarget: () => {}, registerSpawnResourceCleanupForSession: () => {},
            consumeSessionAttachCleanupForSession: () => {}, cleanupPendingSessionAttach: async () => {},
            persistAcceptedSpawnMarker: async () => { throw new Error('Host refused before webhook custody'); },
            removeAcceptedSpawnMarkerIfOwned: async () => true,
          },
          cleanupSpawnResources: () => {}, logDebug: () => {}, warn: () => {},
          onUntrackedHostedChild: () => {},
        });
        expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED',
          errorDetail: { kind: 'terminal_host_unavailable', host: 'herdr', reason } });
        expect(api.requests.some((request) => request.method === 'layout.apply')).toBe(false);
        expect(api.panes.size).toBe(0);
      });
    });
  });
  it.skipIf(process.platform === 'win32').each(['existing', 'fresh'] as const)('produces a %s Codex command accepted by the actual public Agent parser', async (sessionKind) => {
    // The genuine harmless version command supplies a stable semver banner.
    expect(isSupportedHerdrVersion(process.version)).toBe(true);
    vi.stubEnv('HERDR_BIN_PATH', process.execPath);
    vi.stubEnv('HAPPIER_CLI_SUBPROCESS_ENTRYPOINT', fileURLToPath(new URL('../../index.ts', import.meta.url)));
    await withTempDir('happier-hosted-command-', async (home) => {
      await withHerdrApi(async (api) => {
        boundary.socketPath = api.socketPath;
        let runnerArgs: string[] | undefined;
        let runnerOwnerTag: string | undefined;
        api.beforeResponse.set('layout.apply', () => {
          const request = api.requests.at(-1);
          const root = request?.params.root;
          if (!root || typeof root !== 'object' || !('command' in root) || !Array.isArray(root.command)) {
            throw new Error('Missing real terminal launch command');
          }
          const specPath: unknown = root.command[2];
          if (typeof specPath !== 'string') throw new Error('Missing private terminal launch spec');
          const spec: unknown = JSON.parse(readFileSync(specPath, 'utf8'));
          if (!spec || typeof spec !== 'object' || !('args' in spec) || !Array.isArray(spec.args)
            || !spec.args.every((value): value is string => typeof value === 'string')) {
            throw new Error('Invalid terminal launch spec args');
          }
          runnerArgs = spec.args;
          if ('env' in spec && typeof spec.env === 'object' && spec.env !== null
            && 'HAPPIER_PROCESS_OWNER' in spec.env && typeof spec.env.HAPPIER_PROCESS_OWNER === 'string') {
            runnerOwnerTag = spec.env.HAPPIER_PROCESS_OWNER;
          }
        });
        // Retire the submitted pane/spec without pretending a provider runner
        // or session webhook exists. This case decides executable CLI admission.
        api.faults.set('pane.get', 'error');
        const result = await spawnAdapterHostedSessionAndWaitForWebhook({
          terminalRequest: { requested: 'herdr', herdr: { sessionName: 'work terminals' } },
          directory: home,
          trackedSpawnOptions: { directory: home },
          normalizedExistingSessionId: sessionKind === 'existing' ? 'session-hosted-command' : '', effectiveResume: '',
          effectiveBackendTargetV2: { kind: 'backend', sourceKind: 'built_in', backendId: 'codex' },
          sessionControlArgs: [], directoryCreated: false,
          extraEnvForChildWithMessage: { HAPPIER_PROCESS_OWNER: 'forged-host-owner' },
          unsetEnvKeys: ['HAPPIER_PROCESS_OWNER'], processEnv: process.env, happyHomeDir: home,
          trackedSessionsByKey: new Map(), spawnAwaiterByKey: new Map(),
          spawnResultResolverByKey: new Map(), spawnWebhookTimeoutByKey: new Map(),
          onChildExited: () => {},
          spawnLifecycleCallbacks: {
            registerConnectedServiceSpawnTarget: () => {}, registerSpawnResourceCleanupForSession: () => {},
            consumeSessionAttachCleanupForSession: () => {}, cleanupPendingSessionAttach: async () => {},
            persistAcceptedSpawnMarker: async () => { throw new Error('Pane inspection failed before webhook custody'); },
            removeAcceptedSpawnMarkerIfOwned: async () => true,
          },
          cleanupSpawnResources: () => {}, logDebug: () => {}, warn: () => {},
          onUntrackedHostedChild: () => {},
        });
        expect(result).toMatchObject({ type: 'error', errorCode: 'SPAWN_FAILED' });
        expect(api.panes.size).toBe(0);
        if (sessionKind === 'existing') expect(parseProcessOwnerTag(runnerOwnerTag)?.owner).toEqual({ kind: 'session', sessionId: 'session-hosted-command' });
        else if (process.platform === 'linux') expect(parseProcessOwnerTag(runnerOwnerTag)?.owner.kind).toBe('happier');
        else expect(parseProcessOwnerTag(runnerOwnerTag)?.owner.kind).not.toBe('session');
        if (!runnerArgs) throw new Error('The real daemon producer did not submit an executable command');
        const commandIndex = runnerArgs.indexOf('codex');
        expect(commandIndex).toBeGreaterThanOrEqual(0);
        const args = runnerArgs.slice(commandIndex);
        expect(args).toContain('work terminals');
        const input = buildAgentCliSessionCommandBuildInput({
          settings: {}, processEnv: {}, startedBy: 'daemon', isExplicitCliSubcommand: true,
          parsed: partitionProviderSessionArgs({ args, providerSubcommand: 'codex' }),
        });
        expect(resolveCodexCliSessionExtraOptions(input.parsed)).toMatchObject({
          ok: true, options: { startingMode: 'local' },
        });
      });
    });
  });
});
