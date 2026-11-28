import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

import {
  classifyClaudeCodeCredentialHealth,
  type ClaudeCodeCredentialHealth,
} from './claudeCodeCredentialHealth';
import { readClaudeCodeMacOsKeychainDocument } from './claudeCodeMacOsKeychain';
import {
  CLAUDE_CODE_REQUIRED_OAUTH_SCOPES,
  CLAUDE_CODE_SETUP_TOKEN_SCOPES,
  parseClaudeCodeCredentialScopes,
} from './claudeCodeCredentialScopes';
import {
  buildSafeClaudeCodeCredentialComparatorEntry,
  computeClaudeCodeCredentialAccountProofFingerprint,
  computeClaudeCodeCredentialFingerprint,
  computeClaudeCodeCredentialSafeTokenFingerprint,
  isExistingClaudeCodeCredentialNewer,
  readClaudeCodeCredentialFreshness,
  readClaudeCodeCatalogSignIn,
  readClaudeCodeNativeCredentialPayload,
  readNumber,
  readObject,
  readOptionalString,
  readString,
  type ClaudeCodeCatalogSignIn,
  type ClaudeCodeNativeCredentialPayload,
} from './claudeCodeNativeCredentialPayload';

export {
  computeClaudeCodeCredentialAccountProofFingerprint,
  computeClaudeCodeCredentialFingerprint,
  computeClaudeCodeCredentialSafeTokenFingerprint,
  readClaudeCodeNativeCredentialPayload,
  type ClaudeCodeNativeCredentialPayload,
} from './claudeCodeNativeCredentialPayload';

export type ClaudeCodeCredentialFileParseResult =
  | Readonly<{
      status: 'ok';
      hasAccessToken: boolean;
      hasRefreshToken: boolean;
      expiresAt: number | null;
      scopes: readonly string[];
    }>
  | Readonly<{
      status: 'unsupported_shape';
      hasAccessToken: false;
      hasRefreshToken: false;
      expiresAt: null;
      scopes: readonly string[];
    }>;

export type ClaudeCodeCredentialPayloadBuildResult =
  | Readonly<{ status: 'ok'; payload: ClaudeCodeNativeCredentialPayload }>
  | Readonly<{ status: 'diagnostic'; health: ClaudeCodeCredentialHealth }>;

export type ClaudeCodeNativeCredentialFileReadResult = Readonly<{
  payload: ClaudeCodeNativeCredentialPayload;
  updatedAtMs: number;
}>;

export type ClaudeCodeNativeCredentialReadSource = 'file' | 'macos_keychain';

export type ClaudeCodeNativeCredentialReadResult = Readonly<{
  payload: ClaudeCodeNativeCredentialPayload;
  updatedAtMs: number;
  source: ClaudeCodeNativeCredentialReadSource;
}>;

type ClaudeCodeCredentialDiagnosticContext = Readonly<{
  profileId?: string | undefined;
  homeKind?: 'profile' | 'group' | string | undefined;
}>;

export function resolveClaudeCodeCredentialsFilePath(claudeConfigDir: string): string {
  return join(claudeConfigDir, '.credentials.json');
}

export function parseClaudeCodeCredentialFile(value: unknown): ClaudeCodeCredentialFileParseResult {
  const root = readObject(value);
  const credential = readObject(root?.claudeAiOauth);
  if (!credential) {
    return {
      status: 'unsupported_shape',
      hasAccessToken: false,
      hasRefreshToken: false,
      expiresAt: null,
      scopes: [],
    };
  }

  return {
    status: 'ok',
    hasAccessToken: Boolean(readString(credential.accessToken)),
    hasRefreshToken: Boolean(readString(credential.refreshToken)),
    expiresAt: readNumber(credential.expiresAt),
    scopes: parseClaudeCodeCredentialScopes(
      Array.isArray(credential.scopes)
        ? credential.scopes.filter((scope): scope is string => typeof scope === 'string')
        : typeof credential.scopes === 'string'
          ? credential.scopes
          : null,
    ),
  };
}

