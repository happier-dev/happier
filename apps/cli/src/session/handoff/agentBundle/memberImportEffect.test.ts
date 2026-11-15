import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createBackgroundServiceProcessServiceHost } from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessBridge';
import {
  createBackgroundServiceProcessFrameDecoder,
  encodeBackgroundServiceProcessFrame,
  parseBackgroundServiceProcessMessage,
} from '@/plugins/runtime/lifecycle/contributions/backgroundServiceProcessProtocol';
import { runWorkspaceEffectWorker } from '@/workspaces/activation/workspaceEffectWorker';
import type { MemberSessionImportRecord } from './memberImportEffect';

const PLUGIN_ID = 'acme.member-handoff';
const AGENT_ID = 'member-handoff-agent';

// The member Workspace effect child: its frame pipe, service bridge, plugin admission and
// activation stay real. The OS identity switch belongs to the exec launch owner's suites.
it('creates the contained cwd and imports through the admitted Agent plugin in the member Workspace effect child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'handoff-member-effect-'));
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [
      {
        manifest: createPluginManifestV2Fixture({
          id: PLUGIN_ID,
          entrypoints: { daemon: './daemon.mjs' },
          contributes: {
            agents: [
              {
                id: AGENT_ID,
                title: 'Member handoff Agent',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                  sessions: {
                    open: ['create'],
                    delivery: ['newTurn'],
                    cancel: true,
                  },
                },
              },
            ],
          },
        }),
        files: {
          'agent-runtime.mjs': `
        import { writeFile } from 'node:fs/promises';
        import { join } from 'node:path';
        export async function memberHandoffRuntime() {
          return {
            sessions: { open: async () => ({ send: async () => ({ status: 'admitted' }), stop: async () => ({ status: 'requested' }),
              watch: () => ({ dispose: () => undefined }), dispose: async () => undefined }) },
            surfaces: { handoff: {
              exportBundle: async () => ({ ok: false, code: 'unsupported' }),
              importBundle: async (request) => {
                await writeFile(join(request.targetDirectory, 'imported.txt'), String(request.bundle.transcriptBase64));
                return { ok: true, value: { providerSessionId: String(request.bundle.remoteSessionId),
                  launch: { directory: request.targetDirectory, environmentVariables: {} } } };
              },
            } },
          };
        }`,
          'daemon.mjs': `
        import { memberHandoffRuntime } from './agent-runtime.mjs';
        export function activate(api) {
          api.agents.register('${AGENT_ID}', memberHandoffRuntime, { sessionRunnerFactory: {
            module: './agent-runtime.mjs', export: 'memberHandoffRuntime', runtimeApiVersion: 1 } });
        }`,
        },
      },
    ],
    runtimeOptions: { pluginIds: [PLUGIN_ID] },
  });
  const workspaceRoot = join(directory, 'member', 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const running = runWorkspaceEffectWorker([], {
    input: stdin,
    output: stdout,
    signal: new AbortController().signal,
    currentDirectory: () => workspaceRoot,
  });
  let record: MemberSessionImportRecord | undefined;
  let failure: unknown;
  const services = createBackgroundServiceProcessServiceHost({
    services: {
      onEffectsIssued: async () => {},
      complete: async () => {
        throw new Error('A Session import never completes a checkout');
      },
      fail: async (error: Error) => {
        failure = error;
      },
      completeSessionImport: async (value: MemberSessionImportRecord) => {
        record = value;
      },
    },
    send: (message) =>
      stdin.write(encodeBackgroundServiceProcessFrame({ kind: 'services', message })),
  });
  const decoder = createBackgroundServiceProcessFrameDecoder();
  const settled = new Promise<void>((resolve) => {
    stdout.on('data', (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const message = parseBackgroundServiceProcessMessage(raw);
        if (message.kind === 'services') services.receive(message.message);
        else if (message.kind === 'settled') resolve();
      }
    });
  });
  try {
    const plugins = fixture.registry.readAdmittedBackgroundServicePlugins?.([
      PLUGIN_ID,
    ]);
    if (!plugins?.length)
      throw new Error('Authored fixture has no admitted process source');
    // The catalog Agent id the daemon reads from the same admitted declarations.
    const agentId = fixture.registry.contributes.agents.find(
      (agent) => agent.identity?.pluginId === PLUGIN_ID,
    )?.id;
    if (!agentId) throw new Error('Authored fixture has no Agent declaration');
    const targetDirectory = join(workspaceRoot, 'packages', 'app');
    stdin.write(
      encodeBackgroundServiceProcessFrame({
        kind: 'run',
        id: 'session-import',
        context: {
          kind: 'session_import',
          workspaceRoot,
          agentId,
          plugins,
          generation: fixture.registry.generation,
          bundle: {
            agentId,
            remoteSessionId: 'native-session',
            transcriptBase64: 'e30K',
          },
          targetDirectory,
          workspace: {
            rootPath: workspaceRoot,
            sessionRelativeCwd: 'packages/app',
          },
        },
        services: services.description,
      }),
    );
    await settled;
    expect(failure).toBeUndefined();
    expect(record, JSON.stringify(record)).toMatchObject({
      t: 'imported',
      value: {
        providerSessionId: 'native-session',
        launch: { directory: targetDirectory },
      },
    });
    expect((await stat(targetDirectory)).isDirectory()).toBe(true);
    expect(await readFile(join(targetDirectory, 'imported.txt'), 'utf8')).toBe(
      'e30K',
    );
  } finally {
    stdin.end();
    await running.catch(() => undefined);
    await services.dispose();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
