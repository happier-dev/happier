import { it } from 'vitest';
import { runF3 } from './themes.composed';

// Each journey owns a fresh UI host as well as its fresh Account.
it("F3 devices: two labeled apps and one unlabeled app; ambiguity and disconnect after discovery never queue", runF3);
