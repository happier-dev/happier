import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { configuration } from '@/configuration';
import { deliverExternalActionRequest } from './externalActionExecutionAuthorization';

const originalBudget = configuration.sessionControlHttpTimeoutMs;
afterEach(() => Object.assign(configuration, { sessionControlHttpTimeoutMs: originalBudget }));

it.each(['silent', 'streaming'] as const)('settles a %s Saved Secret response at the existing CLI HTTP deadline without replaying', async mode => {
  Object.assign(configuration, { sessionControlHttpTimeoutMs: 1_000 });
  let requests = 0;
  const intervals: ReturnType<typeof setInterval>[] = [];
  const server = createServer((_request, response) => {
    requests++;
    if (mode === 'streaming') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write(' ');
      intervals.push(setInterval(() => response.write(' '), 100));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const caller = new AbortController();
  const envelope = { v: 1 as const, requestId: 'secret-create-timeout',
    target: { kind: 'machine' as const, machineId: 'fixture-machine' }, input: {} };
  let observation: ReturnType<typeof setTimeout> | undefined;
  const pending = deliverExternalActionRequest({ actionId: 'secrets.create',
    serverHttpBaseUrl: `http://127.0.0.1:${address.port}`, headers: {}, body: envelope, envelope,
    signal: caller.signal, isCurrent: async () => true });
  try {
    const result = await Promise.race([pending, new Promise<'still_pending'>(resolve => {
      observation = setTimeout(() => resolve('still_pending'), 1_700);
    })]);
    expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
      details: { category: 'transport_timeout' } });
    expect(requests).toBe(1);
    expect(caller.signal.aborted).toBe(false);
  } finally {
    if (observation) clearTimeout(observation);
    caller.abort();
    await pending;
    for (const interval of intervals) clearInterval(interval);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each([
  { actionId: 'secrets.create', delay: 800 },
  { actionId: 'workflow.run.start', delay: 1_200 },
])('preserves a successful $actionId response after $delay ms', async ({ actionId, delay }) => {
  Object.assign(configuration, { sessionControlHttpTimeoutMs: 1_000 });
  const envelope = { v: 1 as const, requestId: 'successful-delivery', input: {} };
  let completion: ReturnType<typeof setTimeout> | undefined;
  const server = createServer((_request, response) => {
    completion = setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ v: 1, actionId, requestId: envelope.requestId,
        execution: { ok: true, result: { delivered: true } } }));
    }, delay);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  try {
    const result = await deliverExternalActionRequest({ actionId,
      serverHttpBaseUrl: `http://127.0.0.1:${address.port}`, headers: {}, body: envelope, envelope,
      isCurrent: async () => true });
    expect(result).toEqual({ ok: true, result: { delivered: true } });
  } finally {
    if (completion) clearTimeout(completion);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it('preserves caller cancellation without reporting the delivery deadline', async () => {
  Object.assign(configuration, { sessionControlHttpTimeoutMs: 1_000 });
  const caller = new AbortController();
  const server = createServer(() => caller.abort());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const envelope = { v: 1 as const, requestId: 'cancelled-delivery', input: {} };
  try {
    const result = await deliverExternalActionRequest({ actionId: 'secrets.create',
      serverHttpBaseUrl: `http://127.0.0.1:${address.port}`, headers: {}, body: envelope, envelope,
      signal: caller.signal, isCurrent: async () => true });
    expect(result).toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
  } finally {
    caller.abort();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
