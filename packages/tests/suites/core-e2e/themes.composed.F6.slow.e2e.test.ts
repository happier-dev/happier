import { it } from 'vitest';
import { runF6 } from './themes.composed';

// Each journey owns a fresh UI host as well as its fresh Account.
it("F6 share: scaffold and pack on the daemon produce a readable archive without installation", runF6);
