import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';

type AccountEncryptionMode = 'plain' | 'e2ee';

export type AccountEncryptionModeReadResult =
  | Readonly<{ kind: 'resolved'; mode: AccountEncryptionMode }>
  | Readonly<{ kind: 'http_error'; status: number }>
  | Readonly<{ kind: 'invalid_response'; status: number }>;

export async function readAccountEncryptionModeOnce(input: Readonly<{
  request: () => Promise<Readonly<{ status: number; data: unknown }>>;
}>): Promise<AccountEncryptionModeReadResult> {
  const response = await input.request();
  if (response.status < 200 || response.status >= 300) {
    return { kind: 'http_error', status: response.status };
  }
  const parsed = AccountEncryptionModeResponseSchema.safeParse(response.data);
  return parsed.success
    ? { kind: 'resolved', mode: parsed.data.mode }
    : { kind: 'invalid_response', status: response.status };
}
