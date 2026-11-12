import { classifyServerEndpointError } from './classifyServerEndpointError';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { readObservedAccountEncryptionCurrentness } from './accountEncryptionCurrentnessObservation';
import { admitCliReportedAccountMode, type AccountModeRequestCredential } from './accountModeAdmission';

type AccountEncryptionMode = 'plain' | 'e2ee';

export type AccountEncryptionModeReadResult =
  | Readonly<{ kind: 'resolved'; mode: AccountEncryptionMode }>
  | Readonly<{ kind: 'http_error'; status: number }>
  | Readonly<{ kind: 'invalid_response'; status: number }>;

export async function readAccountEncryptionModeOnce(input: Readonly<{
  request: () => Promise<Readonly<{ status: number; data: unknown }>>;
  /** The credential that made `request`; its custody admits a reported plain. */
  credentials: AccountModeRequestCredential;
  scope?: Readonly<{ token: string; serverBaseUrl: string; signal?: AbortSignal }>;
  /** Only descriptive identity may borrow; final authority stays fresh. */
  usage?: 'identity' | 'fresh-authority';
}>): Promise<AccountEncryptionModeReadResult> {
  const observed = input.usage === 'identity' && input.scope ? readObservedAccountEncryptionCurrentness(input.scope) : null;
  if (observed) {
    try { return { kind: 'resolved', mode: (await observed).mode }; }
    catch (error) {
      // Currentness availability is not persisted Account mode. Read that
      // authority directly when its observation transport is unavailable; this
      // neither publishes an identity nor grants currentness. Refusals and
      // retired/aborted custody still fail closed with their original cause.
      const failure = classifyServerEndpointError(error);
      if (input.scope?.signal?.aborted || (failure.statusCode !== 404
        && failure.kind !== 'network' && failure.kind !== 'timeout' && failure.kind !== 'server_error')) throw error;
    }
  }
  const response = await input.request();
  if (response.status < 200 || response.status >= 300) {
    return { kind: 'http_error', status: response.status };
  }
  const parsed = AccountEncryptionModeResponseSchema.safeParse(response.data);
  return parsed.success
    ? { kind: 'resolved', mode: await admitCliReportedAccountMode(parsed.data.mode, input.credentials) }
    : { kind: 'invalid_response', status: response.status };
}
