/**
 * Static voice context configuration.
 *
 * This is intentionally environment-variable driven (build-time) and not user settings.
 */
export const VOICE_CONFIG = {
  /** Disable permission request forwarding */
  DISABLE_PERMISSION_REQUESTS: false,

  /** Disable session online/offline notifications */
  DISABLE_SESSION_STATUS: true,

  /** Disable message forwarding */
  DISABLE_MESSAGES: false,

  /** Disable session focus notifications */
  DISABLE_SESSION_FOCUS: false,

  /** Disable ready event notifications */
  DISABLE_READY_EVENTS: false,

  /** Enable debug logging for voice context updates */
  ENABLE_DEBUG_LOGGING: Boolean(process.env.PUBLIC_EXPO_DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING),
} as const;

