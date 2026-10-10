import { zhHans } from './zh-Hans';
import { createZhHant } from './zh-HantOverrides';

// Native and offline readers retain the synchronous, once-composed locale.
// Web loads the base and overrides independently at the locale demand boundary.
export const zhHant = createZhHant(zhHans);
