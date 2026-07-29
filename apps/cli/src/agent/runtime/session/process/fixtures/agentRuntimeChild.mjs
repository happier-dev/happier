import { createInterface } from 'node:readline';

let sessionId = null;
let activeTurnId = null;
let sequence = process.argv[2] === 'initial-sequence-zero' ? -1 : 0;
let disposed = false;

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const result = (id, value) => write({ jsonrpc: '2.0', id, result: value });
const event = (value) => write({
  jsonrpc: '2.0',
  method: 'agentRuntime/sessionEvent',
  params: {
    sequence: ++sequence,
    sessionId,
    emittedAtMs: sequence,
    ...value,
  },
});

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  const request = message.params ?? {};
  if (message.method === 'agentRuntime/open') {
    sessionId = request.sessionId;
    result(message.id, { status: 'opened' });
    event({
      kind: 'provider-session-id',
      providerSessionId: request.kind === 'resume'
        ? request.providerSessionId
        : `provider-${request.sessionId}`,
    });
    return;
  }
  if (message.method === 'agentRuntime/send') {
    if (request.input.text === 'malformed-send-result') {
      result(message.id, { status: 'bogus' });
      return;
    }
    if (request.input.text === 'runtime-ended-linger') {
      event({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false });
      result(message.id, { status: 'admitted' });
      return;
    }
    event({
      kind: 'input-accepted',
      inputIds: request.inputIds,
      delivery: request.delivery,
    });
    if (request.input.text === 'accepted-before-start-exit') {
      process.exit(27);
    }
    if (request.input.text === 'max-sequence-start') {
      write({
        jsonrpc: '2.0',
        method: 'agentRuntime/sessionEvent',
        params: {
          sequence: Number.MAX_SAFE_INTEGER,
          sessionId,
          emittedAtMs: Number.MAX_SAFE_INTEGER,
          kind: 'turn-start',
          turnId: request.delivery.turnId,
          startedBy: 'host',
        },
      });
      result(message.id, { status: 'admitted' });
      setTimeout(() => process.exit(31), 25);
      return;
    }
    if (request.input.text === 'accepted-before-start-runtime-ended') {
      event({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false });
      result(message.id, { status: 'admitted' });
      setTimeout(() => process.exit(28), 25);
      return;
    }
    if (request.input.text === 'two-accepted-before-start') {
      event({
        kind: 'input-accepted',
        inputIds: [`${request.inputIds[0]}-second`],
        delivery: { kind: 'newTurn', turnId: `${request.delivery.turnId}-second` },
      });
      result(message.id, { status: 'admitted' });
      setTimeout(() => process.exit(29), 25);
      return;
    }
    activeTurnId = request.delivery.turnId;
    event({ kind: 'turn-start', turnId: activeTurnId, startedBy: 'host' });
    if (request.input.text === 'second-active-turn') {
      const secondTurnId = `${request.delivery.turnId}-second`;
      event({
        kind: 'input-accepted',
        inputIds: [`${request.inputIds[0]}-second`],
        delivery: { kind: 'followUp', turnId: secondTurnId },
      });
      event({ kind: 'turn-start', turnId: secondTurnId, startedBy: 'host' });
      result(message.id, { status: 'admitted' });
      setTimeout(() => process.exit(30), 25);
      return;
    }
    if (request.input.text === 'invalid-event') {
      write({
        jsonrpc: '2.0',
        method: 'agentRuntime/sessionEvent',
        params: { sequence: ++sequence, sessionId, emittedAtMs: sequence, kind: 'not-a-runtime-event' },
      });
      event({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false });
      result(message.id, { status: 'admitted' });
      return;
    }
    if (request.input.text === 'malformed-frame') {
      process.stdout.write('not-json\n');
      return;
    }
    if (request.input.text === 'unsolicited-malformed-frame') {
      result(message.id, { status: 'admitted' });
      setTimeout(() => process.stdout.write('not-json\n'), 25);
      return;
    }
    if (request.input.text === 'exit-unexpected') {
      process.exit(23);
    }
    result(message.id, { status: 'admitted' });
    if (request.input.text === 'await-cancel') return;
    if (request.input.text === 'large-valid-event') {
      event({
        kind: 'file-edit',
        turnId: activeTurnId,
        editId: 'large-valid-edit',
        path: '/tmp/large-valid-edit.txt',
        oldContent: 'x'.repeat(999_950),
        newContent: 'y'.repeat(999_950),
      });
      event({ kind: 'turn-complete', turnId: activeTurnId });
      activeTurnId = null;
      return;
    }
    event({ kind: 'message-delta', turnId: activeTurnId, channel: 'assistant', text: request.input.text });
    event({ kind: 'turn-complete', turnId: activeTurnId });
    if (request.input.text === 'duplicate-terminal') {
      event({ kind: 'turn-complete', turnId: activeTurnId });
      return;
    }
    activeTurnId = null;
    if (request.input.text === 'complete-and-exit') {
      setImmediate(() => process.exit(24));
    }
    return;
  }
  if (message.method === 'agentRuntime/cancel') {
    if (activeTurnId !== request.turnId) {
      result(message.id, { status: 'notRunning' });
      return;
    }
    if (request.turnId === 'input-malformed-cancel') {
      result(message.id, { status: 'bogus' });
      return;
    }
    event({ kind: 'turn-cancelled', turnId: activeTurnId, cause: request.reason });
    const turnId = activeTurnId;
    activeTurnId = null;
    result(message.id, { status: 'requested', turnId });
    return;
  }
  if (message.method === 'agentRuntime/dispose') {
    if (disposed) {
      result(message.id, { status: 'disposed' });
      return;
    }
    if (activeTurnId) {
      event({ kind: 'turn-cancelled', turnId: activeTurnId, cause: 'sessionDispose' });
      activeTurnId = null;
    }
    event({ kind: 'runtime-ended', cause: 'providerEnded', retryable: false });
    disposed = true;
    result(message.id, { status: 'disposed' });
  }
});
