// External Codex protocol boundary: a real child with persistent native identity.
const fs = require('node:fs');
const readline = require('node:readline');
const [statePath, requestsPath, ...args] = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli 0.130.0');
  process.exit(0);
}
if (args.includes('features')) {
  console.log('');
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  fs.appendFileSync(requestsPath, JSON.stringify({ ...message, pid: process.pid }) + '\n');
  let result = {};
  switch (message.method) {
    case 'thread/start':
      fs.writeFileSync(statePath, 'thread-teardown');
      result = { thread: { id: 'thread-teardown', turns: [] } };
      break;
    case 'thread/resume':
      if (fs.readFileSync(statePath, 'utf8') !== message.params.threadId) {
        send({ id: message.id, error: { code: -32000, message: 'missing rollout' } });
        return;
      }
      result = { thread: { id: message.params.threadId, turns: [] } };
      break;
    case 'thread/read':
      result = { thread: { id: 'thread-teardown', turns: [] } };
      break;
    case 'thread/turns/list':
      result = { data: [], nextCursor: null };
      break;
    case 'turn/start':
      result = { turn: { id: 'turn-teardown', status: 'inProgress', items: [] } };
      break;
    case 'experimentalFeature/list':
      result = { data: [], nextCursor: null };
      break;
  }
  send({ id: message.id, result });
  if (message.method !== 'turn/start') return;
  const text = JSON.stringify(message.params.input);
  notify('turn/started', { threadId: 'thread-teardown', turn: result.turn });
  if (text.includes('hold-for-cancel')) return;
  if (text.includes('fail-this-turn')) {
    notify('turn/completed', { threadId: 'thread-teardown', turn: {
      id: 'turn-teardown', status: 'failed', error: { message: 'fixture failure' }, items: [],
    } });
    return;
  }
  notify('item/agentMessage/delta', {
    threadId: 'thread-teardown', turnId: 'turn-teardown', itemId: 'answer',
    delta: JSON.stringify({ summary: 'Completed', deliverables: [{ id: 'result', title: 'Done' }] }),
  });
  notify('turn/completed', { threadId: 'thread-teardown', turn: {
    id: 'turn-teardown', status: 'completed', items: [],
  } });
});
