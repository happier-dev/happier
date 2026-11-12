/**
 * First-party host bridge to the single exact-owner implementation.
 * This is not an author-facing Plugin SDK entrypoint.
 */
export {
  reclaimJsonOwnerFileLockSnapshot,
  unlinkCreatedJsonOwnerFileLock,
  withJsonOwnerFileLock,
} from '@happier-dev/cli-common/fs/jsonOwnerFileLock';
