import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";

type OidcCodeRecord = { nonce: string };

type StartOidcStubServerOptions = {
    includeRefreshToken?: boolean;
    includeUserInfoEndpoint?: boolean;
    userInfoClaims?: Record<string, unknown>;
};

export type OidcStubServer = {
    issuer: string;
    close: () => Promise<void>;
    reset: () => void;
};

function base64Url(input: Buffer): string {
    return input.toString("base64url");
}

function signJwtRs256(params: {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
    privateKeyPem: string;
}): string {
    const encodedHeader = base64Url(Buffer.from(JSON.stringify(params.header), "utf8"));
    const encodedPayload = base64Url(Buffer.from(JSON.stringify(params.payload), "utf8"));
    const data = `${encodedHeader}.${encodedPayload}`;
    const signer = createSign("RSA-SHA256");
    signer.update(data);
    signer.end();
    const signature = signer.sign(params.privateKeyPem);
    return `${data}.${base64Url(signature)}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

export async function startOidcStubServer(options: StartOidcStubServerOptions = {}): Promise<OidcStubServer> {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const kid = "k1";
    const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
    publicJwk.kid = kid;
    publicJwk.use = "sig";
    publicJwk.alg = "RS256";
    const jwks = { keys: [publicJwk] };
    const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString("utf8");

    const authCodes = new Map<string, OidcCodeRecord>();
    let issuer = "";

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", issuer);

        if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    issuer,
                    authorization_endpoint: `${issuer}/authorize`,
                    token_endpoint: `${issuer}/token`,
                    jwks_uri: `${issuer}/jwks`,
                    ...(options.includeUserInfoEndpoint ? { userinfo_endpoint: `${issuer}/userinfo` } : {}),
                    response_types_supported: ["code"],
                    subject_types_supported: ["public"],
                    id_token_signing_alg_values_supported: ["RS256"],
                }),
            );
            return;
        }

        if (req.method === "GET" && url.pathname === "/jwks") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(jwks));
            return;
        }

        if (req.method === "GET" && url.pathname === "/authorize") {
            const state = url.searchParams.get("state") ?? "";
            const redirectUri = url.searchParams.get("redirect_uri") ?? "";
            const nonce = url.searchParams.get("nonce") ?? "";
            const code = `code_${Math.random().toString(16).slice(2)}`;
            authCodes.set(code, { nonce });

            const redirect = new URL(redirectUri);
            redirect.searchParams.set("code", code);
            if (state) {
                redirect.searchParams.set("state", state);
            }
            res.statusCode = 302;
            res.setHeader("location", redirect.toString());
            res.end();
            return;
        }

        if (req.method === "POST" && url.pathname === "/token") {
            const body = await readBody(req);
            const params = new URLSearchParams(body);
            const code = params.get("code") ?? "";
            const record = authCodes.get(code);
            if (!record) {
                res.statusCode = 400;
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ error: "invalid_grant" }));
                return;
            }

            const idToken = signJwtRs256({
                header: { typ: "JWT", alg: "RS256", kid },
                payload: {
                    iss: issuer,
                    aud: "oidc_client",
                    sub: "user_1",
                    nonce: record.nonce,
                    exp: Math.floor(Date.now() / 1000) + 600,
                    iat: Math.floor(Date.now() / 1000),
                    preferred_username: "acme_user",
                    email: "acme_user@example.test",
                    groups: ["eng"],
                },
                privateKeyPem,
            });

            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    access_token: "at_1",
                    token_type: "Bearer",
                    expires_in: 600,
                    id_token: idToken,
                    ...(options.includeRefreshToken ? { refresh_token: "rt_1" } : {}),
                }),
            );
            return;
        }

        if (options.includeUserInfoEndpoint && (req.method === "POST" || req.method === "GET") && url.pathname === "/userinfo") {
            res.statusCode = 200;
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify(
                    options.userInfoClaims ?? {
                        email: "userinfo@example.test",
                        preferred_username: "userinfo_name",
                        groups: ["platform"],
                    },
                ),
            );
            return;
        }

        res.statusCode = 404;
        res.end("not found");
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("failed to bind oidc stub server");
    }
    issuer = `http://127.0.0.1:${address.port}`;

    return {
        issuer,
        close: async () => {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        },
        reset: () => {
            authCodes.clear();
        },
    };
}
