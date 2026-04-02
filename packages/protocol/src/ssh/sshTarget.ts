export type ParsedSshTarget = Readonly<{
  username: string;
  host: string;
}>;

export function parseSshTarget(value: string): ParsedSshTarget {
  const text = String(value ?? '').trim();
  if (!text) {
    return {
      username: '',
      host: '',
    };
  }

  const atIndex = text.lastIndexOf('@');
  if (atIndex > 0) {
    return {
      username: text.slice(0, atIndex).trim(),
      host: text.slice(atIndex + 1).trim(),
    };
  }

  return {
    username: '',
    host: text,
  };
}

export function buildSshTarget(params: Readonly<{
  username: string;
  host: string;
}>): string {
  const username = String(params.username ?? '').trim();
  const host = String(params.host ?? '').trim();
  if (!host) {
    return '';
  }
  return username ? `${username}@${host}` : host;
}