export async function readClaudeCodeNativeCredentialFile(
  claudeConfigDir: string,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ClaudeCodeNativeCredentialFileReadResult | null> {
  return await readClaudeCodeNativeCredentialFilePath(resolveClaudeCodeCredentialsFilePath(claudeConfigDir), options);
}

export async function readClaudeCodeNativeCredential(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
  diagnosticContext?: ClaudeCodeCredentialDiagnosticContext | undefined;
  signal?: AbortSignal;
}>): Promise<ClaudeCodeNativeCredentialReadResult | null> {
  const read = await readClaudeCodeSecureStorage(params, readClaudeCodeNativeCredentialPayload);
  const result = read ? { payload: read.value, updatedAtMs: read.updatedAtMs, source: read.source } : null;
  logCredentialRead({
    diagnosticContext: params.diagnosticContext,
    result,
  });
  return result;
}

/** Read the effective saved model-catalog sign-in from a single secure-storage document. */
export async function readClaudeCodeNativeCatalogSignIn(params: Readonly<{
  claudeConfigDir: string;
  homeDir?: string | null | undefined;
  signal?: AbortSignal;
}>): Promise<ClaudeCodeCatalogSignIn | null> {
  return (await readClaudeCodeSecureStorage(params, readClaudeCodeCatalogSignIn))?.value ?? null;
}

/**
 * Read one projection of Claude Code's secure storage: the macOS keychain item first, then
 * `<configDir>/.credentials.json`, which is where Claude Code keeps it on every other platform.
 */
async function readClaudeCodeSecureStorage<T>(
  params: Readonly<{
    claudeConfigDir: string;
    homeDir?: string | null | undefined;
    username?: string | null | undefined;
    signal?: AbortSignal;
  }>,
  project: (document: unknown) => T | null,
): Promise<Readonly<{ value: T; updatedAtMs: number; source: ClaudeCodeNativeCredentialReadSource }> | null> {
  params.signal?.throwIfAborted();
  if (process.platform === 'darwin') {
    const keychain = await readClaudeCodeMacOsKeychainDocument({
      claudeConfigDir: params.claudeConfigDir,
      homeDir: params.homeDir,
      username: params.username,
      signal: params.signal,
    });
    const value = keychain ? project(keychain.document) : null;
    if (keychain && value) {
      return { value, updatedAtMs: keychain.updatedAtMs ?? Date.now(), source: 'macos_keychain' };
    }
  }
  const file = await readClaudeCodeCredentialsDocumentFile(
    resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir),
    { signal: params.signal },
  );
  const value = file ? project(file.document) : null;
  return file && value ? { value, updatedAtMs: file.updatedAtMs, source: 'file' } : null;
}

