import { expect, it } from 'vitest';
import { createOpenCodeExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';
import type { AgentExternalSessionsManagedEndpointRead } from '@happier-dev/plugin-sdk/sessions/external';

it('uses retained assistant API accounting once, including paid compaction, without part-summary duplication', async () => {
  let completed = 200;
  const managedEndpointRead: AgentExternalSessionsManagedEndpointRead = async ({ pathAndQuery }) => {
    const path = new URL(pathAndQuery, 'http://test').pathname;
    const response = path === '/api/info' ? new Response('Not Found', { status: 404 })
      : new Response(JSON.stringify(path === '/global/health' ? { healthy: true, version: '1.2.20' }
        : path === '/experimental/session' || path === '/session' ? [{ id: 'oc-session', directory: '/native/opencode-project', time: { updated: 100 } }]
        : path === '/session/oc-session' ? { id: 'oc-session', directory: '/native/opencode-project', time: { updated: 100 } }
        : path === '/session/oc-session/message' ? [{ info: { id: 'oc-paid', sessionID: 'oc-session', role: 'assistant', modelID: 'model', cost: 0.25,
          time: { created: 100, completed }, tokens: { input: 10, output: completed === 200 ? 5 : 6, reasoning: 2, cache: { read: 3, write: 4 } }, summary: true },
          parts: [{ type: 'step-finish', cost: 0.25, tokens: { input: 10, output: 5 } }] }] : []), { headers: { 'content-type': 'application/json' } });
    return { ok: response.ok, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: response.body };
  };
  const request = { source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' }, signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 30_000, maxSerializedBytes: 100_000, managedEndpointRead };
  const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
  const result = await contribution.readAccounting?.(request);
  expect(result).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [{ nativeSessionId: 'oc-session', inferenceId: 'oc-paid',
    project: { rootPath: '/native/opencode-project' },
    observation: { cost: { estimatedUsd: 0.25, costSource: 'pricing_estimate' }, tokens: { total: 22, input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 4 } } }] } });
  if (!result?.ok || result.value.outcome !== 'advanced') return;
  expect(await contribution.readAccounting?.({ ...request, cursor: result.value.nextCursor, changedNativeSessionIds: [] })).toEqual({ ok: true, value: { outcome: 'unchanged' } });
  completed = 201;
  expect(await contribution.readAccounting?.({ ...request, cursor: result.value.nextCursor, changedNativeSessionIds: ['oc-session'] })).toMatchObject({ ok: true, value: {
    outcome: 'advanced', observations: [{ inferenceId: 'oc-paid', observation: { tokens: { output: 6 } } }],
  } });
});

it('reads only a changed Session among retained histories and no messages for an unchanged frontier', async () => {
  const sessions = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, time: { updated: 100 } }));
  let output = 5;
  let bytes = 0;
  const reads: string[] = [];
  const managedEndpointRead: AgentExternalSessionsManagedEndpointRead = async ({ pathAndQuery }) => {
    const path = new URL(pathAndQuery, 'http://test').pathname;
    const match = path.match(/^\/session\/(s\d+)\/message$/);
    const session = path.match(/^\/session\/(s\d+)$/);
    const value = path === '/global/health' ? { healthy: true, version: '1.2.20' }
      : session ? sessions.find(item => item.id === session[1])
      : match ? Array.from({ length: 30 }, (_, i) => ({ info: { id: `${match[1]}-m${i}`, sessionID: match[1], role: 'assistant', modelID: 'model',
        time: { created: 100, completed: 200 }, tokens: { input: 10, output: match[1] === 's7' && i === 29 ? output : 5,
          reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ type: 'text', text: 'private vendor content' }] })) : sessions;
    const body = JSON.stringify(value);
    if (match) { reads.push(match[1]); bytes += Buffer.byteLength(body); }
    const response = path === '/api/info' ? new Response('Not Found', { status: 404 }) : new Response(body);
    return { ok: response.ok, status: response.status, statusText: response.statusText, headers: {}, body: response.body };
  };
  const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
  const request = { source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' }, signal: new AbortController().signal, managedEndpointRead };
  const first = await contribution.readAccounting!(request);
  expect(first).toMatchObject({ ok: true, value: { outcome: 'advanced' } });
  if (!first.ok || first.value.outcome !== 'advanced') throw new Error('Initial capture failed');
  expect(first.value.observations).toHaveLength(600);
  const initialBytes = bytes;
  reads.length = 0; bytes = 0;
  expect(await contribution.readAccounting!({ ...request, cursor: first.value.nextCursor, changedNativeSessionIds: [] }))
    .toEqual({ ok: true, value: { outcome: 'unchanged' } });
  expect({ reads, bytes }).toEqual({ reads: [], bytes: 0 });
  output = 6;
  const settled = await contribution.readAccounting!({ ...request, cursor: first.value.nextCursor, changedNativeSessionIds: ['s7'] });
  expect(settled).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [{ nativeSessionId: 's7', inferenceId: 's7-m29',
    observation: { tokens: { input: 10, output: 6, total: 16 } } }] } });
  if (!settled.ok || settled.value.outcome !== 'advanced') throw new Error('Settlement failed');
  expect(settled.value.observations).toHaveLength(1);
  expect(reads).toEqual(['s7']);
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(initialBytes / 10);
  // The coarse reconnect path still reconciles the full source.
  reads.length = 0; bytes = 0;
  expect(await contribution.readAccounting!({ ...request, cursor: settled.value.nextCursor })).toEqual({ ok: true, value: { outcome: 'unchanged' } });
  expect(reads).toHaveLength(20);
  expect(bytes).toBe(initialBytes);
});

