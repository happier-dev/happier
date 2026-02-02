// Back-compat shim: older tooling/tests call `node scripts/monorepo.mjs ...`.
// The canonical implementation lives in `apps/stack/scripts/monorepo.mjs`.
import '../apps/stack/scripts/monorepo.mjs';

