const ACCOUNT_ID_SAFE_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function assertFilesystemSafeAccountId(raw: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error('Invalid accountId: empty');
  }
  if (value === '.' || value === '..') {
    throw new Error(`Invalid accountId: ${value}`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`Invalid accountId: ${value}`);
  }
  if (!ACCOUNT_ID_SAFE_RE.test(value)) {
    throw new Error(`Invalid accountId: ${value}`);
  }
  return value;
}

