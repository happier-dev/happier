import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';

import { watchDebounced } from './watch.mjs';

test('watchDebounced skips inaccessible or vanished descendants and still observes healthy changes', async () => {
  for (const code of ['EACCES', 'ENOENT', 'EPERM']) {
    const nativeWatcher = new EventEmitter();
    nativeWatcher.close = () => {};
    const warnings = [];
    const changes = [];
    let notify;
    const watcher = watchDebounced({
      paths: ['/repo/src'], debounceMs: 0,
      logger: { warn: (message) => warnings.push(message) },
      watchImpl: (_path, _options, handler) => { notify = handler; return nativeWatcher; },
      onChange: (event) => changes.push(event.filename),
    });
    try {
      assert.doesNotThrow(() => nativeWatcher.emit('error', Object.assign(new Error('watch failed'), {
        code, path: '/repo/src/private/file.ts',
      })));
      notify('change', 'runtime.ts');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(changes, ['runtime.ts']);
      assert.match(warnings.join('\n'), new RegExp(code));
      assert.match(warnings.join('\n'), /private\/file.ts/);
      for (const error of [
        Object.assign(new Error('resource exhaustion'), { code: 'EMFILE', path: '/repo/src/file.ts' }),
        Object.assign(new Error('root unavailable'), { code, path: '/repo/src' }),
        Object.assign(new Error('sibling unavailable'), { code, path: '/repo/src-other/file.ts' }),
      ]) assert.throws(() => nativeWatcher.emit('error', error), (actual) => actual === error);
    } finally { watcher.close(); }
  }
});

test('watchDebounced preserves fatal construction errors instead of silently disabling watching', () => {
  const error = Object.assign(new Error('watch resource exhaustion'), { code: 'EMFILE' });
  assert.throws(() => watchDebounced({ paths: ['/repo/src'], onChange() {}, watchImpl() { throw error; } }),
    (actual) => actual === error);
});

test('watchDebounced gives the native watcher the same ignore policy used by observation', () => {
  const ignorePath = (path) => path.includes('.scratch-');
  const changes = [];
  let options;
  let notify;
  const watcher = watchDebounced({
    paths: ['/repo/src'], ignorePath,
    onChange: (event) => changes.push(event),
    watchImpl: (_path, opts, handler) => { options = opts; notify = handler; return { close() {} }; },
    setTimeoutImpl: (callback) => { callback(); return null; },
  });
  try {
    assert.equal(options.ignore, ignorePath);
    notify('rename', '.scratch-work/generated.ts');
    notify('change', 'runtime.ts');
    assert.deepEqual(changes.map((event) => event.filename), ['runtime.ts']);
  } finally { watcher.close(); }
});

test('watchDebounced polls an explicit signature so missed fs.watch events still trigger onChange', async () => {
  const calls = [];
  let signature = 'initial';
  let poll = null;
  let pollTimer = null;

  const watcher = watchDebounced({
    paths: ['/tmp/hstack-watch-test'],
    debounceMs: 0,
    onChange(event) {
      calls.push(`${event.eventType}:${event.filename ?? ''}`);
    },
    readSignature() {
      return signature;
    },
    pollIntervalMs: 1234,
    watchImpl: () => ({
      close() {
        calls.push('watch:closed');
      },
    }),
    setIntervalImpl(fn, ms) {
      assert.equal(ms, 1234);
      poll = fn;
      pollTimer = { id: 'poll' };
      return pollTimer;
    },
    clearIntervalImpl(timer) {
      assert.equal(timer, pollTimer);
      calls.push('poll:closed');
    },
  });

  assert.ok(watcher);
  assert.equal(typeof poll, 'function');

  await poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);

  signature = 'changed';
  await poll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['poll:']);

  watcher.close();
  assert.ok(calls.includes('watch:closed'));
  assert.ok(calls.includes('poll:closed'));
});

