import { config, core } from 'zod/mini';

/**
 * Cycle-tolerant parsing is off for Protocol schemas, as it is by default under
 * `zod/mini`. Any classic `zod` container otherwise installs Zod's default
 * memoizer for the whole process, whose first-parse walk reads every nested
 * definition and so resolves every lazy definition the input never reaches.
 * Protocol input is JSON and cannot contain a reference cycle.
 *
 * Importing this leaf before a classic `zod` import keeps that schema off the
 * memoizer too; later construction is covered regardless of order.
 */
const noCycleSupport: core.$ZodMemoizer = {
  attach() {},
  alloc: (_inst, _payload, empty) => empty,
  guard() {},
};

config({ memoizer: noCycleSupport });
