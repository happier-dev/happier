/**
 * The Protocol catalog is the single owner of server-synced Account Settings. UI consumers keep
 * this facade import for compatibility, but it deliberately does not compose another registry.
 */
export {
    ACCOUNT_SETTING_ARTIFACTS,
    ACCOUNT_SETTING_DEFINITIONS,
} from '@happier-dev/protocol';
