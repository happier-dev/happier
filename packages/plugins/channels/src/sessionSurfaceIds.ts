/**
 * The persisted contribution identities for the Channels Session-facing
 * surfaces and for the Settings page they route recovery to.
 *
 * They live in this dependency-free leaf because three owners must agree on
 * them exactly: the manifest that declares the contributions, the daemon
 * Resource runtimes that answer them, and the mounted UI artifact that decides
 * which destination it is rendering. A UI bundle cannot import the daemon
 * manifest, so without one leaf owner these routing ids would be spelled twice.
 *
 * Contribution local ids are unique across contribution families, not only
 * within one: the canonical manifest parser rejects a local id already declared
 * by another family.
 */
export const CHANNELS_SESSION_CONVERSATIONS_VIEW_ID = 'session-conversations';
export const CHANNELS_SESSION_CONVERSATIONS_HEADER_ACTION_ID = 'open-session-conversations';
export const CHANNELS_SESSION_COMPOSER_CONTROL_ID = 'session-conversations-chip';
export const CHANNELS_SESSION_COMPOSER_ATTENTION_CONTROL_ID = 'session-conversations-attention-chip';
export const CHANNELS_SESSION_CONVERSATIONS_RESOURCE_ID = 'session-conversations-v1';
export const CHANNELS_SESSION_COMPOSER_STATE_RESOURCE_ID = 'session-conversations-state-v1';
export const CHANNELS_SESSION_COMPOSER_ATTENTION_STATE_RESOURCE_ID =
  'session-conversations-attention-state-v1';
/**
 * The Settings page that owns every binding and connection mutation. The
 * read-only Session destination names it to route recovery there rather than
 * becoming a second writer, so it must be spelled once for both the manifest
 * that declares the page and the UI artifact that opens it.
 */
export const CHANNELS_SETTINGS_PAGE_ID = 'connections';
