import assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { definePlugin, PluginError, type PluginProjectNativeAdapterRuntimeV1 } from '@happier-dev/plugin-sdk';

import { pixiPlugin, pixiAdapter, importedPixiEnvironment } from '../../../../../packages/plugin-sdk/fixtures/external-targeted-packages/project-native-source.ts';
import { ingestCanonicalPluginManifest } from '../../plugins/manifest/ingest.ts';
import { createResolvedContributionRegistry } from '../../plugins/projection/registry/createResolvedContributionRegistry.ts';
import { activatePluginRuntimeRegistry } from '../../plugins/runtime/lifecycle/manager.ts';
import { resolveProjectNativeAdapter, type ProjectNativeAdapterProductionV1 } from '../../plugins/runtime/lifecycle/contributions/targetProjectNativeAdapters.ts';
import { createPluginRuntimeOccurrenceId } from '../../plugins/runtime/runtimeSlots.ts';
import { createProductionPluginInvocationServiceOwners } from '../../plugins/runtime/invocation/services/production.ts';
import { createPluginInvocationLifetime } from '../../plugins/runtime/invocation/lifetime.ts';
import { produceProjectNativeEnvironment } from './produceProjectNativeEnvironment.ts';
import * as processTreeBoundary from '../../agent/runtime/process/killProcessTree.ts';
import type { ProjectNativeEnvironmentInput } from './produceProjectNativeEnvironment.ts';
import type { ActivationTarget } from '../../plugins/runtime/lifecycle/activation/targets.ts';
import { produceProjectLaunchEnvironmentForHost } from '../../plugins/runtime/invocation/services/exec.ts';

