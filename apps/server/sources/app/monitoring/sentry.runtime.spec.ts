import assert from "node:assert/strict";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { expect, it } from "vitest";
import * as Sentry from "@sentry/node";

import { initializeServerSentry } from "./sentry";

it("exports native profiles and redacted telemetry through the configured SDK", async () => {
    const envelopes: string[] = [];
    // The ingest transport is the external boundary; SDK integrations and native profiling remain real.
    const ingest = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const bytes = Buffer.concat(chunks);
            envelopes.push((request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes).toString());
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
        });
    });
    await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
    const address = ingest.address();
    assert.ok(address && typeof address !== "string");

    try {
        // Runtime values distinguish submitted secrets from the SDK's source-code context lines.
        const password = randomUUID();
        const token = randomUUID();
        const pinoMarker = randomUUID();
        initializeServerSentry({
            SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
            SENTRY_ENABLE_LOGS: "true",
            SENTRY_TRACES_SAMPLE_RATE: "1",
            SENTRY_PROFILE_SESSION_SAMPLE_RATE: "1",
        });
        Sentry.withScope((scope) => {
            scope.setContext("fixture", { password, safe: "retained-context-577" });
            Sentry.captureException(new Error("runtime-error-577"));
        });
        Sentry.logger.error("runtime-log-577", { token });
        const pino: typeof import("pino") = createRequire(import.meta.url)("pino");
        const quietOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
        pino({ level: "error" }, quietOutput).error(pinoMarker);
        Sentry.profiler.startProfiler();
        await Sentry.startSpan({ name: "runtime-transaction-577" }, async (span) => {
            span.setAttribute("password", password);
            let checksum = 0;
            for (let i = 0; i < 1_000_000; i++) checksum += Math.sqrt(i);
            expect(checksum).toBeGreaterThan(0);
        });
        Sentry.profiler.stopProfiler();
        expect(await Sentry.flush()).toBe(true);

        const sent = envelopes.join("\n");
        expect(sent).toContain("runtime-error-577");
        expect(sent).toContain("runtime-log-577");
        expect(sent).toContain(pinoMarker);
        expect(sent).toContain("runtime-transaction-577");
        expect(sent).toContain("retained-context-577");
        expect(sent).not.toContain(password);
        expect(sent).not.toContain(token);
        expect(sent).toContain('"type":"profile_chunk"');
    } finally {
        await Sentry.close();
        await new Promise<void>((resolve, reject) => ingest.close((error) => error ? reject(error) : resolve()));
    }
});