async function readClaudeCodeNativeCredentialFilePath(
  credentialPath: string,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<ClaudeCodeNativeCredentialFileReadResult | null> {
  const file = await readClaudeCodeCredentialsDocumentFile(credentialPath, options);
  const payload = file ? readClaudeCodeNativeCredentialPayload(file.document) : null;
  return file && payload ? { payload, updatedAtMs: file.updatedAtMs } : null;
}

async function readClaudeCodeCredentialsDocumentFile(
  credentialPath: string,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<Readonly<{ document: unknown; updatedAtMs: number }> | null> {
  options?.signal?.throwIfAborted();
  try {
    const [contents, stats] = await Promise.all([
      readFile(credentialPath, { encoding: 'utf8', signal: options?.signal }),
      stat(credentialPath),
    ]);
    options?.signal?.throwIfAborted();
    return { document: JSON.parse(contents) as unknown, updatedAtMs: stats.mtimeMs };
  } catch {
    options?.signal?.throwIfAborted();
    return null;
  }
}

function logCredentialFileDecision(params: Readonly<{
  decision: 'write' | 'skip_existing_newer' | 'skip_fingerprint_match';
  diagnosticContext?: ClaudeCodeCredentialDiagnosticContext | undefined;
  existing: ClaudeCodeNativeCredentialReadResult | ClaudeCodeNativeCredentialFileReadResult | null;
  incomingPayload: ClaudeCodeNativeCredentialPayload;
  incomingFreshness: ReturnType<typeof readClaudeCodeCredentialFreshness>;
}>): void {
  const existingFreshness = params.existing
    ? readClaudeCodeCredentialFreshness(params.existing.payload, params.existing.updatedAtMs)
    : null;
  logger.debug('[DAEMON RUN] Claude Code credential file decision', {
    event: 'claude_code_credential_file_decision',
    ...(params.diagnosticContext ?? {}),
    decision: params.decision,
    comparatorBasis: {
      existing: params.existing && existingFreshness
        ? buildSafeClaudeCodeCredentialComparatorEntry(
            params.existing.payload,
            existingFreshness,
            'source' in params.existing ? params.existing.source : 'file',
          )
        : null,
      incoming: buildSafeClaudeCodeCredentialComparatorEntry(
        params.incomingPayload,
        params.incomingFreshness,
        'incoming',
      ),
      sameRefreshToken: existingFreshness
        ? existingFreshness.refreshToken === params.incomingFreshness.refreshToken
        : null,
    },
    decidedAtMs: Date.now(),
  });
}

function logCredentialRead(params: Readonly<{
  diagnosticContext?: ClaudeCodeCredentialDiagnosticContext | undefined;
  result: ClaudeCodeNativeCredentialReadResult | null;
}>): void {
  const freshness = params.result
    ? readClaudeCodeCredentialFreshness(params.result.payload, params.result.updatedAtMs)
    : null;
  logger.debug('[DAEMON RUN] Claude Code credential read', {
    event: 'claude_code_credential_read',
    ...(params.diagnosticContext ?? {}),
    source: params.result?.source ?? 'missing',
    credential: params.result && freshness
      ? buildSafeClaudeCodeCredentialComparatorEntry(
          params.result.payload,
          freshness,
          params.result.source,
        )
      : null,
  });
}

export function buildClaudeCodeCredentialPayload(
  record: ConnectedServiceCredentialRecordV1,
): ClaudeCodeCredentialPayloadBuildResult {
  const health = classifyClaudeCodeCredentialHealth(record);
  if (health.status !== 'ok') {
    return { status: 'diagnostic', health };
  }
  if (record.kind === 'token') {
    return {
      status: 'ok',
      payload: {
        claudeAiOauth: {
          accessToken: record.token.token,
          scopes: [...CLAUDE_CODE_SETUP_TOKEN_SCOPES],
        },
      },
    };
  }
  if (record.kind !== 'oauth') {
    return { status: 'diagnostic', health };
  }
  const raw = readObject(record.oauth.raw);
  const providerCredential = readObject(raw?.claudeAiOauth) ?? readObject(raw?.['claude.ai_oauth']);
  const subscriptionType = readOptionalString(providerCredential?.subscriptionType);
  const rateLimitTier = readOptionalString(providerCredential?.rateLimitTier);

  const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
    ? record.expiresAt
    : null;

  return {
    status: 'ok',
    payload: {
      claudeAiOauth: {
        accessToken: record.oauth.accessToken,
        // A null/unknown expiry must NOT be coerced to 0: writing `expiresAt: 0`
        // produces an immediately-expired credential (a latent fail-open/fail-closed
        // trap depending on the consumer). Omit it so the value reads as "unknown".
        ...(expiresAt !== null ? { expiresAt } : {}),
        scopes: parseClaudeCodeCredentialScopes(record.oauth.scope),
        ...(subscriptionType ? { subscriptionType } : {}),
        ...(rateLimitTier ? { rateLimitTier } : {}),
      },
    },
  };
}

export async function writeClaudeCodeCredentialsFile(params: Readonly<{
  claudeConfigDir: string;
  payload: ClaudeCodeNativeCredentialPayload;
  incomingUpdatedAtMs?: number;
  compareCredentialPath?: string;
  preserveNewerExistingCredential?: boolean;
  homeDir?: string | null | undefined;
  username?: string | null | undefined;
  diagnosticContext?: ClaudeCodeCredentialDiagnosticContext | undefined;
}>): Promise<string> {
  await mkdir(params.claudeConfigDir, { recursive: true });
  const credentialPath = resolveClaudeCodeCredentialsFilePath(params.claudeConfigDir);
  const compareCredentialPath = params.compareCredentialPath ?? credentialPath;
  const incomingFreshness = readClaudeCodeCredentialFreshness(
    params.payload,
    typeof params.incomingUpdatedAtMs === 'number' && Number.isFinite(params.incomingUpdatedAtMs)
      ? params.incomingUpdatedAtMs
      : Date.now(),
  );
  const existing = compareCredentialPath === credentialPath || process.platform === 'darwin'
    ? await readClaudeCodeNativeCredential({
        claudeConfigDir: compareCredentialPath === credentialPath
          ? params.claudeConfigDir
          : dirname(compareCredentialPath),
        homeDir: params.homeDir,
        username: params.username,
      })
    : await readClaudeCodeNativeCredentialFilePath(compareCredentialPath);
  if (existing && params.preserveNewerExistingCredential !== false) {
    const existingFreshness = readClaudeCodeCredentialFreshness(existing.payload, existing.updatedAtMs);
    if (isExistingClaudeCodeCredentialNewer({ existing: existingFreshness, incoming: incomingFreshness })) {
      logCredentialFileDecision({
        decision: 'skip_existing_newer',
        diagnosticContext: params.diagnosticContext,
        existing,
        incomingPayload: params.payload,
        incomingFreshness,
      });
      if (
        compareCredentialPath !== credentialPath
        || ('source' in existing && existing.source === 'macos_keychain')
      ) {
        await writeClaudeCodeCredentialsFileUnchecked({
          credentialPath,
          claudeConfigDir: params.claudeConfigDir,
          payload: existing.payload,
        });
      }
      return credentialPath;
    }
  }

  const writeStatus = await writeClaudeCodeCredentialsFileUnchecked({
    credentialPath,
    claudeConfigDir: params.claudeConfigDir,
    payload: params.payload,
  });
  logCredentialFileDecision({
    decision: writeStatus === 'written' ? 'write' : 'skip_fingerprint_match',
    diagnosticContext: params.diagnosticContext,
    existing,
    incomingPayload: params.payload,
    incomingFreshness,
  });
  return credentialPath;
}

async function writeClaudeCodeCredentialsFileUnchecked(params: Readonly<{
  credentialPath: string;
  claudeConfigDir: string;
  payload: ClaudeCodeNativeCredentialPayload;
}>): Promise<'written' | 'unchanged'> {
  const payload = stripClaudeCodeCredentialFileRefreshToken(params.payload);
  const current = await readClaudeCodeNativeCredentialFilePath(params.credentialPath);
  if (
    current
    && computeClaudeCodeCredentialFingerprint(current.payload)
      === computeClaudeCodeCredentialFingerprint(payload)
  ) {
    // Content is unchanged, but the file may have been left world/group-readable by external
    // tooling or an older writer. The rewrite path is skipped, so repair the mode here (stat first,
    // chmod only when needed) — a credentials file must never linger at 0644/0664.
    await repairClaudeCodeCredentialsFileMode(params.credentialPath);
    return 'unchanged';
  }
  // The OS creates an invocation-owned scratch directory on the destination filesystem.
  // Interrupted or otherwise colliding temp entries must not force replacement of the live home.
  const tempDir = await mkdtemp(join(params.claudeConfigDir, '.credentials-'));
  const tempPath = join(tempDir, 'credentials.json');
  try {
    await writeFile(tempPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(tempPath, 0o600);
    }
    await rename(tempPath, params.credentialPath);
    if (process.platform !== 'win32') {
      await chmod(params.credentialPath, 0o600);
    }
    return 'written';
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function repairClaudeCodeCredentialsFileMode(credentialPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const stats = await stat(credentialPath);
    if ((stats.mode & 0o777) === 0o600) return;
    await chmod(credentialPath, 0o600);
  } catch {
    // The file may have vanished under a concurrent writer; the next materialization repairs it.
  }
}

function stripClaudeCodeCredentialFileRefreshToken(
  payload: ClaudeCodeNativeCredentialPayload,
): ClaudeCodeNativeCredentialPayload {
  const { refreshToken: _refreshToken, ...credential } = payload.claudeAiOauth;
  return {
    claudeAiOauth: credential,
  };
}
