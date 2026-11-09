import { tryReadGithubPositiveDecimal } from '../../observations/githubProviderContracts.js';
import type { GithubCodeScanningInstanceV1 } from './actionContracts.js';

/** Provider-native decoding stays inside scm-github; no shared alert schema. */
export type GithubSecurityAlertKindV1 = 'dependabot-alert' | 'code-scanning-alert';
export type GithubSecurityAlertV1 = Readonly<{
  kindId: GithubSecurityAlertKindV1;
  number: string;
  state: string;
  title: string;
  securitySeverity: string | null;
  ruleSeverity: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs?: number;
  webUrl: string | null;
  native: Readonly<Record<string, unknown>>;
}>;

export function githubSecurityRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function instant(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function decodeGithubSecurityAlert(kindId: GithubSecurityAlertKindV1, body: unknown): GithubSecurityAlertV1 | null {
  const native = githubSecurityRecord(body);
  if (native === null) return null;
  const number = typeof native.number === 'string' && native.number !== native.number.trim()
    ? null : tryReadGithubPositiveDecimal(native.number);
  const createdAtMs = instant(native.created_at);
  const updatedAtMs = instant(native.updated_at) ?? createdAtMs;
  if (number === null || createdAtMs === null || updatedAtMs === null) return null;
  const advisory = githubSecurityRecord(native.security_advisory);
  const vulnerability = githubSecurityRecord(native.security_vulnerability);
  const rule = githubSecurityRecord(native.rule);
  const securitySeverity = kindId === 'dependabot-alert' ? text(vulnerability?.severity) ?? text(advisory?.severity)
    : text(rule?.security_severity_level);
  const state = text(native.state) ?? 'unknown';
  const completedAtMs = state === 'fixed' ? instant(native.fixed_at)
    : state === 'dismissed' ? instant(native.dismissed_at)
      : state === 'auto_dismissed' && kindId === 'dependabot-alert' ? instant(native.auto_dismissed_at) : null;
  return { kindId, number, state,
    title: kindId === 'dependabot-alert' ? text(advisory?.summary) ?? `Dependabot alert #${number}`
      : text(rule?.description) ?? text(rule?.name) ?? text(rule?.id) ?? `Code scanning alert #${number}`,
    securitySeverity, ruleSeverity: kindId === 'code-scanning-alert' ? text(rule?.severity) : null,
    createdAtMs, updatedAtMs, ...(completedAtMs === null ? {} : { completedAtMs }),
    webUrl: text(native.html_url), native };
}

/** One provider instance supplies its immutable revision and repository-relative coordinates. */
export function decodeGithubCodeScanningInstance(value: unknown): GithubCodeScanningInstanceV1 | null {
  const raw = githubSecurityRecord(value);
  if (raw === null) return null;
  const location = githubSecurityRecord(raw.location);
  const commitSha = typeof raw.commit_sha === 'string' ? raw.commit_sha : null;
  const path = typeof location?.path === 'string' ? location.path : null;
  if (commitSha === null || !/^[a-f0-9]{40}$/iu.test(commitSha) || path === null || !validRepositoryPath(path)) return null;
  const positive = (raw: unknown): number | null => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
  const startLine = positive(location?.start_line); const endLine = positive(location?.end_line);
  if (startLine === null || endLine === null || endLine < startLine) return null;
  const string = (value: unknown): string => typeof value === 'string' ? value : '';
  return { ref: string(raw.ref), analysisKey: string(raw.analysis_key), environment: string(raw.environment), category: string(raw.category), state: string(raw.state) || 'unknown', commitSha,
    path, startLine, endLine, startColumn: positive(location?.start_column), endColumn: positive(location?.end_column), message: string(githubSecurityRecord(raw.message)?.text) };
}
function validRepositoryPath(path: string): boolean {
  return path !== '' && !path.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(path) && !path.startsWith('/') && !/^[A-Za-z]:/u.test(path) && path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}