// Source conformance through the real admitted lifecycle, not installed-Pixi
// qualification. The external fixture alone owns its native dialect.
test.each(['ready', 'environmentOnly', 'environmentOnlyWrapper', 'ordinaryFailed', 'cancelledProcess'] as const)('produces a public adapter environment/managed wrapper through its current bound occurrence (%s)', async (mode) => {
  const controller = new AbortController();
  onTestFinished(() => controller.abort());
  let nativeOsFailureRaised = false;
  let production: ProjectNativeAdapterProductionV1 | undefined;
  let completedInvocations = 0;
  let processId: number | undefined;
  let restoreTermination: (() => void) | undefined;
  let unsubscribeUncertainty: (() => void) | undefined;
  let stopReadinessObservation: (() => void) | undefined;
  const runtime: PluginProjectNativeAdapterRuntimeV1 = {
    async produceEnvironment(request, context) {
      if (mode === 'environmentOnly' || mode === 'environmentOnlyWrapper') {
        assert.equal(request.launch, undefined, 'Environment preparation must not fabricate a process intent');
        return { kind: 'ready', env: { NATIVE: 'active' }, reviewInputs: request.files,
          ...(mode === 'environmentOnlyWrapper' ? { launch: { executable: { kind: 'systemTool' as const, id: 'pixi' },
            args: ['run', 'check'], cwd: request.root, reviewInputs: request.files } } : {}),
        };
      }
      await context.services.exec.run({ executable: { kind: 'systemTool', id: 'pixi' }, args: mode === 'cancelledProcess'
        ? ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', join(root, 'native.pid')]
        : [] });
      return { kind: 'ready', env: request.launch?.env ?? {}, reviewInputs: request.files };
    },
  };
  const plugin = mode === 'ready' ? pixiPlugin : definePlugin({
    id: pixiAdapter.pluginId, version: '1.0.0', displayName: 'Native effect custody fixture', entrypoints: { daemon: './daemon.js' },
    hostAccess: { required: [{ id: 'native-process', capability: 'process', reason: 'Evaluate the selected native environment',
      scope: { executables: [{ kind: 'systemTool', id: 'pixi' }] } }], optional: [] },
    systemTools: { pixi: { title: 'Pixi', executableNames: ['pixi'] } },
    projectNativeAdapters: { [pixiAdapter.localId]: {
      declaration: { files: ['pixi.toml'], roles: ['produceEnvironment'] }, runtime,
    } },
  });
  const root = await mkdtemp(join(tmpdir(), 'happier-project-native-plugin-'));
  const content = '[tasks]\ncheck = "echo checked"';
  await writeFile(join(root, 'pixi.toml'), content);
  const ingested = ingestCanonicalPluginManifest(plugin.manifest, { sourceProvenance: 'registryCustodied' });
  if (!ingested.ok) throw new Error(JSON.stringify(ingested.diagnostics));
  const targets = [{ provenance: 'first_party', source: { kind: 'bundled' }, pluginId: pixiAdapter.pluginId,
    manifestPath: '/virtual/pixi/plugin.json', daemonEntryPath: '/virtual/pixi/daemon.mjs',
    sourceSpec: { kind: 'package', locator: '@acme/pixi', trustPolicy: 'local_trusted', installPolicy: 'copy' },
    activationEvents: [], manifest: ingested.manifest }] satisfies readonly ActivationTarget[];
  const registry = await activatePluginRuntimeRegistry({
    contributes: createResolvedContributionRegistry({ activationTargets: targets }),
    occurrenceIdsByPluginId: new Map([[pixiAdapter.pluginId, createPluginRuntimeOccurrenceId(pixiAdapter.pluginId)]]), generation: 1,
    // Genuine module-loading boundary: loads the public definePlugin fixture.
    resolveActivationSource: () => ({ kind: 'bundled', moduleId: `@acme/pixi/daemon/${mode}`,
      load: async () => ({ manifest: plugin.manifest, activate: plugin.activate }) }),
  });
  const owners = createProductionPluginInvocationServiceOwners({ loggerSink: { write() {} },
    exec: {
      // Genuine OS executable-resolution boundary, beneath real SDK Exec.
      resolveExecutable: async () => {
        nativeOsFailureRaised = true;
        if (mode === 'cancelledProcess') return { command: process.execPath };
        throw new PluginError({ code: 'native_process_failed', message: 'private native process diagnostics' });
      },
      resolvePath: async () => { throw new Error('Unexpected OS path resolution'); },
    },
  });
  try {
    const selected = await resolveProjectNativeAdapter({ reference: pixiAdapter, role: 'produceEnvironment', targets, registry,
      createInvocationContext(input) {
        const lifetime = createPluginInvocationLifetime(input.signal);
        const seed = { plugin: { id: pixiAdapter.pluginId, version: plugin.manifest.version },
          contribution: { id: pixiAdapter.localId, qualifiedId: `${pixiAdapter.pluginId}/projectNativeAdapters/${pixiAdapter.localId}` },
          occurrenceId: input.occurrenceId, correlationId: 'native-environment-source-test', surface: 'cli' as const,
          signal: lifetime.signal, redactionLifetimeSignal: lifetime.redactionLifetimeSignal, isOccurrenceCurrent: input.isCurrent };
        return { context: { ...seed, invokedAtMs: lifetime.invokedAtMs,
          services: owners.createOperationServices(seed, {
            filesystemRoots: { pluginData: root, workspace: input.root, projects: new Map() },
            hostAccessRequests: ingested.manifest.hostAccess.required.map(request => ({ request, required: true })),
          }) }, complete() { completedInvocations += 1; lifetime.complete(); } };
      },
    });
    if (selected.kind !== 'ready') throw new Error(`Native adapter admission: ${selected.code} ${JSON.stringify(registry.pluginDiagnosticsByPluginId[pixiAdapter.pluginId])}`);
    const acquired = selected.lease.acquireProduction({ root, signal: controller.signal });
    if (acquired.kind !== 'ready') throw new Error(`Native production admission: ${acquired.code}`);
    const retainedProduction = acquired.production;
    production = retainedProduction;
    const files = [{ file: 'pixi.toml', content }];
    const input: ProjectNativeEnvironmentInput = { selection: importedPixiEnvironment, root, cwd: root, env: { KEEP: 'host' }, platform: 'linux', signal: controller.signal,
      io: { resolveTool: async () => { throw new Error('No builtin probing for a plugin adapter'); },
        run: async () => { throw new Error('No host-owned plugin native flags'); } },
      pluginAdapter: { lease: production, files, launch: { command: '/bin/echo', args: ['checked'] } } };
    if (mode === 'environmentOnly' || mode === 'environmentOnlyWrapper') {
      const prepareEnvironment = () => produceProjectLaunchEnvironmentForHost({ cwd: root, env: { REMOVE: 'host' },
        signal: controller.signal, assertCurrent: () => assert.ok(production?.isCurrent()),
        projectLaunch: { status: 'ready', reviewedEffectDigest: 'reviewed-environment-only-effect',
          environment: { root, selection: importedPixiEnvironment, platform: 'linux', io: input.io },
          nativeAdapter: { lease: retainedProduction, files },
        },
      });
      if (mode === 'environmentOnlyWrapper') {
        await assert.rejects(prepareEnvironment(), { code: 'native_environment_launch_required' });
      } else {
        assert.deepEqual(await prepareEnvironment(), { NATIVE: 'active' }, 'Complete native environment must preserve removals');
      }
      assert.equal(nativeOsFailureRaised, false, 'No dummy command may reach executable resolution');
      assert.equal(completedInvocations, 0, 'The retained producer remains owned until no-launch cleanup');
      return;
    }
    if (mode === 'cancelledProcess') {
      // Fault the genuine OS tree-termination boundary only after a real child
      // is captured; a resolver error without a process is not custody proof.
      const termination = vi.spyOn(processTreeBoundary, 'killProcessTree')
        .mockRejectedValueOnce(new Error('private native process diagnostics'));
      restoreTermination = () => termination.mockRestore();
      let reportUncertainty!: () => void;
      const uncertain = new Promise<void>(resolve => { reportUncertainty = resolve; });
      unsubscribeUncertainty = production.onOutcomeUncertain(reportUncertainty);
      // Observe the actual child-written PID, under the containing test's
      // deadline. A shorter poll deadline is not a native startup contract.
      const pidReady = new Promise<string>((resolve, reject) => {
        const observer = watch(root, (_event, filename) => {
          if (filename === 'native.pid') void readPid();
        });
        const abortReadiness = () => reject(new Error('Native fixture readiness cancelled'));
        controller.signal.addEventListener('abort', abortReadiness, { once: true });
        stopReadinessObservation = () => {
          observer.close();
          controller.signal.removeEventListener('abort', abortReadiness);
        };
        observer.once('error', reject);
        async function readPid() {
          try {
            const value = await readFile(join(root, 'native.pid'), 'utf8');
            if (!/^\d+$/.test(value)) return;
            stopReadinessObservation?.();
            resolve(value);
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
            reject(error);
          }
        }
        void readPid();
      });
      let completed = false;
      const running = produceProjectNativeEnvironment(input).finally(() => { completed = true; });
      void running.catch(() => undefined); // Preserve failure for await without an unhandled rejection during OS observation.
      const readyPid = await Promise.race([
        pidReady,
        running.then(() => { throw new Error('Native environment completed before fixture PID readiness'); }),
      ]);
      expect(readyPid).toMatch(/^\d+$/);
      processId = Number(readyPid);
      controller.abort();
      await uncertain;
      assert.equal(completed, false, 'Unknown tree custody must keep the original production pending');
      assert.equal(completedInvocations, 0, 'Unknown tree custody must retain the selected invocation');
      assert.ok(processId);
      assert.equal(process.kill(processId, 0), true);
      await production.requestStop();
      assert.deepEqual(await running, { status: 'refused', kind: 'cancelled', code: 'native_environment_cancelled' });
      await expect.poll(() => {
        try { process.kill(processId!, 0); return false; }
        catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return true;
          throw error;
        }
      }).toBe(true);
      await production.release();
      assert.equal(completedInvocations, 1, 'Only proved physical settlement completes the same invocation');
      processId = undefined;
      return;
    }
    if (mode === 'ordinaryFailed') {
      const outcome: unknown = await produceProjectNativeEnvironment(input).then(value => value, (error: unknown) => error);
      assert.ok(nativeOsFailureRaised, 'Native effect must reach the genuine OS boundary before classification');
      assert.deepEqual(outcome, { status: 'refused', kind: 'native_failed', code: 'native_adapter_failed' });
      return;
    }
    const produced = await produceProjectNativeEnvironment(input);
    if (produced.status !== 'ready') assert.fail(`Expected ready native production, got ${produced.kind}/${produced.code}`);
    assert.deepEqual(produced.env, { KEEP: 'host' });
    assert.deepEqual(produced.nativeLaunch, { executable: { kind: 'systemTool', id: 'pixi' },
      args: ['run', '--', '/bin/echo', 'checked'], cwd: root, reviewInputs: files });
    assert.deepEqual(produced.reviewInputs, files);
    assert.deepEqual(await produceProjectNativeEnvironment({ ...input, nativeCommandEnvironment: importedPixiEnvironment }),
      { status: 'ready', env: input.env });
    const differentConfig = await produceProjectNativeEnvironment({ ...input,
      nativeCommandEnvironment: { kind: 'pluginToolchain', adapter: pixiAdapter, configPath: 'other.toml' },
    });
    if (differentConfig.status !== 'ready') assert.fail(differentConfig.code);
    assert.deepEqual(differentConfig.nativeLaunch, produced.nativeLaunch);
    assert.deepEqual(await produceProjectNativeEnvironment({ ...input, signal: AbortSignal.abort() }),
      { status: 'refused', kind: 'cancelled', code: 'native_environment_cancelled' });
    await registry.dispose();
    assert.deepEqual(await produceProjectNativeEnvironment(input), { status: 'refused', kind: 'unavailable', code: 'native_adapter_retired' });
  } finally {
    stopReadinessObservation?.();
    restoreTermination?.();
    unsubscribeUncertainty?.();
    try {
      await production?.requestStop();
      await production?.release();
    } finally {
      if (processId) { try { process.kill(processId, 'SIGKILL'); } catch {} }
      await registry.dispose();
      await owners.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }
});
