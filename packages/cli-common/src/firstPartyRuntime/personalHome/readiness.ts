import { readFile, rm } from 'node:fs/promises';

import { isPidPresent } from '../../process/processLiveness.js';

export type PersonalHomeAuthenticatedReadiness = Readonly<{
  authenticated: true;
  homeServerIdentityId: string;
  accountCount: number;
  sessionCount: number;
  /**
   * The server-owned H6 bootstrap outcome. Older startup receipts omit this
   * additive field; current Personal Home servers always publish it.
   */
  teamsBootstrapStatus?: 'ready' | 'setup_required' | 'teams_unavailable';
}>;

const DEFAULT_READINESS_WAIT_MS = 10_000;
const READINESS_POLL_MS = 100;

export function parsePersonalHomeAuthenticatedReadiness(value: unknown): PersonalHomeAuthenticatedReadiness | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.keys(record).some((key) => ![
    'authenticated',
    'homeServerIdentityId',
    'accountCount',
    'sessionCount',
    'teamsBootstrapStatus',
  ].includes(key))) return null;
  if (record.authenticated !== true) return null;
  const homeServerIdentityId = typeof record.homeServerIdentityId === 'string'
    ? record.homeServerIdentityId.trim()
    : '';
  const accountCount = record.accountCount;
  const sessionCount = record.sessionCount;
  const teamsBootstrapStatus = record.teamsBootstrapStatus;
  if (
    !homeServerIdentityId
    || !Number.isSafeInteger(accountCount)
    || Number(accountCount) < 1
    || !Number.isSafeInteger(sessionCount)
    || Number(sessionCount) < 0
    || (teamsBootstrapStatus !== undefined
      && teamsBootstrapStatus !== 'ready'
      && teamsBootstrapStatus !== 'setup_required'
      && teamsBootstrapStatus !== 'teams_unavailable')
  ) return null;
  return {
    authenticated: true,
    homeServerIdentityId,
    accountCount: Number(accountCount),
    sessionCount: Number(sessionCount),
    ...(teamsBootstrapStatus ? { teamsBootstrapStatus } : {}),
  };
}

function parseReadinessReceipt(text: string): Readonly<{
  pid: number;
  readiness: PersonalHomeAuthenticatedReadiness;
}> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const pid = record.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) < 1 || !isPidPresent(Number(pid))) return null;
  const readiness = parsePersonalHomeAuthenticatedReadiness(record.personalHomeReadiness);
  return readiness ? { pid: Number(pid), readiness } : null;
}

/** Reads the server-owned token-free readiness receipt. The caller removes the
 * previous receipt before activation, so only the newly started live process
 * can satisfy this attestation. */
export async function readPersonalHomeStartupReadiness(params: Readonly<{
  path: string;
  timeoutMs?: number;
}>): Promise<PersonalHomeAuthenticatedReadiness> {
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_READINESS_WAIT_MS);
  while (Date.now() <= deadline) {
    const receipt = await readFile(params.path, 'utf8')
      .then(parseReadinessReceipt)
      .catch(() => null);
    if (receipt) return receipt.readiness;
    await new Promise<void>((resolve) => setTimeout(resolve, READINESS_POLL_MS));
  }
  throw new Error('Personal Home authenticated readiness attestation did not arrive');
}

export async function removePersonalHomeStartupReadiness(path: string): Promise<void> {
  await rm(path, { force: true });
}
