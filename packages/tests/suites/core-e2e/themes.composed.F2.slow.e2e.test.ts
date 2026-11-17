import { it } from 'vitest';
import { runF2 } from './themes.composed';

// Each journey owns a fresh UI host as well as its fresh Account.
it("F2 library/editor: list is header-only; opened retained documents survive export/import and duplicate", runF2);
