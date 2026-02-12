import { trimUtf8TextToMaxBytes } from './utf8.js';

export function redactBugReportSensitiveText(input: string): string {
  return String(input ?? '')
    .replace(/\bauthorization\s*:\s*bearer\s+[^\r\n]+/gi, 'authorization: bearer [REDACTED]')
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi, (_match, key: string) => `${key.toLowerCase()}: [REDACTED]`)
    .replace(/\bx-api-key\s*:\s*[^\r\n]+/gi, 'x-api-key: [REDACTED]')
    .replace(/\b(api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|session(?:id)?)\s*[:=]\s*['"]?\S+/gi, (_match, key: string) => `${key}: [REDACTED]`)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g, '[REDACTED]')
    .replace(/\b(A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\b(password|token|secret)\s*[:=]\s*\S+/gi, (_match, key: string) => `${key}: [REDACTED]`);
}

export function trimBugReportTextToMaxBytes(input: string, maxBytes: number): string {
  return trimUtf8TextToMaxBytes(input, maxBytes);
}
