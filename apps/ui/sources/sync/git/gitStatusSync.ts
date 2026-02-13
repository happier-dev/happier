// Legacy alias for older import paths.
//
// The UI migrated repo-status syncing to the SCM domain, but some call sites still
// import `gitStatusSync`. Keep the contract stable while the naming transition
// completes.
import { scmStatusSync } from '@/scm/scmStatusSync';

export const gitStatusSync = scmStatusSync;

