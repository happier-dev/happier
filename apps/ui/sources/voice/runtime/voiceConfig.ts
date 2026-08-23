/**
 * Static voice context configuration.
 *
 * This is intentionally environment-variable driven (build-time) and not user settings.
 */
import { readAiAutoDebugRemoteLoggingEnabled } from '@/utils/system/aiAutoDebuggingEnv';

export const VOICE_CONFIG = {
  /** Disable permission request forwarding */
  DISABLE_PERMISSION_REQUESTS: false,

  /** Disable session online/offline notifications */
  DISABLE_SESSION_STATUS: true,

  /** Disable message forwarding */
  DISABLE_MESSAGES: false,

  /** Disable ready event notifications */
  DISABLE_READY_EVENTS: false,

  /** Enable safe developer diagnostics for voice context updates */
  ENABLE_DEBUG_LOGGING: readAiAutoDebugRemoteLoggingEnabled(),
} as const;
