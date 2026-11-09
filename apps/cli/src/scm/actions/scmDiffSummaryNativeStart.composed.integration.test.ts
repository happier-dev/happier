import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { z } from 'zod/mini';
import {
  buildBackendTargetKeyV2, ExecutionRunGetResponseSchema, ScmDiffSummaryGenerateOutputSchema,
  ScmDiffSummaryResultResponseSchema, SessionSpawnNewActionResultV1Schema, SessionSpawnNewInputV2Schema,
  projectSessionSpawnNewActionInputV2,
} from '@happier-dev/protocol';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';

const nativeObservation = z.object({ input: z.string(), inputIds: z.array(z.string()), output: z.string(), pid: z.number() });

it('generates and refines a saved Changes revision through the installed native Run and exact root-bounded input', async () => {
  const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-changes-native-' });
  const cwd = repository.rootPath;
  onTestFinished(() => removeTempDir(cwd));
  const capturePath = join(cwd, '.git', 'native-inputs.jsonl');
  const firstInput = 'CHANGES_NATIVE_FIRST_INPUT';
  const refinement = 'CHANGES_NATIVE_REFINE: explain the changed line more briefly.';
  // This is the external native Agent boundary. Its real subprocess reads Git
  // evidence and receives the host's exact input; no host publication is injected.
  const program = `const { execFileSync } = require('node:child_process');
    const { appendFileSync } = require('node:fs');
    const inputIds = JSON.parse(process.argv[1]);
    const input = process.argv[2];
    const git = execFileSync('git', ['diff', '--', 'tracked.txt'], { encoding: 'utf8' });
    if (!git.includes('+Native captured change')) throw new Error('Native Agent did not read the actual repository');
    if (input !== ${JSON.stringify(firstInput)} && !input.includes('Native captured change')) throw new Error('Native input lost the captured evidence');
    const output = input === ${JSON.stringify(firstInput)} ? 'Native repository ready.'
      : JSON.stringify({ summaryMarkdown: (input.includes(${JSON.stringify(refinement)}) ? 'Refined' : 'Generated') + ': Native captured change.' });
    appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ input, inputIds, output, pid: process.pid }) + '\\n');
    process.stdout.write(output);`;
  await writeFile(join(cwd, repository.trackedPath), 'Native captured change\n');
  const target = { kind: 'agent' as const, identity: { pluginId: 'acme.project-launch', localId: 'agent' } };
  const fixture = await startInstalledDaemonFixture({ plugins: [createFirstConversationAgentFixture(firstInput, {
    nativeReply: { executableNames: ['node'], args: ['-e', program, '--'] },
  })] });
  const owner = fixture.createActionExecutor();
  const context = { surface: 'ui' as const, externalActionTarget: { kind: 'machine' as const, machineId: fixture.machineId,
    project: { machineId: fixture.machineId, directory: cwd } } };
  const observations = async () => (await readFile(capturePath, 'utf8')).trim().split('\n')
    .map(line => nativeObservation.parse(JSON.parse(line)));
  try {
    const birth = await owner.execute('session.spawn_new', projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
      creationKey: randomUUID(), executionTarget: { serverId: fixture.serverId, machineId: fixture.machineId },
      directory: { kind: 'path', path: cwd }, organizationPlacement: { folderId: null, tagIds: [] },
      agentTarget: target, connectedServices: { v: 2, bindingsByServiceId: {} }, initialInput: { text: firstInput },
    })), context);
    expect(birth).toMatchObject({ ok: true });
    if (!birth.ok) throw new Error('Changes carrier Session creation refused');
    const created = SessionSpawnNewActionResultV1Schema.parse(birth.result);
    expect(created).toMatchObject({ type: 'success', initialInput: { status: 'accepted' } });
    if (created.type !== 'success') throw new Error('Changes carrier Session did not start');
    const sessionId = created.sessionId;
    const idle = await owner.execute('session.wait.idle', { sessionId }, context);
    expect(idle).toMatchObject({ ok: true, result: { ok: true, idle: true, sessionId } });
    const initial = await fixture.home.readWorkflowSessionEffects();
    expect(initial.turns).toEqual([expect.objectContaining({ sessionId, status: 'completed' })]);
    expect(initial.pending).toEqual([]);
    expect(initial.sessions).toEqual([expect.objectContaining({ id: sessionId, pendingCount: 0, pendingBlockedCount: 0 })]);
    const initialUser = initial.messages.filter(message => message.messageRole === 'user');
    const initialAssistant = initial.messages.filter(message => message.messageRole === 'agent');
    expect(JSON.parse(initial.turns[0]!.transcriptAnchorsJson!)).toMatchObject({
      startUserMessageSeq: initialUser[0]?.seq, userMessageSeqs: [initialUser[0]?.seq], finalAssistantMessageSeq: initialAssistant.at(-1)?.seq,
    });
    const nativeInitial = await observations();
    expect(nativeInitial.map(row => row.input)).toEqual([firstInput]);
    if (created.initialInput?.status !== 'accepted') throw new Error('Carrier first input was not accepted');
    expect(nativeInitial[0]?.inputIds).toEqual([created.initialInput.localId]);

    const generatedAction = await owner.execute('scm.diffSummary.generate', { cwd, sessionId, source: { kind: 'workingTree' },
      modelSelector: { backendTargetKey: buildBackendTargetKeyV2(target), modelId: 'default' }, outputs: ['summary'] }, context);
    expect(generatedAction).toMatchObject({ ok: true });
    if (!generatedAction.ok) throw new Error('Changes Generate Action refused');
    const generated = ScmDiffSummaryGenerateOutputSchema.parse(generatedAction.result);
    expect(generated).toMatchObject({ success: true, runId: expect.any(String), resultId: expect.any(String) });
    if (!generated.runId || !generated.resultId) throw new Error('Generate did not create its nested Run and saved result');
    const scope = { cwd, resultId: generated.resultId };
    const readSaved = async () => {
      const action = await owner.execute('scm.diffSummary.result.read', scope, context);
      if (!action.ok) throw new Error('Saved Changes read refused');
      return ScmDiffSummaryResultResponseSchema.parse(action.result);
    };
    const waitForOutput = async (afterRevision: number) => {
      const waited = await owner.execute('execution.run.get', { sessionId, runId: generated.runId, includeStructured: true,
        waitForOutput: { kind: 'scm_diff_summary', comparisonId: generated.comparison?.id, resultId: generated.resultId,
          output: 'summary', afterRevision } }, context);
      expect(waited).toMatchObject({ ok: true });
    };
    await waitForOutput(0);
    const saved = await readSaved();
    if (!saved.success) throw new Error('Generated saved result unavailable');
    expect(saved.result.output.outputs?.summary?.state).toBe('complete');
    expect(saved.result.output.outputs?.summary?.value?.summaryMarkdown).toBe('Generated: Native captured change.');
    const generatedNative = (await observations())[1]!;
    expect(generatedNative.inputIds).toEqual([generated.inputId]);
    expect(generatedNative.input).toContain('Native captured change');
    expect(generatedNative.input).not.toBe(generatedNative.output);
    expect(generatedNative.pid).not.toBe(process.pid);

    const requestId = randomUUID();
    const refined = await owner.execute('scm.diffSummary.refine', { ...scope, expectedRevision: saved.result.revision,
      output: 'summary', instructions: refinement }, { ...context, actionRequestId: requestId });
    expect(refined).toMatchObject({ ok: true, result: { success: true, runId: generated.runId, inputId: requestId } });
    await waitForOutput(saved.result.revision);
    const latest = await readSaved();
    if (!latest.success) throw new Error('Refined saved result unavailable');
    expect(latest.result.output.outputs?.summary?.value?.summaryMarkdown).toBe('Refined: Native captured change.');
    expect(latest.result.revision).toBeGreaterThan(saved.result.revision);
    expect(latest.result.output.runId).toBe(generated.runId);
    expect(latest.result.output.outputs?.summary?.state).toBe('complete');
    const native = await observations();
    expect(native).toHaveLength(3);
    expect(native[2]?.input).toContain(refinement);
    expect(native[2]?.inputIds).toEqual([requestId]);
    expect(native[2]?.input).toContain(`Saved result ${scope.resultId}, revision ${saved.result.revision}.`);
    expect(native[2]?.input).not.toBe(native[2]?.output);
    const run = await owner.execute('execution.run.get', { sessionId, runId: generated.runId, includeStructured: true }, context);
    expect(run).toMatchObject({ ok: true });
    if (!run.ok) throw new Error('Nested Changes Run observation refused');
    expect(ExecutionRunGetResponseSchema.parse(run.result).run).toMatchObject({ runId: generated.runId, turnInFlight: false,
      interaction: { kind: 'retained_agent_session.v1' }, inputTurns: { last: { state: 'completed', inputIds: [requestId] } } });
    const effects = await fixture.home.readWorkflowSessionEffects();
    expect(effects.sessions.map(session => session.id)).toEqual([sessionId]);
    expect(effects.pending).toEqual([]);
    expect(effects.sessions).toEqual([expect.objectContaining({ pendingCount: 0, pendingBlockedCount: 0 })]);
    const refinedInput = effects.messages.filter(message => message.messageRole === 'user'
      && JSON.stringify(message.content).includes(refinement));
    expect(refinedInput).toHaveLength(1);
    expect(refinedInput[0]?.localId).toBe(requestId);
    expect(refinedInput[0]?.content).toMatchObject({ t: 'plain', v: { content: { text: native[2]?.input } } });

    // The signed root's selected Project is narrower than the saved result.
    // The retained-result owner deliberately conceals inaccessible evidence.
    const bounded = await owner.execute('scm.diffSummary.refine', { ...scope,
      expectedRevision: latest.result.revision, output: 'summary', instructions: 'Denied out-of-root input' },
    { ...context, externalActionTarget: { ...context.externalActionTarget,
      project: { machineId: fixture.machineId, directory: repository.nestedPath } } });
    expect(bounded).toMatchObject({ ok: true, result: { success: false, errorCode: 'result_unavailable' } });
    expect(await observations()).toEqual(native);
    expect(await fixture.home.readWorkflowSessionEffects()).toEqual(effects);
    expect(await readSaved()).toEqual(latest);

    const member = await fixture.home.createMachineMember('admin');
    const denied = await fixture.createActionExecutor(member).execute('scm.diffSummary.refine', { ...scope,
      expectedRevision: latest.result.revision, output: 'summary', instructions: 'Denied member input' }, context);
    expect(denied).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(await observations()).toEqual(native);
    expect(await fixture.home.readWorkflowSessionEffects()).toEqual(effects);
    expect(await readSaved()).toEqual(latest);
  } finally {
    await fixture.stop();
  }
}, 120_000);
