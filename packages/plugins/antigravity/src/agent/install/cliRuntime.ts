export const ANTIGRAVITY_AGENT_ID = 'antigravity';
export const ANTIGRAVITY_BACKEND_ID = ANTIGRAVITY_AGENT_ID;
export const ANTIGRAVITY_BINARY_NAME = 'agy';

/** Native `agy acp` application-data directory beneath its `--gemini-dir`. */
export const ANTIGRAVITY_APP_DATA_DIR = 'antigravity-cli';
/** Native consumer OAuth token file, relative to the `--gemini-dir` root. */
export const ANTIGRAVITY_NATIVE_TOKEN_FILE = `${ANTIGRAVITY_APP_DATA_DIR}/antigravity-oauth-token`;
/**
 * Native agy keeps credentials in its `--gemini-dir` profile file instead of the
 * OS keyring. Without it an empty profile silently signs in with the machine
 * keyring login, and a Windows refresh moves the profile token into Credential
 * Manager, so Connected Account launches set it and machine launches strip it.
 */
export const ANTIGRAVITY_FILE_TOKEN_STORAGE_ENV = 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE';
/** First agy release that honours the file-token-storage switch. */
export const ANTIGRAVITY_CONNECTED_MIN_VERSION = '1.5.18';
