import { parseGithubPullRequest } from '../git/refs.mjs';
import { sanitizeStackName } from './names.mjs';

export function inferPrStackBaseName({ happy, happyCli, server, serverLight, fallback = 'pr' }) {
  const parts = [];
  const hn = parseGithubPullRequest(happy)?.number ?? null;
  const cn = parseGithubPullRequest(happyCli)?.number ?? null;
  const sn = parseGithubPullRequest(server)?.number ?? null;
  const sln = parseGithubPullRequest(serverLight)?.number ?? null;
  if (hn) parts.push(`happy${hn}`);
  if (cn) parts.push(`cli${cn}`);
  if (sn) parts.push(`server${sn}`);
  if (sln) parts.push(`light${sln}`);
  return sanitizeStackName(parts.length ? `pr-${parts.join('-')}` : fallback, { fallback, maxLen: 64 });
}

