export type BitbucketBasicAuthCredentials = Readonly<{
  username: string;
  password: string;
}>;

export function readBitbucketBasicAuthCredentials(
  username: string | null | undefined,
  password: string | null | undefined,
): BitbucketBasicAuthCredentials | null {
  const normalizedUsername = username?.trim() ?? '';
  const normalizedPassword = password?.trim() ?? '';
  if (!normalizedUsername || !normalizedPassword) return null;
  return { username: normalizedUsername, password: normalizedPassword };
}

export function encodeBitbucketBasicAuthorization(
  credentials: BitbucketBasicAuthCredentials,
): string {
  const bytes = new TextEncoder().encode(`${credentials.username}:${credentials.password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
