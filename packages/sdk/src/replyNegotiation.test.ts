import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { actionSpecToActionDefinitionV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { connect } from './index.public.js';

const token = 'hap_v1_123e4567-e89b-42d3-a456-426614174000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function serve(
  inputSchema?: Readonly<Record<string, unknown>>,
  onDiscovery?: () => Promise<void>,
  sections?: Readonly<Record<string, object>>,
) {
  const calls: Array<Readonly<{ actionId: string; input: Record<string, unknown>; target?: unknown }>> = [];
  const definition = actionSpecToActionDefinitionV1(getActionSpec('session.message.send'), { surface: 'api', includeOutputSchema: false });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const actionId = decodeURIComponent(request.url?.split('/').at(-1) ?? '');
    calls.push({ actionId, input: body.input, target: body.target });
    if (actionId === 'action.spec.get') await onDiscovery?.();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ v: 1, actionId, requestId: body.requestId, execution: { ok: true,
      result: actionId === 'action.spec.get'
        ? { actionSpec: { ...definition, ...(inputSchema ? { inputSchema } : {}) },
          ...(sections ? body.input.schemaPath
            ? { schemaSection: { path: body.input.schemaPath, schema: sections[body.input.schemaPath] } }
            : { schemaSections: Object.keys(sections).map(path => ({ path, description: 'Shared reply grammar' })) } : {}) }
        : { status: 'accepted', localId: 'request-input' },
    } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return { calls, endpoint: `http://127.0.0.1:${address.port}`, close: async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

describe('Session reply negotiation through public HTTP', () => {
  it('reads a sectioned advertised schema before admitting a supported reply', async () => {
    const server = await serve({ type: 'object', properties: {
      sessionId: { type: 'string' }, message: { type: 'string' }, reply: { $ref: '#/definitions/Reply' },
    }, additionalProperties: false }, undefined, {
      '/inputSchema/definitions/Reply': { enum: ['none', 'wait', 'return'] },
    });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.sessions.get('worker').sendAndWait('Inspect it.')).resolves.toMatchObject({ status: 'accepted' });
      expect(server.calls.map(call => call.actionId)).toEqual(['action.spec.get', 'action.spec.get', 'session.message.send']);
      expect(server.calls[1]?.input.schemaPath).toBe('/inputSchema/definitions/Reply');
    } finally { await client.close(); await server.close(); }
  });

  it.each([
    // The inspected predecessor at b19d549e0d1f8f2540be1beaef956cc8141e9b30
    // has a passthrough send object with boolean wait and no reply field.
    { type: 'object', properties: { sessionId: { type: 'string' }, message: { type: 'string' }, wait: { type: 'boolean' } }, additionalProperties: true },
    { type: 'object', properties: { sessionId: { type: 'string' }, message: { type: 'string' }, reply: { enum: ['none'] } }, additionalProperties: true },
  ])('refuses unsupported reply semantics before a fluent send', async inputSchema => {
    const server = await serve(inputSchema);
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.machine('machine-1').sessions.get('session-1').sendAndWait('Inspect the failure.'))
        .rejects.toMatchObject({ name: 'HappierActionError', code: 'unsupported' });
      expect(server.calls).toEqual([{ actionId: 'action.spec.get',
        input: { id: 'session.message.send', includeOutputSchema: false }, target: { kind: 'machine', machineId: 'machine-1' } }]);
    } finally { await client.close(); await server.close(); }
  });

  it('refuses an undeclared human return destination even when reply itself is recognized', async () => {
    const server = await serve({ type: 'object', properties: {
      sessionId: { type: 'string' }, message: { type: 'string' }, reply: { enum: ['none', 'wait', 'return'] },
    }, additionalProperties: true });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.actions.session.message.send({ sessionId: 'worker', message: 'Inspect it.',
        reply: 'return', returnToSessionId: 'requester' }, { target: { kind: 'session', sessionId: 'worker' } }))
        .rejects.toMatchObject({ name: 'HappierActionError', code: 'unsupported' });
      expect(server.calls.map(call => call.actionId)).toEqual(['action.spec.get']);
    } finally { await client.close(); await server.close(); }
  });

  it('refuses ignored structured references even for an informational send', async () => {
    const server = await serve({ type: 'object', properties: {
      sessionId: { type: 'string' }, message: { type: 'string' }, reply: { enum: ['none', 'wait', 'return'] },
    }, additionalProperties: true });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await expect(client.actions.session.message.send({ sessionId: 'worker', message: '@reviewer inspect it.', reply: 'none',
        structuredInput: { v: 1, mentions: [{ kind: 'happier.session', ref: 'session:reviewer', token: '@reviewer' }] },
      })).rejects.toMatchObject({ name: 'HappierActionError', code: 'unsupported' });
      expect(server.calls.map(call => call.actionId)).toEqual(['action.spec.get']);
    } finally { await client.close(); await server.close(); }
  });

  it('accepts the real current projection for raw replies, human destinations and exact Run inputs', async () => {
    const server = await serve();
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await client.actions.session.message.send({ sessionId: 'worker', message: 'Inspect it.', reply: 'wait',
        modelOverride: 'model-1', providerConnectionId: 'connection-1' },
        { target: { kind: 'session', sessionId: 'worker' } });
      await client.sessions.get('worker').runs.get('run-1').sendAndWait('Summarize it.');
      await client.actions.session.message.send({ sessionId: 'worker', message: 'Inspect it.', reply: 'return', returnToSessionId: 'requester' });
      const structuredInput = { v: 1 as const, mentions: [{ kind: 'happier.session', ref: 'session:reviewer', token: '@reviewer' }] };
      await client.actions.session.message.send({ sessionId: 'worker', message: '@reviewer inspect it.', reply: 'none', structuredInput });
      expect(server.calls.map(call => call.actionId)).toEqual([
        'action.spec.get', 'session.message.send', 'action.spec.get', 'session.message.send',
        'action.spec.get', 'session.message.send', 'action.spec.get', 'session.message.send',
      ]);
      expect(server.calls[3]).toMatchObject({ target: { kind: 'session', sessionId: 'worker' },
        input: { sessionId: 'worker', recipient: { kind: 'execution_run', runId: 'run-1' }, reply: 'wait' } });
      expect(server.calls[3]?.input).not.toHaveProperty('wait');
      expect(server.calls[5]?.input).toMatchObject({ reply: 'return', returnToSessionId: 'requester' });
      expect(server.calls[7]?.input.structuredInput).toEqual(structuredInput);
    } finally { await client.close(); await server.close(); }
  });

  it('preserves information and legacy boolean sends while refusing malformed current reply input', async () => {
    const server = await serve({ type: 'object', additionalProperties: true });
    const client = connect({ endpoint: server.endpoint, token });
    try {
      await client.actions.session.message.send({ sessionId: 'worker', message: 'FYI.', reply: 'none' });
      await client.actions.session.message.send({ sessionId: 'worker', message: 'Observe it.', wait: true });
      await expect(client.actions.session.message.send({ sessionId: 'worker', message: 'Inspect it.', reply: 'invalid' } as never))
        .rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
      await expect(client.actions.session.message.send({ sessionId: 'worker', message: 'Inspect it.', structuredInput: null } as never))
        .rejects.toMatchObject({ name: 'HappierActionError', code: 'invalid_parameters' });
      expect(server.calls.map(call => call.actionId)).toEqual(['session.message.send', 'session.message.send']);
    } finally { await client.close(); await server.close(); }
  });

  it('cancels the original caller during discovery without sending its input', async () => {
    let started!: () => void;
    let release!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = await serve(undefined, async () => { started(); await gate; });
    const client = connect({ endpoint: server.endpoint, token });
    const controller = new AbortController();
    const reason = new Error('cancel original caller');
    try {
      const pending = client.machine('machine-1').sessions.get('worker').sendAndWait('Inspect it.', {}, { signal: controller.signal });
      const cancelled = expect(pending).rejects.toBe(reason);
      await reading;
      controller.abort(reason);
      await cancelled;
      expect(server.calls.map(call => call.actionId)).toEqual(['action.spec.get']);
    } finally { release(); await client.close(); await server.close(); }
  });
});
