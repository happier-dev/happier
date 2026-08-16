import {
    buildAccountConnectRoutePath,
    parseAccountConnectDeepLink,
} from '@/auth/pairing/accountConnectUrl';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
    const accountConnect = parseAccountConnectDeepLink(path);
    if (!accountConnect) return path;

    return buildAccountConnectRoutePath(accountConnect);
}
