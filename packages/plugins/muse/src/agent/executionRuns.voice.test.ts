import { expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/socketRpc';
import { withAdmittedSessionRun } from '@/agent/runtime/bridges/executionRun/testkit/admittedSessionRun';
import { createMuseMspProcessFixture, MUSE_MSP_PLAYBACK_SCRIPT,
  readMuseMspProcessAudit, waitForMuseMspProcessAudit } from './testkit/mspProcess.js';

it('keeps the post-approval reply in Voice turn_final when native reminder children follow it', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'happier-muse-voice-reply-'));
  const lifetime = new AbortController();
  try {
    const bin = join(scratch, 'bin');
    const home = join(scratch, 'home');
    await mkdir(bin);
    await mkdir(home);
    const auditPath = join(scratch, 'audit.json');
    const native = await createMuseMspProcessFixture({ scenario: 'approval-allow-once', auditPath });
    const executable = await native.resolveExecutable();
    // Only the external Muse process is substituted. Its captured order is
    // approval -> native tool result -> DONE -> reminder children -> terminal.
    await writeFile(join(bin, 'muse'), `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('muse 1.4.14'); } else {
${MUSE_MSP_PLAYBACK_SCRIPT}
}
`, { mode: 0o755 });
    await withAdmittedSessionRun({
      directOwner: true, parentRuntime: true, runtimePluginIds: ['happier.agent.muse'],
      parentCapabilitySelection: { mcp: { v: 1, managedServersEnabled: false, happierToolsEnabled: false,
        forceIncludeServerIds: [], forceExcludeServerIds: [] } },
      nativeToolEnvironment: { ...executable.env, PATH: bin, MUSE_INSTALL_DIR: bin,
        HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
        XDG_CACHE_HOME: join(home, 'cache'), CODEX_HOME: join(home, 'codex') },
      async run(fixture) {
        const bridge = fixture.bridge!;
        const { runId } = await fixture.start({
          intent: 'voice_agent', backendTarget: { kind: 'builtInAgent', agentId: 'muse' },
          instructions: '', permissionMode: 'default', chatModelId: 'default', commitModelId: 'default',
          bootstrapMode: 'none', retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'streaming',
          capabilitySelection: { mcp: { managedServersEnabled: false, happierToolsEnabled: false,
            forceIncludeServerIds: [], forceExcludeServerIds: [] } },
        });
        try {
          const startedRun = bridge.get(runId);
          if (startedRun?.status !== 'running') {
            const audit = await readMuseMspProcessAudit(auditPath).catch(() => null);
            throw new Error(`Actual Voice startup: ${JSON.stringify({ status: startedRun?.status,
              error: startedRun?.error, nativeMethods: audit?.methods })}`);
          }
          const stream = await bridge.startTurnStream(runId, { message: 'Run the captured approval operation.' });
          if (!stream.ok) throw new Error(`${stream.errorCode}: ${stream.error}`);
          const received = await waitForMuseMspProcessAudit(auditPath, audit => audit.nativeResponseCount > 0, { signal: lifetime.signal });
          expect(received).toMatchObject({ receiptCount: 1, decisionCount: 0, released: false });
          const [requestId, request] = await vi.waitFor(() => {
            const pending = Object.entries(fixture.session.getAgentStateSnapshot()?.requests ?? {})
              .find(([, value]) => value.nativeChoices?.source === 'muse');
            const state = fixture.session.getAgentStateSnapshot();
            expect(pending, JSON.stringify({
              requests: Object.entries(state?.requests ?? {}).map(([id, request]) => ({ id, tool: request.tool, source: request.nativeChoices?.source })),
              completed: Object.entries(state?.completedRequests ?? {}).map(([id, request]) => ({ id, decision: request.decision })),
              run: bridge.get(runId)?.status,
            })).toBeDefined();
            return pending!;
          });
          expect(await fixture.session.rpcHandlerManager.handleRequest({
            method: `${fixture.session.sessionId}:${RPC_METHODS.SESSION_PERMISSION_RESPOND}`,
            params: { id: requestId, approved: true, decision: 'approved',
              ...(request.turnId ? { turnId: request.turnId } : {}),
              nativeChoice: { requirementId: request.nativeChoices!.requirementId, choiceId: 'allow_once' } },
            callerAuthority: 'present_user', authorization: { kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_PERMISSION_RESPOND,
              sessionId: fixture.session.sessionId, actor: { kind: 'accountUser', accountId: 'alice', relationship: 'owner' } },
          }, undefined, 'authenticated_home_socket')).toBeUndefined();
          let cursor = 0;
          let finalText: string | undefined;
          for (;;) {
            const page = await bridge.readTurnStream(runId, { streamId: stream.streamId, cursor,
              waitForEvents: true, signal: lifetime.signal });
            if (!page.ok) throw new Error(`${page.errorCode}: ${page.error}`);
            expect(page.events.filter(event => event.t === 'error' || event.t === 'cancelled')).toEqual([]);
            for (const event of page.events) {
              if (event.t === 'voice_output' && event.output.kind === 'turn_final') finalText = event.output.text;
            }
            cursor = page.nextCursor;
            if (page.done) break;
          }
          expect(await readMuseMspProcessAudit(auditPath)).toMatchObject({ decisionCount: 1, released: true });
          expect(finalText).toBe('DONE');
        } finally { await bridge.stop(runId); }
      },
    });
  } finally {
    lifetime.abort();
    await rm(scratch, { recursive: true, force: true });
  }
});
