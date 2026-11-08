/**
 * A remote's browsable page, read from the URL git reports for it (`fetchUrl`/`pushUrl`).
 *
 * Only network remotes have one: `https://host/path`, `ssh://[user@]host[:port]/path` and the scp-like
 * `user@host:path`. Credentials, a port and a trailing `.git` never reach the page URL. Local paths,
 * `file://` URLs and anything else return `null`, so a caller never offers a link that leads nowhere.
 */
export type ScmRemoteWebLink = Readonly<{ url: string; path: string }>;

const SCP_LIKE = /^[^\s/@:]+@([^\s/:]+):(?!\/)(.+)$/;

export function resolveScmRemoteWebLink(
  remoteUrl: string,
): ScmRemoteWebLink | null {
  const value = remoteUrl.trim();
  let host: string;
  let rawPath: string;
  const scp = SCP_LIKE.exec(value);
  if (scp) {
    host = scp[1]!;
    rawPath = scp[2]!;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (
      parsed.protocol !== 'https:' &&
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'ssh:' &&
      parsed.protocol !== 'git:'
    )
      return null;
    host = parsed.hostname;
    rawPath = parsed.pathname;
  }
  const path = rawPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!host || !path || !path.includes('/')) return null;
  return { url: `https://${host}/${path}`, path };
}
