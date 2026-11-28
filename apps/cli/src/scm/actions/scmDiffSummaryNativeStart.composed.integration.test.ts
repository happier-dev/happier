import { randomUUID } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { z } from 'zod/mini';
import {
  AgentSessionConfigurationSnapshotV1Schema, buildConnectedServiceCredentialRecord, ExecutionRunGetResponseSchema, PluginManifestV2Schema, ScmDiffSummaryGenerateOutputSchema,
  ScmDiffSummaryResultResponseSchema, SessionSpawnNewActionResultV1Schema, SessionSpawnNewInputV2Schema,
  projectSessionSpawnNewActionInputV2,
} from '@happier-dev/protocol';
import { startInstalledDaemonFixture } from '@/daemon/testkit/installedDaemon.composed.testkit';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';
import { createLocalScmRepositoryFixture } from '@/testkit/scm/scmBackendContractFixtures';
import { removeTempDir } from '@/testkit/fs/tempDir';

const nativeObservation = z.object({ input: z.string(), inputIds: z.array(z.string()), output: z.string(), pid: z.number() });

it('generates saved Changes revisions with a selected Connected Account through the native Run (detached) and attached Run', async () => {
  const repository = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'happier-changes-native-' });
  const cwd = repository.rootPath;
  onTestFinished(() => removeTempDir(cwd));
  const capturePath = join(cwd, '.git', 'native-inputs.jsonl');
  const configurationPath = join(cwd, '.git', 'native-configuration.jsonl');
  const modelAccountPath = join(cwd, '.git', 'native-model-account.json');
  // The product denies path-only runtime names such as node. Give this external
  // native-provider fixture its own executable, as the ACP fixture does.
  const nativeExecutable = join(cwd, '.git', process.platform === 'win32' ? 'changes-native-agent.exe' : 'changes-native-agent');
  await copyFile(process.execPath, nativeExecutable);
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
    if (!input.includes(${JSON.stringify(firstInput)}) && !input.includes('Native captured change')) throw new Error('Native input lost the captured evidence');
    const output = input.includes(${JSON.stringify(firstInput)}) ? 'Native repository ready.'
      : JSON.stringify({ summaryMarkdown: (input.includes(${JSON.stringify(refinement)}) ? 'Refined' : 'Generated') + ': Native captured change.' });
    appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ input, inputIds, output, pid: process.pid }) + '\\n');
    process.stdout.write(output);`;
  await writeFile(join(cwd, repository.trackedPath), 'Native captured change\n');
  // The carrier and selected Run Agent are independent product choices. Use
  // the bundled ingress identity for the carrier and the authored Agent's
  // installed identity for comparison's real retained native runtime.
  const carrierTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
  const target = { kind: 'agent' as const, identity: { pluginId: 'acme.project-launch', localId: 'agent' } };
  const agent = createFirstConversationAgentFixture(firstInput, {
    nativeReply: { executableNames: [nativeExecutable], args: ['-e', program, '--'] },
  });
  // Observe the external Agent's actual Session configuration. Internal
  // comparison dispatch, Run admission and native Session creation stay real.
  agent.files['agent.mjs'] = `import { appendFileSync } from 'node:fs';\n${agent.files['agent.mjs']}`;
  for (const opening of ['async open(request, { services }) {', 'async openConversation(request, { services }) {', 'async open(request, context) {']) {
    agent.files['agent.mjs'] = agent.files['agent.mjs'].replace(opening, `${opening}
      appendFileSync(${JSON.stringify(configurationPath)}, JSON.stringify({ configuration: request.configuration }) + '\\n');`);
  }
  const manifest = PluginManifestV2Schema.parse(agent.manifest);
  const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
  const connectedServices = { v: 2, bindingsByServiceId: {
    'happier.agent.codex/openai-codex': { source: 'connected', selection: 'profile', profileId: 'changes-account' },
  } } as const;
  const fixture = await startInstalledDaemonFixture({ plugins: [{ ...agent, replaceExisting: true,
    manifest: { ...manifest, id: carrierTarget.identity.pluginId, contributes: { ...manifest.contributes,
      agents: manifest.contributes?.agents?.map(contribution => ({ ...contribution, id: carrierTarget.identity.localId })),
    } },
    files: { ...agent.files, 'daemon.mjs': agent.files['daemon.mjs'].replace("register('agent',", "register('claude',") },
  }, { ...agent,
    manifest: { ...manifest, contributes: { ...manifest.contributes,
      agents: manifest.contributes?.agents?.map(contribution => ({ ...contribution,
        id: target.identity.localId,
        capabilities: { ...contribution.capabilities,
          sessions: { ...contribution.capabilities?.sessions, workspaceWrites: 'deny' } },
        connectedAccounts: [{ purpose: 'native-catalog', service, credentialKinds: ['oauth'], materializationKinds: ['httpHeaders'] }],
      })),
    } },
    files: { ...agent.files,
      'daemon.mjs': `import { writeFileSync } from 'node:fs';\n` + agent.files['daemon.mjs'].replace('sessionRunnerFactory: {', `preflightSessionControls: {
      prepareLaunchEnvironment: async ({ environment, connectedAccounts }) => {
        const binding = await connectedAccounts.getBinding('native-catalog');
        if (binding?.account.accountId !== 'changes-account') throw Object.assign(new Error('Native catalog lost selected Account'), { code: 'fixture_native_account_missing' });
        return { environment: { ...environment, CHANGES_SELECTED_ACCOUNT: binding.account.accountId }, dispose() {} };
      },
      probeModels: context => {
        if (context.nonblankEnvironment.CHANGES_SELECTED_ACCOUNT !== true) throw Object.assign(new Error('Native catalog was not prepared'), { code: 'fixture_native_environment_missing' });
        writeFileSync(${JSON.stringify(modelAccountPath)}, JSON.stringify({ stage: 'probed', accountId: 'changes-account' }));
        return [{ id: 'default', name: 'Selected account native model',
          capabilities: { structuredOutput: 'supported', reasoningControls: 'supported' },
          modelOptions: [{ id: 'reasoning_effort', name: 'Thinking', type: 'select', currentValue: 'high',
            options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] }];
      },
    }, sessionRunnerFactory: {`) },
  }] });
  const owner = fixture.createActionExecutor();
  const context = { surface: 'ui' as const, externalActionTarget: { kind: 'machine' as const, machineId: fixture.machineId,
    project: { machineId: fixture.machineId, directory: cwd } } };
  const observations = async () => (await readFile(capturePath, 'utf8')).trim().split('\n')
    .map(line => nativeObservation.parse(JSON.parse(line)));
  const nativeConfigurations = async () => (await readFile(configurationPath, 'utf8')).trim().split('\n')
    .map(line => z.object({ configuration: z.optional(AgentSessionConfigurationSnapshotV1Schema) }).parse(JSON.parse(line)).configuration);
  const sessionConfigOptionOverrides = { v: 1 as const, updatedAt: 1,
    overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } } };
  try {
    const credential = buildConnectedServiceCredentialRecord({ now: Date.now(), serviceId: 'openai-codex',
      profileId: 'changes-account', kind: 'oauth', expiresAt: null, oauth: { accessToken: 'synthetic-changes-access',
        refreshToken: 'synthetic-changes-refresh', idToken: null, scope: null, tokenType: 'Bearer',
        providerAccountId: 'changes-account', providerEmail: null } });
    const connected = await fetch(`${fixture.home.baseUrl}/v4/connect/qualified/credential`, { method: 'POST',
      headers: { authorization: `Bearer ${fixture.home.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: { service, accountId: 'changes-account' }, authenticationModeId: 'oauth',
        expectedCredentialRevision: null, content: { t: 'plain', v: credential }, metadata: { scopes: [] } }),
    });
    expect(connected.status, await connected.text()).toBe(200);
    const verifyDetachedComparison = async () => {
      // A Changes page can generate without a carrier Session. Its selected
      // Connected Account still belongs to the requester at catalog admission.
      const detachedRequest = { cwd, source: { kind: 'workingTree' },
        modelSelector: { backendTargetKey: `backend:${target.identity.pluginId}/${target.identity.localId}`, modelId: 'default', connectedServices, sessionConfigOptionOverrides },
        outputs: ['summary'], cachePolicy: { mode: 'bypass' } };
      const detachedAction = await owner.execute('scm.diffSummary.generate', detachedRequest, context);
      expect(detachedAction).toMatchObject({ ok: true });
      if (!detachedAction.ok) throw new Error('Detached Changes Generate Action refused');
      const detached = ScmDiffSummaryGenerateOutputSchema.parse(detachedAction.result);
      expect(detached, JSON.stringify(detached)).toMatchObject({ success: true, runId: expect.any(String), resultId: expect.any(String) });
      const detachedOutput = await owner.execute('execution.run.get', { runId: detached.runId, includeStructured: true,
        waitForOutput: { kind: 'scm_diff_summary', comparisonId: detached.comparison?.id, resultId: detached.resultId,
          output: 'summary', afterRevision: 0 } }, context);
      expect(detachedOutput).toMatchObject({ ok: true });
      const detachedSaved = await owner.execute('scm.diffSummary.result.read', { cwd, resultId: detached.resultId }, context);
      expect(detachedSaved).toMatchObject({ ok: true, result: { success: true,
        result: { generator: { sessionConfigOptionOverrides },
          output: { outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Generated: Native captured change.' } } } } } } });
      expect((await nativeConfigurations()).at(-1)?.options.reasoning_effort?.value).toBe('low');
      if (!detachedSaved.ok) throw new Error('Detached saved output refused');
      const beforeRefine = ScmDiffSummaryResultResponseSchema.parse(detachedSaved.result);
      if (!beforeRefine.success) throw new Error('Detached saved result unavailable');
      const refined = await owner.execute('scm.diffSummary.refine', { cwd, resultId: detached.resultId,
        expectedRevision: beforeRefine.result.revision, output: 'summary', instructions: refinement },
      { ...context, actionRequestId: randomUUID() });
      expect(refined).toMatchObject({ ok: true, result: { success: true, runId: detached.runId } });
      const refinedOutput = await owner.execute('execution.run.get', { runId: detached.runId, includeStructured: true,
        waitForOutput: { kind: 'scm_diff_summary', comparisonId: detached.comparison?.id, resultId: detached.resultId,
          output: 'summary', afterRevision: beforeRefine.result.revision } }, context);
      expect(refinedOutput).toMatchObject({ ok: true });
      const refinedSaved = await owner.execute('scm.diffSummary.result.read', { cwd, resultId: detached.resultId }, context);
      expect(refinedSaved).toMatchObject({ ok: true, result: { success: true,
        result: { output: { outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Refined: Native captured change.' } } } } } } });
    };
    const birth = await owner.execute('session.spawn_new', projectSessionSpawnNewActionInputV2(SessionSpawnNewInputV2Schema.parse({
      creationKey: randomUUID(), executionTarget: { serverId: fixture.serverId, machineId: fixture.machineId },
      directory: { kind: 'path', path: cwd }, organizationPlacement: { folderId: null, tagIds: [] },
      agentTarget: carrierTarget, connectedServices: { v: 2, bindingsByServiceId: {} }, initialInput: { text: firstInput },
    })), context);
    expect(birth, JSON.stringify(birth)).toMatchObject({ ok: true });
    if (!birth.ok) throw new Error('Changes carrier Session creation refused');
    const created = SessionSpawnNewActionResultV1Schema.parse(birth.result);
    expect(created, JSON.stringify(created)).toMatchObject({ type: 'success', initialInput: { status: 'accepted' } });
    if (created.type !== 'success') throw new Error('Changes carrier Session did not start');
    const sessionId = created.sessionId;
    const idle = await owner.execute('session.wait.idle', { sessionId }, context);
    expect(idle).toMatchObject({ ok: true, result: { ok: true, idle: true, sessionId } });
    // Initial-input admission and its durable turn publication are asynchronous.
    // Observe the real Home boundary before inspecting the completed transcript.
    await expect.poll(async () => (await fixture.home.readWorkflowSessionEffects()).turns.map(turn => turn.status),
      { timeout: 30_000 }).toEqual(['completed']);
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
    expect(nativeInitial.map(row => row.input)).toEqual([expect.stringContaining(firstInput)]);
    if (created.initialInput?.status !== 'accepted') throw new Error('Carrier first input was not accepted');
    expect(nativeInitial[0]?.inputIds).toEqual([created.initialInput.localId]);

    const generatedAction = await owner.execute('scm.diffSummary.generate', { cwd, sessionId, source: { kind: 'workingTree' },
      // The installed native fixture uses the supported backend routing ref;
      // canonical external-Agent picker lowering is a separate ingress path.
      modelSelector: { backendTargetKey: `backend:${target.identity.pluginId}/${target.identity.localId}`, modelId: 'default', connectedServices, sessionConfigOptionOverrides }, outputs: ['summary'] }, context);
    expect(generatedAction).toMatchObject({ ok: true });
    if (!generatedAction.ok) throw new Error('Changes Generate Action refused');
    const generated = ScmDiffSummaryGenerateOutputSchema.parse(generatedAction.result);
    const nativeModelAccount = await readFile(modelAccountPath, 'utf8').catch(() => 'native model preparation was not reached');
    expect(generated, JSON.stringify({ generated, nativeModelAccount })).toMatchObject({ success: true, runId: expect.any(String), resultId: expect.any(String) });
    expect(JSON.parse(nativeModelAccount)).toEqual({ stage: 'probed', accountId: 'changes-account' });
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
    expect(saved.result.generator?.sessionConfigOptionOverrides).toEqual(sessionConfigOptionOverrides);
    const initialRun = await owner.execute('execution.run.get', { sessionId, runId: generated.runId, includeStructured: true }, context);
    expect(saved.result.output.outputs?.summary?.state,
      JSON.stringify({ saved: saved.result.output, run: initialRun, native: await observations() })).toBe('complete');
    expect(saved.result.output.outputs?.summary?.value?.summaryMarkdown).toBe('Generated: Native captured change.');
    const generatedNative = (await observations())[1]!;
    expect(generatedNative.inputIds).toEqual([generated.inputId]);
    expect(generatedNative.input).toContain('Native captured change');
    expect(generatedNative.input).not.toBe(generatedNative.output);
    expect(generatedNative.pid).not.toBe(process.pid);
    expect((await nativeConfigurations()).at(-1)?.options.reasoning_effort?.value).toBe('low');

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
    const persistedRefinement = z.object({ t: z.literal('plain'), v: z.object({
      content: z.object({ text: z.string() }),
    }) }).parse(refinedInput[0]?.content).v.content.text;
    expect(persistedRefinement).toContain(refinement);
    expect(native[2]?.input).toContain(persistedRefinement);

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
    expect(denied, JSON.stringify(denied)).toMatchObject({ ok: true,
      result: { success: false, errorCode: 'result_unavailable' } });
    expect(await observations()).toEqual(native);
    expect(await fixture.home.readWorkflowSessionEffects()).toEqual(effects);
    expect(await readSaved()).toEqual(latest);

    // One daemon runtime serves both placements; stopping it between cases
    // closes the process-wide plugin owner used by the next fixture.
    await verifyDetachedComparison();
    // Approval replay restores the original requester's custody. A deciding
    // invocation must not replace its native model reader with host credentials.
    const proposed = await owner.execute('approval.request.create', { actionId: 'scm.diffSummary.generate',
      actionArgs: { cwd, source: { kind: 'workingTree' },
      modelSelector: { backendTargetKey: `backend:${target.identity.pluginId}/${target.identity.localId}`, modelId: 'default', connectedServices },
      outputs: ['summary'], cachePolicy: { mode: 'bypass' } },
      summary: 'Generate the selected-account comparison.', createdBy: { surface: 'cli' } },
    { ...context, actionRequestId: randomUUID() });
    expect(proposed, JSON.stringify(proposed)).toMatchObject({ ok: true, result: { artifactId: expect.any(String) } });
    if (!proposed.ok) throw new Error('Comparison approval proposal refused');
    const { artifactId } = z.object({ artifactId: z.string() }).parse(proposed.result);
    const decided = await owner.execute('approval.request.decide', { artifactId, decision: 'approve' }, context);
    expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: {
      ok: true, result: { success: true, runId: expect.any(String), resultId: expect.any(String) },
    } } });
    if (!decided.ok) throw new Error('Comparison approval decision refused');
    const approved = z.object({ execution: z.object({ result: ScmDiffSummaryGenerateOutputSchema }) }).parse(decided.result).execution.result;
    await owner.execute('execution.run.get', { runId: approved.runId, includeStructured: true,
      waitForOutput: { kind: 'scm_diff_summary', comparisonId: approved.comparison?.id, resultId: approved.resultId,
        output: 'summary', afterRevision: 0 } }, context);
    const approvedSaved = await owner.execute('scm.diffSummary.result.read', { cwd, resultId: approved.resultId }, context);
    expect(approvedSaved).toMatchObject({ ok: true, result: { success: true,
      result: { output: { outputs: { summary: { state: 'complete', value: { summaryMarkdown: 'Generated: Native captured change.' } } } } } } });
  } finally {
    await fixture.stop();
  }
}, 240_000);
