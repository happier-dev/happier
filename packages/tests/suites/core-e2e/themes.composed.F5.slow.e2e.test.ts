import { it } from 'vitest';
import { runF5 } from './themes.composed';

// Each journey owns a fresh UI host as well as its fresh Account.
it("F5 store: browse, acquire, preview, install faces, check updates and uninstall", runF5);
