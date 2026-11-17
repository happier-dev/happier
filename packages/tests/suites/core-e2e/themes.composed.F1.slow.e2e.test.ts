import { it } from 'vitest';
import { runF1 } from './themes.composed';

// Each journey owns a fresh UI host as well as its fresh Account.
it("F1 agent: try/revert writes nothing; Keep, Undo, redo and apply preserve siblings", runF1);
