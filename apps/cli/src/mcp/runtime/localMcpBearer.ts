import { randomBytes } from 'node:crypto';

import { secretEquals } from '@/utils/crypto/secretEquals';

/**
 * Per-endpoint bearer for every host-owned local MCP listener (the Session MCP socket, the
 * Windows loopback Session MCP endpoint and plugin-hosted loopback MCP servers). The token
 * reaches clients only through private launch material, never argv or logs.
 */
export type LocalMcpBearer = Readonly<{
    token: string;
    /** `Authorization` header value; empty once retired. */
    readonly authorization: string;
    authenticate: (authorization: string | undefined) => boolean;
    retire: () => void;
}>;

export function createLocalMcpBearer(): LocalMcpBearer {
    const secret = randomBytes(32);
    const token = secret.toString('base64url');
    const authorization = `Bearer ${token}`;
    let retired = false;
    return Object.freeze({
        token,
        get authorization() { return retired ? '' : authorization; },
        authenticate: (candidate: string | undefined): boolean => !retired && secretEquals(candidate, authorization),
        retire: () => {
            retired = true;
            secret.fill(0);
        },
    });
}
