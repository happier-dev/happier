export const CONNECTED_SERVICE_SECRET_REDACTION_MARKER = '[REDACTED]';
export const CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER = '[REDACTED_PROVIDER_RESUME_ID]';
export const CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER = '[REDACTED_LOCAL_PATH]';

export type ConnectedServiceSensitiveDiagnosticKeyCategory =
  | 'secret'
  | 'provider_resume_id'
  | 'local_path';

function normalizeSensitiveDiagnosticKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const PROVIDER_RESUME_ID_KEYS = new Set([
  'codexthreadid',
  'threadid',
  'codexsessionid',
  'providersessionid',
  'remotesessionid',
  'sessionid',
  'vendorsessionid',
  'vendorresumeid',
  'providerresumeid',
  'resumeid',
]);

const LOCAL_PATH_KEYS = new Set([
  'cwd',
  'cwds',
  'directories',
  'directory',
  'filepath',
  'filepaths',
  'home',
  'homedir',
  'localpath',
  'path',
  'paths',
  'readableroot',
  'readableroots',
  'root',
  'roots',
  'savedpath',
  'workspaceroot',
  'workspaceroots',
  'writableroot',
  'writableroots',
  'location',
]);

export function classifyConnectedServiceSensitiveDiagnosticKey(
  key: string | undefined,
): ConnectedServiceSensitiveDiagnosticKeyCategory | null {
  if (!key) return null;
  const normalized = normalizeSensitiveDiagnosticKey(key);
  if (normalized === 'notsecret' || normalized === 'notauthentication') return null;
  if (PROVIDER_RESUME_ID_KEYS.has(normalized)) return 'provider_resume_id';
  if (LOCAL_PATH_KEYS.has(normalized)) return 'local_path';
  if (
    normalized.includes('token')
    || normalized === 'secret'
    || normalized.includes('secret')
    || normalized.includes('password')
    || normalized.includes('apikey')
    || normalized === 'auth'
    || normalized.endsWith('auth')
    || normalized.includes('authentication')
    || normalized.includes('authheader')
    || normalized.includes('authorization')
    || normalized.includes('cookie')
    || normalized.includes('credential')
    || normalized.includes('privatekey')
  ) {
    return 'secret';
  }
  return null;
}

export function resolveConnectedServiceSensitiveDiagnosticMarker(
  category: ConnectedServiceSensitiveDiagnosticKeyCategory,
): string {
  switch (category) {
    case 'secret':
      return CONNECTED_SERVICE_SECRET_REDACTION_MARKER;
    case 'provider_resume_id':
      return CONNECTED_SERVICE_PROVIDER_RESUME_ID_REDACTION_MARKER;
    case 'local_path':
      return CONNECTED_SERVICE_LOCAL_PATH_REDACTION_MARKER;
  }
}
