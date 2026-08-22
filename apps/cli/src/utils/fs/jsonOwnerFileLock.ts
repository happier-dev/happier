/**
 * First-party host bridge to the single exact-owner implementation.
 * This is not an author-facing Plugin SDK entrypoint.
 */
export {
  reclaimJsonOwnerFileLockSnapshot,
  withJsonOwnerFileLock,
} from '@happier-dev/plugin-sdk/host/fs/json-owner-file-lock';
