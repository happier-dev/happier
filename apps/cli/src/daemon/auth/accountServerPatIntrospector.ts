import axios from "axios";
import { z } from "zod";

import { normalizeServerHttpBaseUrl, resolveServerHttpBaseUrl } from "@/api/client/serverHttpBaseUrl";

import { type DaemonPatIntrospector } from "./daemonPatVerifier";

const API_TOKEN_INTROSPECTION_PATH = "/v1/auth/api-tokens/introspect";

const apiTokenIntrospectionResponseSchema = z.object({
    accountId: z.string().min(1),
    principalId: z.string().min(1),
    credentialId: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    authority: z.literal("account_automation"),
}).strict();

type AccountServerPatIntrospectorOptions = Readonly<{
    /** Existing signed credential for the daemon's Account-server connection. */
    daemonConnectionToken: string;
    serverBaseUrl?: string;
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

    const serverBaseUrl = normalizeServerHttpBaseUrl(options.serverBaseUrl ?? resolveServerHttpBaseUrl());
    const url = `${serverBaseUrl}${API_TOKEN_INTROSPECTION_PATH}`;

    return async (token, signal) => {
        try {
            signal?.throwIfAborted();
            const response = await axios.post<unknown>(
                url,
                { token },
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
                return { ok: false, code: "invalid_token" };
            }
            if (response.status < 200 || response.status >= 300) {
                return { ok: false, code: "auth_unavailable" };
            }

            const parsed = apiTokenIntrospectionResponseSchema.safeParse(response.data);
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
