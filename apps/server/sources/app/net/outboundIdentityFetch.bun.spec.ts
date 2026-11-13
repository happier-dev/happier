import { execFile, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createEphemeralTlsServerFixture } from "../../../../../packages/tests/src/testkit/tls/ephemeralTlsServerFixture.mjs";

function resolveBunExecutable(): string | null {
    const explicit = String(process.env.HAPPIER_TEST_BUN_EXECUTABLE ?? "").trim();
    if (explicit) return explicit;
    const result = spawnSync(process.platform === "win32" ? "where" : "which", ["bun"], { encoding: "utf8" });
    if (result.status !== 0) return null;
    return String(result.stdout ?? "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

const bunExecutable = resolveBunExecutable();
const runtimeIt = bunExecutable ? it : it.skip;

describe("outbound peer-pinned fetch on Bun (the light server's runtime)", () => {
    // Bun maps a bare `undici` to its builtin, whose fetch ignores the dispatcher: the
    // pinned connector, its TLS options and the connected-peer check never run, and Bun
    // resolves the hostname itself. Its Agent also has no destroy.
    runtimeIt("dials the policy-validated address through the pinned connector and closes", async () => {
        const tls = await createEphemeralTlsServerFixture({ additionalDnsNames: ["issuer.invalid"] });
        const server = createServer({
            key: await readFile(tls.privateKeyPath),
            cert: await readFile(tls.leafCertificatePath),
        }, (_request, response) => response.end("pinned-ok"));
        const tempDir = await mkdtemp(join(tmpdir(), "happier-outbound-bun-"));
        try {
            server.listen(0, "127.0.0.1");
            await once(server, "listening");
            const address = server.address();
            if (!address || typeof address === "string") throw new Error("Missing test listener");
            const ownerUrl = pathToFileURL(fileURLToPath(new URL("./outboundIdentityFetch.ts", import.meta.url))).href;
            const fixturePath = join(tempDir, "probe.ts");
            await writeFile(fixturePath, [
                "import { readFileSync } from 'node:fs';",
                `const { createOutboundFetch } = await import(${JSON.stringify(ownerUrl)});`,
                "const result = {};",
                "try {",
                "  const outbound = createOutboundFetch({",
                `    policy: { address: { kind: 'privateAllowlist', hostnames: ['issuer.invalid'], cidrs: ['127.0.0.0/8'] }, allowedPorts: [${address.port}], allowLoopbackHttp: false },`,
                // DNS is the boundary: only the pinned connector can reach this name.
                "    resolveAddresses: async () => ['127.0.0.1'],",
                `    tlsOptions: { ca: readFileSync(${JSON.stringify(tls.caCertificatePath)}) },`,
                "  });",
                `  const response = await outbound.fetch('https://issuer.invalid:${address.port}/probe');`,
                "  result.body = await response.text();",
                "  await outbound.close();",
                "  result.closed = true;",
                "} catch (error) {",
                "  result.error = String(error?.code ?? error?.message ?? error);",
                "}",
                "console.log(JSON.stringify(result));",
                "process.exit(0);",
                "",
            ].join("\n"), "utf8");

            // Asynchronous: the issuer listens in this process and must keep serving.
            const { stdout } = await promisify(execFile)(bunExecutable!, [fixturePath], { encoding: "utf8", timeout: 60_000 });
            const line = stdout.trim().split(/\r?\n/u).at(-1) ?? "";
            expect(JSON.parse(line)).toEqual({ body: "pinned-ok", closed: true });
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(tempDir, { recursive: true, force: true });
            await tls.cleanup();
        }
    });
});
