import type { Credentials } from '@/persistence';
import { readCredentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';

export type SessionCommandResumeDelegationDecision =
  | Readonly<{ kind: 'delegate'; sessionId: string }>
  | Readonly<{ kind: 'continue' }>;

type ReadCredentials = () => Promise<Credentials | null>;
type EnsureAuth = () => Promise<Readonly<{ credentials: Credentials }>>;
type FetchSessionById = (params: Readonly<{
  token: string;
  sessionId: string;
}>) => Promise<unknown | null>;

export type SessionCommandResumeDelegationParams = Readonly<{
  args: readonly string[];
  explicitProviderSubcommand: boolean;
  resumeFlags: readonly string[];
  readCredentialsFn?: ReadCredentials;
  ensureAuthFn?: EnsureAuth;
  fetchSessionByIdFn?: FetchSessionById;
}>;

const continueDecision: SessionCommandResumeDelegationDecision = { kind: 'continue' };

function isExplicitFlagValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-');
}

function readInlineResumeFlagValue(arg: string, resumeFlags: readonly string[]): string | null {
  for (const flag of resumeFlags) {
    if (!flag.startsWith('--')) continue;
    const prefix = `${flag}=`;
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length);
      return isExplicitFlagValue(value) ? value : null;
    }
  }
  return null;
}

export function readSessionCommandResumeFlagValue(
  args: readonly string[],
  resumeFlags: readonly string[],
): string | null {
  const normalizedFlags = resumeFlags.filter((flag) => flag.length > 0);
  if (normalizedFlags.length === 0) return null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const inlineValue = readInlineResumeFlagValue(arg, normalizedFlags);
    if (inlineValue) return inlineValue;
    if (!normalizedFlags.includes(arg)) continue;

    const next = args[index + 1];
    return isExplicitFlagValue(next) ? next : null;
  }

  return null;
}

async function resolveCredentials(params: Readonly<{
  readCredentialsFn: ReadCredentials;
  ensureAuthFn: EnsureAuth;
}>): Promise<Credentials | null> {
  const existing = await params.readCredentialsFn();
  if (existing) return existing;
  return (await params.ensureAuthFn()).credentials;
}

export async function resolveSessionCommandResumeDelegation(
  params: SessionCommandResumeDelegationParams,
): Promise<SessionCommandResumeDelegationDecision> {
  if (params.explicitProviderSubcommand) return continueDecision;

  const sessionId = readSessionCommandResumeFlagValue(params.args, params.resumeFlags);
  if (!sessionId) return continueDecision;

  const readCredentialsFn = params.readCredentialsFn ?? readCredentials;
  const ensureAuthFn = params.ensureAuthFn ?? authAndSetupMachineIfNeeded;
  const fetchSessionByIdFn = params.fetchSessionByIdFn ?? fetchSessionById;

  try {
    const credentials = await resolveCredentials({ readCredentialsFn, ensureAuthFn });
    if (!credentials) return continueDecision;
    const session = await fetchSessionByIdFn({ token: credentials.token, sessionId });
    return session ? { kind: 'delegate', sessionId } : continueDecision;
  } catch {
    return continueDecision;
  }
}
