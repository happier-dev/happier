import { expect, it, onTestFailed, vi } from 'vitest';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol';
import { hasExplicitlyEmptyManagedMcpSelection } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { readRetainedExecutionRunRecord } from '@/daemon/executionRunRegistry';
import { withAdmittedSessionRun } from '@/agent/runtime/bridges/executionRun/testkit/admittedSessionRun';
import { createMuseMspProcessFixture, MUSE_MSP_PLAYBACK_SCRIPT,
  readMuseMspProcessAudit, waitForMuseMspProcessAudit } from './testkit/mspProcess.js';

it.each([
  { kind: 'question', scenario: 'question-single-choice' },
  { kind: 'approval', scenario: 'approval-abort' },
] as const)('applies a retained Muse $kind through the real parent Action only after native ACK', async ({ kind, scenario }) => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-retained-muse-question-'));
  const bin = join(scratch, 'bin');
  const home = join(scratch, 'native-home');
  const auditPath = join(scratch, 'native-audit.json');
  const decisionAckPath = join(scratch, 'release-native-ack');
  const lifetime = new AbortController();
  let phase = 'fixture_start';
  onTestFailed(async () => {
    const nativeAudit = await readMuseMspProcessAudit(auditPath).then(audit => ({
      methods: audit.methods, initializeCount: audit.initializeCount,
      receiptCount: audit.receiptCount, decisionCount: audit.decisionCount, released: audit.released,
    }), () => ({ status: 'absent' }));
    console.error('Actual retained native boundary failure', { phase, nativeAudit });
  });
  try {
    await mkdir(bin);
    await mkdir(home);
    const native = await createMuseMspProcessFixture({ scenario, auditPath, decisionAckPath });
    const executable = await native.resolveExecutable();
    // The genuine executable lookup has only this shim in PATH. Its absolute
    // interpreter never falls through to an installed Muse or an owner Account.
    await writeFile(join(bin, 'muse'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('muse 1.4.14'); } else {
${MUSE_MSP_PLAYBACK_SCRIPT}
}
`, { mode: 0o755 });
    await withAdmittedSessionRun({
      runtimePluginIds: ['happier.agent.muse'],
      parentRuntime: true,
      parentCapabilitySelection: { mcp: { v: 1, managedServersEnabled: false, happierToolsEnabled: false,
        forceIncludeServerIds: [], forceExcludeServerIds: [] } },
      nativeToolEnvironment: { ...executable.env, PATH: bin, MUSE_INSTALL_DIR: bin,
        HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'), CODEX_HOME: join(home, 'codex') },
      async run(fixture) {
        let runId: string;
        const readCapabilityFacts = async (includeChild: boolean) => {
          const metadata = fixture.session.getMetadataSnapshot();
          const retained = includeChild ? await readRetainedExecutionRunRecord(runId) : null;
          return {
            parent: { mcpSelectionV1: metadata?.mcpSelectionV1 ?? null,
              skillSelectionV1: metadata?.skillSelectionV1 ?? null },
            // Exact canonical predicate consumed by composeRunToolBinding.
            parentManagedMcpExplicitlyEmpty: hasExplicitlyEmptyManagedMcpSelection(metadata),
            normalizedChildSelection: retained?.state.launch?.capabilitySelection ?? null,
          };
        };
        const beforeStart = await readCapabilityFacts(false);
        try {
          phase = 'run_start';
          const started = await fixture.start({ backendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.muse', localId: 'muse' } },
            instructions: 'Ask the captured native color question.', permissionMode: 'default',
            // This permission-only journey explicitly selects no managed MCP.
            capabilitySelection: { mcp: { managedServersEnabled: false, happierToolsEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
            retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming' });
          runId = started.runId;
        } catch (cause) {
          throw new Error(`Actual daemon boundary: ${JSON.stringify(fixture.daemonObservations)}`, { cause });
        }
        // START admits asynchronous provisioning. Observe its existing public
        // lifecycle too, so failed provisioning cannot wait for absent stdio.
        const observeRun = async () => {
          const observed = ExecutionRunGetResponseSchema.parse(await fixture.rpc.invokeLocal(
            SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId }, { verifiedPeerAuthority: 'present_user' }));
          if (observed.run.status !== 'running') {
            const nativeAudit = await readMuseMspProcessAudit(auditPath).then(audit => ({
              methods: audit.methods, initializeCount: audit.initializeCount,
              receiptCount: audit.receiptCount, decisionCount: audit.decisionCount,
            }), () => ({ status: 'absent' }));
            lifetime.abort(new Error(`Actual retained native startup: ${JSON.stringify({ status: observed.run.status,
              error: observed.run.error, daemon: fixture.daemonObservations,
              home: fixture.readHomeBoundary(), nativeAudit,
              beforeStart, atFailure: await readCapabilityFacts(true) })}`));
          }
        };
        const stopObserving = fixture.session.subscribeExecutionRunActivitySnapshots(() => {
          void observeRun().catch(error => lifetime.abort(error));
        });
        try {
          await observeRun();
          phase = 'native_receipt';
          expect(await waitForMuseMspProcessAudit(auditPath, audit => audit.nativeResponseCount > 0,
            { signal: lifetime.signal })).toMatchObject({ receiptCount: 1, decisionCount: 0, released: false });
          stopObserving();
          phase = 'parent_interaction';
          let requestId: string | undefined;
          await vi.waitFor(() => {
            const pending = Object.entries(fixture.session.getAgentStateSnapshot()?.requests ?? {})
              .find(([, value]) => kind === 'question' ? value.tool === 'AskUserQuestion' : value.nativeChoices?.source === 'muse');
            expect(pending?.[1]).toMatchObject(kind === 'question' ? { kind: 'user_action', arguments: { questions: [
              { id: 'color', question: 'Which color do you prefer?', selection: 'single',
                options: [{ label: 'Blue' }, { label: 'Green' }] },
            ] } } : { kind: 'permission', nativeChoices: { choices: [
              { id: 'allow_once', decision: 'approved', scope: 'once' },
              { id: 'abort', decision: 'abort', scope: 'once' },
            ] } });
            requestId = pending?.[0];
          });
          if (!requestId) throw new Error('Expected the real parent pending question occurrence');
          const pending = fixture.session.getAgentStateSnapshot()?.requests?.[requestId];
          const answer = (note?: string) => fixture.session.rpcHandlerManager.handleRequest({
            method: `${fixture.session.sessionId}:${kind === 'question' ? RPC_METHODS.SESSION_USER_ACTION_ANSWER : RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
            params: kind === 'question' ? { id: requestId, approved: true, answers: { color: ['Blue'] },
              ...(note ? { answerDetails: { color: { note } } } : {}) } : {
              id: requestId, ...(pending?.turnId ? { turnId: pending.turnId } : {}), approved: false, decision: 'abort', nativeChoice: {
                requirementId: pending?.nativeChoices?.requirementId, choiceId: 'abort' },
            },
            callerAuthority: 'present_user',
            authorization: { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
              sessionId: fixture.session.sessionId,
              actor: { kind: 'accountUser', accountId: 'alice', relationship: 'owner' } },
          }, undefined, 'authenticated_home_socket');
          // Schema-derived overlong note reaches native application. Its refusal
          // must not report host success, complete the record, or release effects.
          if (kind === 'question') {
            phase = 'native_refusal';
            expect(await answer('x'.repeat(501))).toMatchObject({ error: expect.any(String) });
            expect(await readMuseMspProcessAudit(auditPath)).toMatchObject({ decisionCount: 0, released: false });
            expect(fixture.session.getAgentStateSnapshot()?.requests?.[requestId]).toBeDefined();
            expect(fixture.session.getAgentStateSnapshot()?.completedRequests?.[requestId]).toBeUndefined();
          }
          phase = 'native_ack_held';
          let answered = false;
          const application = answer().then(result => { answered = true; return result; });
          await Promise.race([
            waitForMuseMspProcessAudit(auditPath, audit => audit.decisionAckPending, { signal: lifetime.signal }),
            application.then(result => { throw new Error(`Parent Action returned before the native acknowledgement gate: ${JSON.stringify(result)}`); }),
          ]);
          // Synthetic ACK ordering retains captured native settlement/effects.
          // Give the actual pipe receiver its normal event-loop turn before
          // checking that observed settlement cannot finish the parent Action.
          await new Promise<void>(resolve => setImmediate(resolve));
          expect(answered).toBe(false);
          expect(fixture.session.getAgentStateSnapshot()?.requests?.[requestId]).toBeDefined();
          expect(fixture.session.getAgentStateSnapshot()?.completedRequests?.[requestId]).toBeUndefined();
          await writeFile(decisionAckPath + '.complete', 'release');
          await rename(decisionAckPath + '.complete', decisionAckPath);
          phase = 'native_answer';
          expect(await application).toBeUndefined();
          expect(await readMuseMspProcessAudit(auditPath)).toMatchObject({ decisionCount: 1, released: true });
          expect(fixture.session.getAgentStateSnapshot()?.requests?.[requestId]).toBeUndefined();
          expect(fixture.session.getAgentStateSnapshot()?.completedRequests?.[requestId]).toMatchObject({
            decision: kind === 'question' ? 'approved' : 'abort',
            ...(kind === 'question' ? { answeredBy: { kind: 'person', accountId: 'alice' }, structuredAnswersV1: { color: ['Blue'] } } : {
              permissionDecisionActorV1: { kind: 'accountUser', accountId: 'alice', relationship: 'owner' },
              nativeChoice: { requirementId: pending?.nativeChoices?.requirementId, choiceId: 'abort' },
            }),
          });
        } finally { stopObserving(); }
      },
    });
    const audit = await readMuseMspProcessAudit(auditPath);
    expect(audit).toMatchObject({ initializeCount: 1, initializedCount: 1, decisionCount: 1 });
    expect(audit.methods.filter(method => method === 'session/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(audit.methods.filter(method => method === (kind === 'question' ? 'userInput/answer' : 'approval/decide')))
      .toHaveLength(kind === 'question' ? 2 : 1);
    expect(audit.decisionAckPending).toBe(false);
  } finally {
    lifetime.abort();
    await rm(scratch, { recursive: true, force: true });
  }
});
