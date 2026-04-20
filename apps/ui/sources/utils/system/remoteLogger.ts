/**
 * Simple remote logger for React Native
 * Patches console to send logs to remote server
 * 
 * ONLY ENABLE IN LOCAL BUILD
 * PRIMARILY FOR AI AUTO DEBUGGING
 */

import { config } from '@/config';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { readAiAutoDebugRemoteLoggingEnabled } from '@/utils/system/aiAutoDebuggingEnv';


type RemoteLogEntry = Readonly<{
  timestamp: string;
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  message: unknown[];
}>;

let logBuffer: RemoteLogEntry[] = [];
const MAX_BUFFER_SIZE = 1000
const LEGACY_VOICE_DEBUG_PREFIX = '🎤 Voice:';
const REDACTED_VOICE_PAYLOAD = '[voice_payload_redacted]';

function sanitizeRemoteLogArgs(args: unknown[]): unknown[] {
  if (args.length < 2) return args;

  const [first, ...rest] = args;
  if (typeof first === 'string' && first.startsWith(LEGACY_VOICE_DEBUG_PREFIX)) {
    return [first, ...rest.map(() => REDACTED_VOICE_PAYLOAD)];
  }

  return args;
}

function serializeRemoteLogArg(arg: unknown): string {
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }

  return String(arg);
}

export function monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds() {
  // NEVER ENABLE REMOTE LOGGING IN PRODUCTION
  // This is for local debugging with AI only
  // So AI will have all the logs easily accessible in one file for analysis
  if (!readAiAutoDebugRemoteLoggingEnabled()) {
    return
  }

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  const url = config.serverUrl
  
  if (!url) {
    console.log('[RemoteLogger] No server URL provided, remote logging disabled')
    return
  }

  const sendLog = async (level: RemoteLogEntry['level'], sanitizedArgs: unknown[]) => {
    try {
      await runtimeFetch(url + '/logs-combined-from-cli-and-mobile-for-simple-ai-debugging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: sanitizedArgs.map(serializeRemoteLogArg).join('\n'),
          source: 'mobile',
          platform: 'ios', // or android
        })
      })
    } catch (e) {
      // console.error('[RemoteLogger] Failed to send log:', e)
      // Fail silently
    }
  }

  // Patch console methods
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
    console[level] = (...args: unknown[]) => {
      // Always call original
      originalConsole[level](...args as never[])
      const sanitizedArgs = sanitizeRemoteLogArgs(args);

      // Buffer for developer settings
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        message: sanitizedArgs,
      } satisfies RemoteLogEntry;
      logBuffer.push(entry)
      if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer.shift()
      }

      // Send to remote
      sendLog(level, sanitizedArgs)
    }
  })

  console.log('[RemoteLogger] Initialized with server:', url)
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}