it('retains V2 paid compaction and disjoint reasoning through the shared wire normalization', async () => {
  let output = 5;
  const messageReads: string[] = [];
  const managedEndpointRead: AgentExternalSessionsManagedEndpointRead = async ({ pathAndQuery }) => {
    const path = new URL(pathAndQuery, 'http://test').pathname;
    const value = path === '/api/info' ? { version: '2.0.15', pid: 1, urls: [], paths: {} }
      : path === '/api/session' ? { data: [{ id: 'v2-session', time: { updated: 100 } }] }
      : path === '/api/session/v2-session' ? { data: { id: 'v2-session', time: { updated: 100 } } }
      : path === '/api/session/v2-session/message' ? { data: [{ id: 'v2-compaction', type: 'compaction', status: 'completed',
        model: { providerID: 'p', modelID: 'm' }, time: { created: 200 }, cost: 0.2,
        tokens: { input: 10, output, reasoning: 2, cache: { read: 3, write: 4 } }, summary: 'PRIVATE' }] } : {};
    if (path.endsWith('/message')) messageReads.push(path);
    const response = new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    return { ok: true, status: 200, statusText: 'OK', headers: {}, body: response.body };
  };
  const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
  const request = { source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096' },
    signal: new AbortController().signal, managedEndpointRead };
  const result = await contribution.readAccounting?.(request);
  expect(result).toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [{ inferenceId: 'v2-compaction',
    accounting: { outputIncludesReasoning: false, inputIncludesCache: false },
    observation: { modelId: 'm', tokens: { total: 24, output: 5, reasoning: 2 }, cost: { estimatedUsd: 0.2 } } }] } });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  if (!result?.ok || result.value.outcome !== 'advanced') throw new Error('Initial V2 capture failed');
  messageReads.length = 0;
  output = 6;
  expect(await contribution.readAccounting!({ ...request, cursor: result.value.nextCursor, changedNativeSessionIds: ['v2-session'] }))
    .toMatchObject({ ok: true, value: { outcome: 'advanced', observations: [{ inferenceId: 'v2-compaction', observation: { tokens: { output: 6, total: 25 } } }] } });
  expect(messageReads).toEqual(['/api/session/v2-session/message']);
});

it('does not read messages outside a consented directory on a shared endpoint invalidation', async () => {
  const messageReads: string[] = [];
  const managedEndpointRead: AgentExternalSessionsManagedEndpointRead = async ({ pathAndQuery }) => {
    const path = new URL(pathAndQuery, 'http://test').pathname;
    const value = path === '/global/health' ? { healthy: true, version: '1.2.20' }
      : path === '/experimental/session' || path === '/session' ? [{ id: 'included', directory: '/included', time: { updated: 100 } }]
      : path === '/session/foreign' ? { id: 'foreign', directory: '/other', time: { updated: 100 } } : [];
    if (path.endsWith('/message')) messageReads.push(path);
    const response = path === '/api/info' ? new Response('Not Found', { status: 404 }) : new Response(JSON.stringify(value));
    return { ok: response.ok, status: response.status, statusText: response.statusText, headers: {}, body: response.body };
  };
  const contribution = createOpenCodeExternalSessionsContribution({ env: {} });
  const request = { source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096', directory: '/included' },
    signal: new AbortController().signal, managedEndpointRead };
  const first = await contribution.readAccounting!(request);
  if (!first.ok || first.value.outcome !== 'advanced') throw new Error('Initial directory capture failed');
  messageReads.length = 0;
  expect(await contribution.readAccounting!({ ...request, cursor: first.value.nextCursor, changedNativeSessionIds: ['foreign'] }))
    .toEqual({ ok: true, value: { outcome: 'unchanged' } });
  expect(messageReads).toEqual([]);
});
