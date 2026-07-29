import { isIP } from 'node:net';

export type UrlConnectionIdentity = Readonly<{
  hostname: string;
  servername: string | undefined;
}>;

export function resolveUrlConnectionIdentity(urlHostname: string): UrlConnectionIdentity {
  const hostname = urlHostname.startsWith('[') && urlHostname.endsWith(']')
    ? urlHostname.slice(1, -1)
    : urlHostname;
  return {
    hostname,
    servername: isIP(hostname) === 0 ? hostname : undefined,
  };
}
