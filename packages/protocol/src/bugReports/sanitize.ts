import type { BugReportDeploymentType } from './types.js';

export function normalizeBugReportProviderUrl(input: string | null | undefined): string | null {
  const value = String(input ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function sanitizeBugReportArtifactFileSegment(input: string): string {
  return String(input ?? 'unknown')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'unknown';
}

export function sanitizeBugReportArtifactPath(path: string | null | undefined): string | null {
  const value = typeof path === 'string' ? path.trim() : '';
  if (!value) return null;
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1] ?? null;
}

export function sanitizeBugReportUrl(input: string | null | undefined): string | undefined {
  const value = String(input ?? '').trim();
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  } catch {
    return value
      .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1')
      .replace(/[?#].*$/, '');
  }
}

export function inferBugReportDeploymentTypeFromServerUrl(serverUrl: string): BugReportDeploymentType {
  try {
    const host = new URL(serverUrl).hostname.toLowerCase();
    if (host.endsWith('happier.dev')) return 'cloud';
    if (host.endsWith('.internal') || host.endsWith('.corp')) return 'enterprise';
    return 'self-hosted';
  } catch {
    return 'self-hosted';
  }
}
