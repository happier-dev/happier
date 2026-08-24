import { redactBugReportSensitiveText } from '@happier-dev/protocol/bugs/reports';

import {
  CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER,
  CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER,
  CONNECTED_SERVICE_SECRET_REDACTION_MARKER,
} from './sensitiveConnectedServiceDiagnosticFields';

const DEFAULT_MAX_DIAGNOSTIC_STRING_LENGTH = 500;
const PROVIDER_RESUME_ASSIGNMENT_PATTERN = /\b(CODEX_THREAD_ID|threadId|thread_id|codexSessionId|codex_session_id|providerSessionId|provider_session_id|remoteSessionId|remote_session_id|providerSessionId|provider_session_id|sessionId|session_id|vendorResumeId|vendor_resume_id|providerResumeId|provider_resume_id|resumeId|resume_id)(?:"?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/giu;
const LOCAL_PATH_ASSIGNMENT_PATTERN = /\b(cwd|cwds|directory|directories|filePath|file_path|filePaths|file_paths|home|homeDir|home_dir|localPath|local_path|savedPath|saved_path|path|paths|root|roots|worktree|worktreePath|worktree_path|workspaceRoot|workspace_root|location)(?:"?)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/giu;
const LOCAL_ABSOLUTE_PATH_PATTERN = /(^|[\s"'([{:=])(?:[A-Za-z]:[\\/][^\s"'();,]+|\\\\[^\s"'();,]+|\/(?!\/)[^\s"'();,]*)/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceKnownSensitiveValues(value: string, redactedValues: readonly string[]): string {
  let sanitized = value;
  for (const raw of redactedValues) {
    const trimmed = raw.trim();
    if (trimmed.length < 6) continue;
    sanitized = sanitized.replace(new RegExp(escapeRegExp(trimmed), 'g'), CONNECTED_SERVICE_SECRET_REDACTION_MARKER);
  }
  return sanitized;
}

export function sanitizeConnectedServiceDiagnosticString(
  value: string,
  params: Readonly<{
    maxLength?: number;
    redactedValues?: readonly string[];
  }> = {},
): string {
  const maxLength = typeof params.maxLength === 'number' && Number.isFinite(params.maxLength)
    ? Math.max(1, Math.trunc(params.maxLength))
    : DEFAULT_MAX_DIAGNOSTIC_STRING_LENGTH;
  const withKnownValuesRedacted = replaceKnownSensitiveValues(
    redactBugReportSensitiveText(value),
    params.redactedValues ?? [],
  );
  return withKnownValuesRedacted
    .replace(/\b(authorization|authHeader|auth|cookie)(?:"?)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\n]+)/gi, `$1=${CONNECTED_SERVICE_SECRET_REDACTION_MARKER}`)
    .replace(/\b(accessToken|access_token|idToken|id_token|refreshToken|refresh_token|token|credential|credentials|clientSecret|client_secret|client-secret|privateKey|private_key|private-key|apiKey|api_key|api-key|secret)(?:"?)\s*[:=]\s*(?:"(?:Bearer\s+)?[^"]*"|'(?:Bearer\s+)?[^']*'|(?:Bearer\s+)?[^\s;,]+)/gi, `$1=${CONNECTED_SERVICE_SECRET_REDACTION_MARKER}`)
    .replace(PROVIDER_RESUME_ASSIGNMENT_PATTERN, `$1=${CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER}`)
    .replace(LOCAL_PATH_ASSIGNMENT_PATTERN, `$1=${CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER}`)
    .replace(LOCAL_ABSOLUTE_PATH_PATTERN, `$1${CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, CONNECTED_SERVICE_SECRET_REDACTION_MARKER)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, CONNECTED_SERVICE_SECRET_REDACTION_MARKER)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, CONNECTED_SERVICE_SECRET_REDACTION_MARKER)
    .slice(0, maxLength);
}

/**
 * Reduce an unknown thrown value to one bounded, redacted diagnostic for
 * retained daemon logs. Node filesystem and network errors carry the affected
 * absolute path in `message` and local source paths in `stack`, so the stack
 * and cause are never serialized and the remaining text always passes through
 * this module's redaction owner.
 */
export function sanitizeConnectedServiceDiagnosticError(
  error: unknown,
  params: Readonly<{
    maxLength?: number;
    redactedValues?: readonly string[];
  }> = {},
): string {
  if (error instanceof Error) {
    const code = (error as Readonly<{ code?: unknown }>).code;
    const message = error.message.trim();
    return sanitizeConnectedServiceDiagnosticString(
      [
        error.name,
        ...(typeof code === 'string' && code.trim() ? [`(${code.trim()})`] : []),
        ...(message ? [`: ${message}`] : []),
      ].join(''),
      params,
    );
  }
  if (typeof error === 'string' && error.trim()) {
    return sanitizeConnectedServiceDiagnosticString(error, params);
  }
  return 'unknown error';
}
