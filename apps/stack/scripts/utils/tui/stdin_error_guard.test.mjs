import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { installTuiStdinErrorGuard } from './stdin_error_guard.mjs';

test('installTuiStdinErrorGuard prevents unhandled error event crashes', () => {
  const stdin = new EventEmitter();
  const err = Object.assign(new Error('read EIO'), { code: 'EIO', errno: -5, syscall: 'read' });

  assert.throws(() => stdin.emit('error', err));

  const guard = installTuiStdinErrorGuard({ stdin });
  assert.doesNotThrow(() => stdin.emit('error', err));

  guard.uninstall();
});
