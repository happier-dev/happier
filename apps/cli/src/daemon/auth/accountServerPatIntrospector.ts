import axios from "axios";
import {
    ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1,
    AccountApiTokenIntrospectionSubjectFailureV1Schema,
    AccountApiTokenIntrospectionSuccessV1Schema,
    type AccountApiTokenIntrospectionRequestV1,
} from "@happier-dev/protocol";

import { normalizeServerHttpBaseUrl } from "@/api/client/serverHttpBaseUrl";

import { type DaemonPatIntrospector } from "./daemonPatVerifier";

type AccountServerPatIntrospectorOptions = Readonly<{
    /** Existing signed credential for the daemon's Account-server connection. */
    daemonConnectionToken: string;
    /** Resolved Account-server URL for this daemon lifecycle. */
    serverBaseUrl: string;
}>;

/**
 * Calls the Account server's canonical PAT verifier. This is deliberately a
 * small transport adapter: cache policy and public Action HTTP handling stay
 * outside it, and bearer material is never logged or placed in a URL.
 */
export function createAccountServerPatIntrospector(
    options: AccountServerPatIntrospectorOptions,
): DaemonPatIntrospector {
    if (!options.daemonConnectionToken.trim()) {
        throw new Error("Account-server PAT introspection requires a daemon connection token");
    }

    const serverBaseUrl = normalizeServerHttpBaseUrl(options.serverBaseUrl);
    const url = `${serverBaseUrl}${ACCOUNT_API_TOKEN_INTROSPECTION_HTTP_PATH_V1}`;

    return async (token, signal) => {
        try {
            signal?.throwIfAborted();
            const requestBody = { token } satisfies AccountApiTokenIntrospectionRequestV1;
            const response = await axios.post<unknown>(
                url,
                requestBody,
                {
                    headers: {
                        Authorization: `Bearer ${options.daemonConnectionToken}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 15_000,
                    ...(signal ? { signal } : {}),
                    validateStatus: () => true,
                },
            );
            signal?.throwIfAborted();

            if (response.status === 401) {
                return AccountApiTokenIntrospectionSubjectFailureV1Schema.safeParse(response.data).success
                    ? { ok: false, code: "invalid_token" }
                    : { ok: false, code: "auth_unavailable" };
            }
            if (response.status < 200 || response.status >= 300) {
                return { ok: false, code: "auth_unavailable" };
            }

            const parsed = AccountApiTokenIntrospectionSuccessV1Schema.safeParse(response.data);
            if (!parsed.success) {
                return { ok: false, code: "auth_unavailable" };
            }

            return {
                ok: true,
                accountId: parsed.data.accountId,
                principalId: parsed.data.principalId,
                credentialId: parsed.data.credentialId,
                expiresAt: parsed.data.expiresAt === null ? null : new Date(parsed.data.expiresAt),
                authority: parsed.data.authority,
            };
        } catch (error) {
            if (signal?.aborted) {
                throw error;
            }
            return { ok: false, code: "auth_unavailable" };
        }
    };
}