test('watchDebounced awaits asynchronous signatures without treating pending promises as changes', async () => {
  const calls = [];
  const pendingReads = [];
  let poll = null;

  const watcher = watchDebounced({
    paths: ['/tmp/hstack-watch-async-signature-test'],
    debounceMs: 0,
    onChange(event) {
      calls.push(`${event.eventType}:${event.filename ?? ''}`);
    },
    readSignature() {
      return new Promise((resolve) => pendingReads.push(resolve));
    },
    pollIntervalMs: 1234,
    watchImpl: () => ({ close() {} }),
    setIntervalImpl(fn) {
      poll = fn;
      return { unref() {} };
    },
    clearIntervalImpl() {},
  });

  assert.ok(watcher);
  assert.equal(pendingReads.length, 1, 'the initial asynchronous signature read should establish the baseline');
  pendingReads.shift()('initial');
  await Promise.resolve();

  const unchangedPoll = poll();
  let unchangedSettled = false;
  unchangedPoll.then(() => {
    unchangedSettled = true;
  });
  for (let attempt = 0; attempt < 5 && pendingReads.length === 0; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(unchangedSettled, false, 'the poll must remain pending until the signature read completes');
  pendingReads.shift()('initial');
  await unchangedPoll;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, []);

  const changedPoll = poll();
  pendingReads.shift()('changed');
  await changedPoll;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['poll:']);

  watcher.close();
});

test('watchDebounced marks filesystem events observed while its async baseline is pending', async () => {
  const events = [];
  let resolveBaseline;
  let emitFilesystemEvent;
  const watcher = watchDebounced({
    paths: ['/tmp/hstack-watch-initializing-signature-test'],
    debounceMs: 0,
    onChange(event) {
      events.push(event);
    },
    readSignature() {
      return new Promise((resolve) => {
        resolveBaseline = resolve;
      });
    },
    watchImpl: (_path, _options, handler) => {
      emitFilesystemEvent = handler;
      return { close() {} };
    },
  });

  emitFilesystemEvent('change', 'app.ts');
  resolveBaseline('changed-during-baseline');
  await new Promise((resolve) => setTimeout(resolve, 0));
  watcher.close();

  assert.equal(events.length, 1);
  assert.equal(events[0].signatureInitializedAtObservation, false);
  assert.equal(events[0].watchPath, '/tmp/hstack-watch-initializing-signature-test');
});

test('watchDebounced reports a filesystem observation before its debounced change callback', async () => {
  const calls = [];
  let emitFilesystemEvent;
  let runDebouncedChange;
  const watcher = watchDebounced({
    paths: ['/tmp/hstack-watch-observation-test'],
    debounceMs: 500,
    onObservation(event) {
      calls.push(`observed:${event.eventType}:${event.filename}`);
    },
    onChange(event) {
      calls.push(`changed:${event.eventType}:${event.filename}`);
    },
    watchImpl: (_path, _options, handler) => {
      emitFilesystemEvent = handler;
      return { close() {} };
    },
    setTimeoutImpl(callback, ms) {
      assert.equal(ms, 500);
      runDebouncedChange = callback;
      return { id: 'debounce' };
    },
    clearTimeoutImpl() {},
  });

  emitFilesystemEvent('change', 'schema.prisma');
  assert.deepEqual(calls, ['observed:change:schema.prisma']);
  runDebouncedChange();
  await Promise.resolve();
  watcher.close();

  assert.deepEqual(calls, [
    'observed:change:schema.prisma',
    'changed:change:schema.prisma',
  ]);
});

test('watchDebounced does not carry handled status into a later debounce window', async () => {
  const changes = [];
  const timers = [];
  let handled = true;
  let emitFilesystemEvent;
  const watcher = watchDebounced({
    paths: ['/tmp/hstack-watch-observation-reset-test'],
    debounceMs: 500,
    onObservation() {
      return handled;
    },
    onChange(event) {
      changes.push(event.observationHandled);
    },
    watchImpl: (_path, _options, handler) => {
      emitFilesystemEvent = handler;
      return { close() {} };
    },
    setTimeoutImpl(callback) {
      timers.push(callback);
      return { id: timers.length };
    },
    clearTimeoutImpl() {},
  });

  emitFilesystemEvent('change', 'first.ts');
  timers.shift()();
  await Promise.resolve();
  handled = false;
  emitFilesystemEvent('change', 'second.ts');
  timers.shift()();
  await Promise.resolve();
  watcher.close();

  assert.deepEqual(changes, [true, false]);
});
