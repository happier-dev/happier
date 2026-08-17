import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import {
    readWebhookDeclaredContentLengthV1,
    readWebhookRawBodyV1,
    WebhookRawBodyReadError,
} from "./rawBody";

describe("readWebhookDeclaredContentLengthV1", () => {
    it("accepts only one bounded decimal Content-Length", () => {
        expect(readWebhookDeclaredContentLengthV1("0")).toEqual({ ok: true, bytes: 0 });
        expect(readWebhookDeclaredContentLengthV1("26214400")).toEqual({ ok: true, bytes: 26_214_400 });
        expect(readWebhookDeclaredContentLengthV1(undefined)).toEqual({ ok: false, code: "missing" });
        expect(readWebhookDeclaredContentLengthV1("26214401")).toEqual({ ok: false, code: "tooLarge" });
        for (const value of ["", "-1", "+1", "1.5", " 1", "1 ", ["1"], Number.NaN]) {
            expect(readWebhookDeclaredContentLengthV1(value)).toEqual({ ok: false, code: "invalid" });
        }
    });
});

describe("readWebhookRawBodyV1", () => {
    it("preserves exact chunk bytes and feeds the verifier incrementally", async () => {
        const chunks = [Uint8Array.from([0, 255]), Uint8Array.from([1, 2, 3])];
        const onChunk = vi.fn();
        const body = await readWebhookRawBodyV1({
            body: Readable.from(chunks),
            declaredBytes: 5,
            onChunk,
        });

        expect([...body]).toEqual([0, 255, 1, 2, 3]);
        expect(onChunk.mock.calls.map(([chunk]) => [...chunk])).toEqual([[0, 255], [1, 2, 3]]);
    });

    it("rejects declared maximum plus one before consuming a body byte", async () => {
        const iterator = vi.fn();
        const body = { [Symbol.asyncIterator]: iterator } as AsyncIterable<Uint8Array>;
        await expect(readWebhookRawBodyV1({ body, declaredBytes: 26_214_401 })).rejects.toMatchObject({
            code: "tooLarge",
        });
        expect(iterator).not.toHaveBeenCalled();
    });

    it("rejects actual byte-count mismatches and interrupted streams with bounded codes", async () => {
        await expect(readWebhookRawBodyV1({
            body: Readable.from([Uint8Array.from([1, 2])]),
            declaredBytes: 3,
        })).rejects.toMatchObject({ code: "lengthMismatch" });

        async function* interrupted(): AsyncGenerator<Uint8Array> {
            yield Uint8Array.from([1]);
            throw new Error("payload must never be surfaced");
        }
        const error = await readWebhookRawBodyV1({ body: interrupted(), declaredBytes: 2 }).catch((caught) => caught);
        expect(error).toBeInstanceOf(WebhookRawBodyReadError);
        expect(error).toMatchObject({ code: "streamFailed", message: "Webhook request body stream failed" });
        expect(String(error)).not.toContain("payload must never be surfaced");
    });

    it("cancels a stalled live stream immediately when the ingress deadline aborts", async () => {
        const controller = new AbortController();
        const returnIterator = vi.fn<() => Promise<IteratorResult<Uint8Array>>>(
            async (): Promise<IteratorResult<Uint8Array>> => ({ done: true, value: undefined }),
        );
        const body: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]() {
                return {
                    next: async () => await new Promise<IteratorResult<Uint8Array>>(() => {}),
                    return: returnIterator,
                };
            },
        };
        const outcome = readWebhookRawBodyV1({
            body,
            declaredBytes: 1,
            signal: controller.signal,
        }).then(
            () => ({ kind: "resolved" as const }),
            (error: unknown) => ({
                kind: "rejected" as const,
                code: error instanceof WebhookRawBodyReadError ? error.code : null,
            }),
        );

        await Promise.resolve();
        controller.abort();

        await expect(Promise.race([
            outcome,
            new Promise<Readonly<{ kind: "stillPending" }>>((resolve) => {
                setTimeout(() => resolve({ kind: "stillPending" }), 25);
            }),
        ])).resolves.toEqual({ kind: "rejected", code: "aborted" });
        expect(returnIterator).toHaveBeenCalledTimes(1);
    });

    it("does not wait for an uncooperative iterator close after cancellation", async () => {
        const controller = new AbortController();
        let resolveReturn!: (value: IteratorResult<Uint8Array>) => void;
        const returnIterator = vi.fn(() => new Promise<IteratorResult<Uint8Array>>((resolve) => {
            resolveReturn = resolve;
        }));
        const body: AsyncIterable<Uint8Array> = {
            [Symbol.asyncIterator]() {
                return {
                    next: async () => await new Promise<IteratorResult<Uint8Array>>(() => {}),
                    return: returnIterator,
                };
            },
        };
        const outcome = readWebhookRawBodyV1({
            body,
            declaredBytes: 1,
            signal: controller.signal,
        }).then(
            () => ({ kind: "resolved" as const }),
            (error: unknown) => ({
                kind: "rejected" as const,
                code: error instanceof WebhookRawBodyReadError ? error.code : null,
            }),
        );

        await Promise.resolve();
        controller.abort();

        try {
            await expect(Promise.race([
                outcome,
                new Promise<Readonly<{ kind: "stillPending" }>>((resolve) => {
                    setTimeout(() => resolve({ kind: "stillPending" }), 25);
                }),
            ])).resolves.toEqual({ kind: "rejected", code: "aborted" });
            expect(returnIterator).toHaveBeenCalledTimes(1);
        } finally {
            resolveReturn({ done: true, value: undefined });
        }
    });
});
