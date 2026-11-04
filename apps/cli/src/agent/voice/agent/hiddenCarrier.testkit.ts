import { basename } from 'node:path';
import { createFirstConversationAgentFixture } from '@/daemon/testkit/firstConversationAgent.testkit';

/** External native Agent program for the hidden-carrier source composition.
 * Git computes the answer in a real admitted process. The program checks the
 * exact Voice user text and reports native open evidence with that answer. */
export function createHiddenCarrierAgentFixture(userText: string, options: Readonly<{ nativeStorePath: string }>) {
  const nativeReply = { executableNames: [basename(process.execPath)], args: ['--input-type=module', '-e', `
      import { spawnSync } from 'node:child_process';
      import { readFileSync, renameSync, writeFileSync } from 'node:fs';
      const storePath = process.argv[1];
      const open = JSON.parse(process.argv[2]);
      const inputIds = JSON.parse(process.argv[3]);
      const prompt = process.argv[4];
      if (!Array.isArray(inputIds) || inputIds.length !== 1 || typeof inputIds[0] !== 'string') {
        throw new Error('Native Voice input lost its single custody identity');
      }
      if (!prompt.endsWith(${JSON.stringify(`User: ${userText}\nVoice agent:`)})) {
        throw new Error('Native Voice did not receive the exact authored user input');
      }
      if (!['create', 'resume'].includes(open.kind)
          || open.providerSessionId !== 'voice-canary-native-conversation' || !open.openId) {
        throw new Error('Native Voice open identity was not retained');
      }
      let stored;
      try { stored = JSON.parse(readFileSync(storePath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (open.kind === 'resume' && (!stored?.turns.length || stored.providerSessionId !== open.providerSessionId)) {
        throw new Error('Native resume did not load its original conversation');
      }
      if (!stored) stored = { providerSessionId: open.providerSessionId, opens: [], turns: [] };
      if (stored.turns.some(turn => turn.inputIds.some(id => inputIds.includes(id)))) throw new Error('Native input was sent twice');
      if (!stored.opens.some(item => item.openId === open.openId)) {
        if (open.kind === 'create' && stored.opens.length) throw new Error('A retained conversation was created twice');
        stored.opens.push({ ...open, createdAtMs: Date.now() });
      }
      const reply = spawnSync('git', ['--version'], { encoding: 'utf8' });
      if (reply.status !== 0) throw new Error('Native Git response failed');
      const assistantText = JSON.stringify({ nativeOpen: open, inputIds, nativeHistoryTurns: stored.turns.length,
        answer: reply.stdout.trim() });
      stored.turns.push({ inputIds, prompt, assistantText, createdAtMs: Date.now() });
      writeFileSync(storePath + '.writing', JSON.stringify(stored));
      renameSync(storePath + '.writing', storePath);
      process.stdout.write(assistantText);
    `, options.nativeStorePath] };
  const fixture = createFirstConversationAgentFixture(userText, {
    nativeSession: { providerSessionId: 'voice-canary-native-conversation', storePath: options.nativeStorePath,
      externalSessionsExport: 'externalSessions' }, nativeReply,
  });
  const manifest = { ...fixture.manifest, contributes: { ...fixture.manifest.contributes,
    agents: fixture.manifest.contributes?.agents?.map(agent => ({ ...agent,
      surfaces: { externalSession: { sources: [{ sourceKind: 'voiceCanaryNativeStore',
        schema: { fields: [{ name: 'kind', kind: 'literal' as const, value: 'voiceCanaryNativeStore' }] },
        key: { segments: [{ kind: 'literal' as const, value: 'voiceCanaryNativeStore' }] },
        instances: [{ kind: 'default' as const, constants: {} }],
      }] } },
    })),
  } };
  return { ...fixture, manifest, nativeProgram: { executable: process.execPath, args: nativeReply.args },
    files: { ...fixture.files, 'agent.mjs': fixture.files['agent.mjs'] + `
    const nativeStorePath = ${JSON.stringify(options.nativeStorePath)};
    async function readNativeStore() {
      try { return JSON.parse(await readFile(nativeStorePath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    const source = Object.freeze({ kind: 'voiceCanaryNativeStore' });
    const ok = value => ({ ok: true, value });
    function transcriptItems(stored) {
      return (stored?.turns ?? []).flatMap((turn, index) => [
        { id: 'user-' + index, localId: turn.inputIds[0], createdAtMs: turn.createdAtMs,
          messageRole: 'user', userProjection: 'source_fact', raw: { role: 'user', content: { type: 'text', text: turn.prompt } } },
        { id: 'assistant-' + index, createdAtMs: turn.createdAtMs, messageRole: 'agent',
          raw: { role: 'agent', content: { type: 'acp', agentId: 'acme.project-launch/agents/agent',
            data: { type: 'message', message: turn.assistantText } } } },
      ]);
    }
    async function identity(request) {
      request.signal.throwIfAborted();
      const stored = await readNativeStore();
      // A newly opened provider conversation has no transcript until its
      // first accepted native input. Its already-published identity is exact.
      const providerSessionId = stored?.providerSessionId ?? 'voice-canary-native-conversation';
      return request.remoteSessionId === providerSessionId
        ? ok({ source, remoteSessionId: providerSessionId, linkData: {} })
        : { ok: false, code: 'candidate_not_found', message: 'The native conversation is not present' };
    }
    export const externalSessions = Object.freeze({
      async resolveSource(request) { request.signal.throwIfAborted(); return ok({ source }); },
      async listCandidates(request) {
        request.signal.throwIfAborted();
        const stored = await readNativeStore();
        return ok({ candidates: stored ? [{ remoteSessionId: stored.providerSessionId,
          updatedAtMs: stored.turns.at(-1)?.createdAtMs ?? 0, linkData: {} }] : [], nextCursor: null });
      },
      resolveLinkIdentity: identity, resolveLinkedIdentity: identity,
      async pageTranscript(request) {
        const resolved = await identity(request);
        if (!resolved.ok) return resolved;
        const items = transcriptItems(await readNativeStore());
        const cursor = request.cursor == null ? (request.direction === 'older' ? items.length : 0) : Number(request.cursor);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > items.length) return { ok: false, code: 'invalid_request', message: 'Native transcript cursor is invalid' };
        const start = request.direction === 'older' ? Math.max(0, cursor - request.maxItems) : cursor;
        const end = request.direction === 'older' ? cursor : Math.min(items.length, cursor + request.maxItems);
        const hasMore = request.direction === 'older' ? start > 0 : end < items.length;
        return ok({ items: items.slice(start, end), nextCursor: hasMore ? String(request.direction === 'older' ? start : end) : null,
          tailCursor: String(items.length), hasMore });
      },
      async readAfterTranscript(request) {
        const resolved = await identity(request);
        if (!resolved.ok) return resolved;
        const items = transcriptItems(await readNativeStore());
        const cursor = Number(request.cursor);
        if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > items.length) return ok({ outcome: 'gap_or_cursor_expired' });
        if (cursor === items.length) return ok({ outcome: 'already_current' });
        const page = items.slice(cursor, cursor + request.maxItems);
        const nextCursor = cursor + page.length;
        return ok({ outcome: 'advanced', items: page, nextCursor: String(nextCursor), boundary: String(items.length), hasMore: nextCursor < items.length });
      },
    });
  ` } };
}
