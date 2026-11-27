import type { GitlabConfiguredOrigin } from '../triage/origin.js';

export function readGitlabMergeRequestUrl(
  origin: GitlabConfiguredOrigin,
  value: string,
): Readonly<{ repositoryPath: string; iid: string }> | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.origin !== origin.origin || url.username || url.password || url.search || url.hash) return null;
  const prefix = `${origin.pathPrefix}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  const match = /^(.+)\/-\/merge_requests\/([1-9][0-9]*)$/u.exec(url.pathname.slice(prefix.length));
  if (!match) return null;
  const [, repositoryPath, iid] = match;
  const segments = repositoryPath.split('/');
  if (segments.length < 2 || segments.some(segment => !/^[A-Za-z0-9_.-]+$/u.test(segment))) return null;
  return { repositoryPath, iid };
}
