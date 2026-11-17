import { execFileSync, spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import assert from 'node:assert/strict';
import { build, type BuildOptions } from 'esbuild';
import { createRequire } from 'node:module';
import { captureScmComparison, hostScmComparisonShelf, type CapturedScmComparison, type ScmComparisonShelf } from '../../comparisons/captureScmComparison';
import { resolveStoredScmComparisonPath, resolveStoredScmComparisonEndpointsPath } from '../../comparisons/comparisonStorage';
import { configuration } from '@/configuration';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { resolveScmAccountStorageKey, runWithScmAccountScope } from '../../accountScope';
import { runWorkspaceEffectChannel } from '@/workspaces/activation/workspaceEffectProcess';
import type { MemberScmComparisonEffect } from '../memberScmComparison';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { prepareAdmittedScmEffect } from '@/workspaces/activation/workspaceEffect';
import { createScmDiffSummaryResultStore } from '@/agent/executionRuns/tasks/scmDiffSummary/results/resultStore';
import { ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummaryResultResponse } from '@happier-dev/protocol';
import { buildCommitPlanAcceptance } from '../../../../../ui/sources/components/sessions/files/commits/commitPlanAcceptance';
import type { MemberScmComparisonServices } from '../memberScmComparison';
import { projectRepositoryCheckpointTranscriptPage } from '../../checkpoints/recoverRepositoryCheckpointEvidence';

export async function runMemberScmComparisonRealUid(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'happier-member-comparison-'));
    await chmod(root, 0o755);
    const repo = join(root, 'repository');
    const sourceRoot = resolve(import.meta.dirname, '../../../../../..');
    const script = join(root, 'worker.mjs');
    const { SOURCE_RUNTIME_COMMONJS_BANNER, SOURCE_RUNTIME_COMMONJS_DEFINE, SOURCE_RUNTIME_OUTPUT_OPTIONS,
      createWorkspaceSourceResolver, readWorkspacePackages } = await import('@happier-dev/cli-common/sourceRuntimeEntries');
    // Compile the actual worker and its admitted Git module in one graph, preserving shared SDK context.
    const entry = join(root, 'worker-entry.ts');
    await writeFile(entry, `import { writeFile } from 'node:fs/promises';\nimport { runWorkspaceEffectWorker } from ${JSON.stringify(join(sourceRoot, 'apps/cli/src/workspaces/activation/workspaceEffectWorker.ts'))};\nawait writeFile('.git/worker-identity.json', JSON.stringify({ uid: process.getuid(), cwd: process.cwd(), home: process.env.HOME, token: process.env.HAPPIER_TOKEN ?? null }));\nawait runWorkspaceEffectWorker([], { input: process.stdin, output: process.stdout, signal: new AbortController().signal });\n`);
    const fixtureBuild: BuildOptions = { bundle: true, splitting: true, platform: 'node', format: 'esm',
      ...SOURCE_RUNTIME_OUTPUT_OPTIONS, banner: { js: SOURCE_RUNTIME_COMMONJS_BANNER }, define: SOURCE_RUNTIME_COMMONJS_DEFINE,
      outdir: root, outExtension: { '.js': '.mjs' }, tsconfig: join(sourceRoot, 'apps/cli/tsconfig.json'), conditions: ['happier-source'],
      plugins: [createWorkspaceSourceResolver({ workspacePackages: await readWorkspacePackages(sourceRoot),
        requireFromProject: createRequire(join(sourceRoot, 'apps/cli/package.json')), externalPackages: [] }), { name: 'legacy-commonjs-escapes', setup(builder) {
        builder.onLoad({ filter: /qrcode-terminal\/lib\/main\.js$/ }, async args => ({
          contents: (await readFile(args.path, 'utf8')).replaceAll('\\033', '\\x1b'), loader: 'js',
        }));
      } }],
      external: ['*.node'], logLevel: 'silent' };
    execFileSync('/usr/bin/sudo', ['-n', 'install', '-d', '-o', 'nobody', '-g', 'nogroup', '-m', '0755', repo]);
    const git = (...args: string[]) => execFileSync('/usr/bin/sudo', ['-n', '-u', 'nobody', '--', 'env', '-i', 'PATH=/usr/bin:/bin',
      `HOME=${repo}`, 'git', '-C', repo, ...args], { encoding: 'utf8' }).trim();
    const memberWrite = (path: string, value: string) => execFileSync('/usr/bin/sudo', ['-n', '-u', 'nobody', '--', '/bin/sh', '-c',
      'printf "%s" "$2" > "$1"', 'fixture', join(repo, path), value]);
    let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | undefined;
    let indexObserver: ReturnType<typeof watch> | undefined;
    const temporaryIndexOwners: number[] = [];
    const indexObservations: Promise<unknown>[] = [];
    try {
      runtime = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
      git('init', '-q'); git('config', 'user.name', 'Member fixture'); git('config', 'user.email', 'member@example.invalid');
      memberWrite('tracked.txt', 'before\n'); git('add', 'tracked.txt'); git('commit', '-qm', 'before');
      memberWrite('tracked.txt', 'after\n');
      indexObserver = watch(join(repo, '.git'), (_event, name) => {
        if (!name?.toString().startsWith('happier-index-') || name.toString().endsWith('.lock')) return;
        // Observe real temporary files while the member's Git commands own them; deleted events are expected.
        indexObservations.push(stat(join(repo, '.git', name.toString())).then(value => temporaryIndexOwners.push(value.uid)).catch(() => {}));
      });
      const daemonCapture = await runWithScmAccountScope('requester-member-test', () => captureScmComparison({
        cwd: repo, source: { kind: 'workingTree' }, registry: runtime!.registry }));
      assert.equal(daemonCapture.comparison.inventory.state, 'unavailable');
      await runWithScmAccountScope('requester-member-test', () => hostScmComparisonShelf.remove({ comparisonId: daemonCapture.comparison.id }));
      const account = <T>(run: () => T) => runWithScmAccountScope('requester-member-test', run);
      const shelf: ScmComparisonShelf = {
        refNamespace: resolveScmAccountStorageKey('requester-member-test'),
        withStored: (scope, consume) => account(() => hostScmComparisonShelf.withStored(scope, consume)),
        write: (scope, stored, identity) => account(() => hostScmComparisonShelf.write(scope, stored, identity)),
        remove: (scope, stored) => account(() => hostScmComparisonShelf.remove(scope, stored)),
        materializeEndpoints: (scope, writer) => account(() => hostScmComparisonShelf.materializeEndpoints(scope, writer)),
      };
      let workerInput = '';
      const effect = async <T>(operation: MemberScmComparisonEffect, services: Partial<MemberScmComparisonServices> = {}): Promise<T> => {
        const child = spawn('/usr/bin/sudo', ['-n', '-u', 'nobody', '--', 'env', '-i', 'PATH=/usr/bin:/bin', `HOME=${repo}`,
          '/usr/bin/node', script], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr))); });
        let value: T | undefined;
        let failure: Error | undefined;
        const input = new PassThrough();
        workerInput = '';
        input.on('data', chunk => { workerInput += chunk.toString(); });
        input.pipe(child.stdin);
        const outcome = await runWithScmAccountScope('requester-member-test', () => runWorkspaceEffectChannel({
          channel: Duplex.from({ readable: child.stdout, writable: input }), signal: new AbortController().signal,
          id: 'member-comparison', effect: operation, refusal: code => new Error(code), services: {
            comparisonShelf: shelf,
            ...services,
            completeScmRead: async (result: T) => { value = result; },
            fail: async (error: Error) => { failure = error; },
          },
        }));
        await exited;
        if (failure) throw failure;
        assert.deepEqual(outcome, { settled: true, exitedCleanly: true });
        return value as T;
      };
      const admitted = (await prepareAdmittedScmEffect({ registry: runtime.registry })).effect;
      await build({ ...fixtureBuild, entryPoints: { worker: entry, ...Object.fromEntries(
        admitted.plugins.map((plugin, index) => [`plugin-${index}`, plugin.processEntry.entryPath])) } });
      const plugins = admitted.plugins.map((plugin, index) => {
        const entryPath = join(root, `plugin-${index}.mjs`);
        return { ...plugin, processEntry: { ...plugin.processEntry, entryPath, loadMode: 'immutable-js' as const } };
      });
      const base = { kind: 'scm_comparison' as const, workspaceRoot: repo, scm: { ...admitted, plugins } };
      await assert.rejects(effect({ ...base, operation: 'capture', input: { cwd: root, source: { kind: 'workingTree' } } }),
        (error: unknown) => isPluginError(error) && error.data.code === SCM_OPERATION_ERROR_CODES.INVALID_PATH);
      const checkpoint = await effect<CapturedScmComparison>({ ...base, operation: 'capture', input: { cwd: repo, sessionId: 'checkpoint-session',
        source: { kind: 'turnCheckpoint', sessionId: 'checkpoint-session', turnId: 'checkpoint-turn', evidenceMode: 'agent_reported' } } }, {
        comparisonTranscriptPage: async candidate => projectRepositoryCheckpointTranscriptPage({
          sessionId: 'checkpoint-session', scopeId: `checkpoint-session:${repo}`, turnId: 'checkpoint-turn', page: { messages: [
          { seq: 1, createdAt: 1, localId: 'prompt-id', content: { role: 'user', content: { type: 'text', text: 'requester-private-prose' } } },
          { seq: 2, createdAt: 2, content: { type: 'codex', data: { type: 'tool-call', callId: 'private-call', name: 'Bash', input: { command: 'requester-private-tool' } } } },
          { seq: 3, createdAt: 3, content: { role: 'agent', content: { type: 'codex', data: { type: 'tool-call', callId: 'diff', name: 'Diff', input: {
            private: 'requester-private-diff-field', files: [{ file_path: 'tracked.txt', unified_diff: '+checkpoint-evidence' }],
            _happier: { v: 2, protocol: 'codex', sessionChangeScope: 'turn', turnId: 'checkpoint-turn', sessionId: candidate.sessionId,
              provider: 'codex', rawToolName: 'Diff', canonicalToolName: 'Diff', source: 'canonical_diff_tool', confidence: 'exact',
              turnStatus: 'completed', seqRange: { startSeqInclusive: 1, endSeqInclusive: 3 } },
          } } } } },
        ], hasMore: false, nextAfterSeq: null } }),
      });
      assert.ok(!/requester-private-prose|requester-private-tool|requester-private-diff-field/.test(workerInput), 'Worker received unrelated requester transcript content');
      assert.equal(checkpoint.comparison.inventory.state, 'incomplete');
      assert.match(checkpoint.comparison.inventory.files[0]?.evidence.unifiedDiff ?? '', /checkpoint-evidence/);
      const captured = await effect<CapturedScmComparison>({ ...base, operation: 'capture', input: { cwd: repo, source: { kind: 'workingTree' } } });
      assert.equal(captured.comparison.inventory.state, 'complete');
      assert.deepEqual(captured.comparison.inventory.files.map(file => file.path), ['tracked.txt']);
      assert.match(captured.comparison.inventory.files[0]?.evidence.unifiedDiff ?? '', /\+after/);
      const namespace = resolveScmAccountStorageKey('requester-member-test');
      assert.equal((await stat(join(repo, '.git', 'refs', 'happier', 'comparisons', namespace, 'repository', captured.comparison.id, 'after'))).uid, 65534);
      const identity = JSON.parse(await readFile(join(repo, '.git/worker-identity.json'), 'utf8'));
      assert.deepEqual(identity, { uid: 65534, cwd: repo, home: repo, token: null });
      assert.notEqual(process.getuid?.(), identity.uid);
      const input = { cwd: repo, comparisonId: captured.comparison.id };
      const retained = await effect<CapturedScmComparison>({ ...base, operation: 'read', input });
      assert.deepEqual(retained.comparison, captured.comparison);
      const endpoints = await effect<{ beforeDirectory: string; afterDirectory: string }>({ ...base, operation: 'investigate',
        input: { ...input, directory: join(repo, '.git', 'investigation') } });
      assert.equal(await readFile(join(endpoints.beforeDirectory, 'tracked.txt'), 'utf8'), 'before\n');
      assert.equal(await readFile(join(endpoints.afterDirectory, 'tracked.txt'), 'utf8'), 'after\n');
      assert.equal((await stat(endpoints.afterDirectory)).uid, 65534);
      const store = createScmDiffSummaryResultStore({ directory: join(root, 'results') });
      const refs = captured.comparison.inventory.files.flatMap(file => file.occurrences.map(change => change.id));
      const plan = { groups: [{ id: 'member-group', message: 'feat: member change', rationale: 'Member-owned change', changeRefs: refs }], leftOutChangeRefs: [] };
      const saved = await store.create({ cwd: repo, output: ScmDiffSummaryGenerateOutputSchema.parse({ success: true,
        sourceKey: captured.comparison.id, comparison: captured.comparison, metadata: captured.metadata,
        requestedOutputs: ['commitPlan'], outputs: { commitPlan: { state: 'complete', value: plan } },
        analysis: { suppliedChangeRefs: refs, analysedChangeRefs: [], remainingChangeRefs: refs },
      }) });
      const acceptance = buildCommitPlanAcceptance({ comparison: captured.comparison, plan, application: null });
      assert.ok(acceptance);
      const committed = await effect<ScmDiffSummaryResultResponse>({ ...base, operation: 'commitPlan', input: {
        cwd: repo, actionId: 'scm.diffSummary.commitPlan.accept', input: { cwd: repo, resultId: saved.resultId, expectedRevision: 0, acceptance },
      } }, { comparisonCommitStore: { read: store.read, readStoredScope: store.readStoredScope,
        beginApplication: store.beginApplication, mutateApplication: store.mutateApplication } });
      assert.ok(committed.success, committed.success ? undefined : JSON.stringify(committed));
      assert.equal(committed.result.application?.status, 'complete', JSON.stringify(committed.result.application));
      assert.equal(git('log', '-1', '--format=%s|%an|%ae'), 'feat: member change|Member fixture|member@example.invalid');
      assert.equal((await stat(join(repo, '.git', 'index'))).uid, 65534);
      await Promise.all(indexObservations);
      assert.ok(temporaryIndexOwners.length > 0, 'Observed no actual temporary Git index');
      assert.ok(temporaryIndexOwners.every(uid => uid === 65534), 'Temporary Git index escaped the member UID');
      // Retained target-return endpoints belong to the requester shelf and must cross as files, not host paths.
      await runWithScmAccountScope('requester-member-test', async () => {
        const stored = await hostScmComparisonShelf.withStored(input, async reader => ({ ...reader.stored,
          comparison: captured.comparison, workspaceReturn: { baselineAvailable: true, entries: [] } }));
        await hostScmComparisonShelf.write(input, stored);
        const directory = resolveStoredScmComparisonEndpointsPath(resolveStoredScmComparisonPath({
          activeServerDir: configuration.activeServerDir, comparisonId: input.comparisonId }));
        await mkdir(join(directory, 'before'), { recursive: true, mode: 0o700 });
        await mkdir(join(directory, 'after'), { recursive: true, mode: 0o700 });
        await writeFile(join(directory, 'before', 'returned.txt'), 'old return\n');
        await writeFile(join(directory, 'after', 'returned.txt'), 'new return\n');
      });
      const returnedEndpoints = await effect<{ beforeDirectory: string; afterDirectory: string }>({ ...base, operation: 'investigate',
        input: { ...input, directory: join(repo, '.git', 'returned-investigation') } });
      assert.equal(await readFile(join(returnedEndpoints.beforeDirectory, 'returned.txt'), 'utf8'), 'old return\n');
      assert.equal(await readFile(join(returnedEndpoints.afterDirectory, 'returned.txt'), 'utf8'), 'new return\n');
      assert.equal((await stat(returnedEndpoints.afterDirectory)).uid, 65534);
      await effect({ ...base, operation: 'delete', input });
      assert.equal(git('for-each-ref', '--format=%(refname)', `refs/happier/comparisons/${namespace}/repository/${input.comparisonId}`), '');
    } finally {
      indexObserver?.close();
      await runtime?.dispose();
      execFileSync('/usr/bin/sudo', ['-n', 'rm', '-rf', '--', repo]);
      await rm(root, { recursive: true, force: true });
    }
}
