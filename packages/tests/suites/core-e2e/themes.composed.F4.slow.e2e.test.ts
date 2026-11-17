import { it } from 'vitest';
import { runF4 } from './themes.composed';

// Each journey owns a fresh UI host as well as its fresh Account.
it("F4 CSS: web has zero Unistyles updates; native has one per applied change, zero while idle or after unrelated settings", runF4);
