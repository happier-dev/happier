import { it } from 'vitest';
import { runF2 } from './themes.composed';

// Each journey owns a fresh UI host as well as its fresh Account.
// The finite inventory journey uses each operation's existing transport budget.
// Do not cut it off with Vitest's shorter whole-test budget under shared load.
it("F2 library/editor: list is header-only; opened retained documents survive export/import and duplicate", runF2, 0);
