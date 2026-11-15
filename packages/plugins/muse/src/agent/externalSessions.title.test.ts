import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createStablePluginExecService } from '@/plugins/runtime/invocation/services/exec';
import { buildHappierBaseSystemPromptV1 } from '@happier-dev/protocol/prompts/systemPromptBaseV1';
import { buildPromptPlanV1, renderSessionInputPromptPlanV1 } from '@happier-dev/protocol/prompts/promptPlanV1';
import { renderSessionInputContextPromptV1 } from '@happier-dev/protocol/sessions/messages/sessionInputPromptContextV1';
import { museExternalSessionsContribution } from './externalSessions.js';
import { readMuseRecord } from './events.js';
import { createMuseMspProcessFixture } from './testkit/mspProcess.js';

it('projects native prompt titles through the shared reader and preserves explicit native names', async () => {
  const bytes = await readFile(new URL('./testkit/fixtures/isolated-long-history-reopen.json.gz', import.meta.url));
  const recording = readMuseRecord(JSON.parse(gunzipSync(bytes).toString('utf8')));
  if (!Array.isArray(recording.rows)) throw new Error('Missing native recording');
  const response = readMuseRecord(readMuseRecord(recording.rows[4]).message);
  const result = readMuseRecord(response.result);
  if (!Array.isArray(result.sessions)) throw new Error('Missing native Sessions');
  const original = readMuseRecord(result.sessions[0]);
  const prompt = `${renderSessionInputPromptPlanV1(buildPromptPlanV1({ modality: 'coding', blocks: [
    { id: 'coding.base', scope: 'session', text: buildHappierBaseSystemPromptV1() },
  ] }))}\n\n${renderSessionInputContextPromptV1({
    inputProvenance: { v: 1, kind: 'host', producer: 'sessionAction' }, transformedUserText: 'Find the missing allowance',
  })}`;
  result.sessions = [
    { ...original, sessionId: 'automatic', title: prompt.slice(0, 120), firstUserPrompt: prompt },
    { ...original, sessionId: 'named', name: 'Chosen title', title: prompt, firstUserPrompt: prompt },
    { ...original, sessionId: 'ordinary', title: 'Ordinary native title', firstUserPrompt: 'Ordinary native title' },
  ];
  const { launch: _launch, ...boundary } = await createMuseMspProcessFixture({ recording,
    playbackSteps: [{ requestRow: 3, receiveUntilRow: 5 }] });
  const signal = new AbortController().signal;
  const exec = createStablePluginExecService({ signal, isOccurrenceCurrent: () => true, ...boundary });
  const listed = await museExternalSessionsContribution.listCandidates({ exec, signal, source: { kind: 'museNative' },
    maxItems: 7, maxSerializedBytes: 16 * 1024 * 1024 });
  expect(listed.ok ? listed.value.candidates.map(candidate => [candidate.remoteSessionId, candidate.title]) : listed)
    .toEqual([['automatic', 'Find the missing allowance'], ['named', 'Chosen title'], ['ordinary', 'Ordinary native title']]);
});
