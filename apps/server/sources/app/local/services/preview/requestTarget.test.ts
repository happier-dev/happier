import { describe, expect, it } from "vitest";

import {
    encodeLocalServiceRequestPath,
    isSafeLocalServiceHeaderField,
    isSafeLocalServiceRequestTarget,
} from "./requestTarget";

/**
 * Owner-level coverage for the S-1 request-target canonicalizer.
 *
 * This module deliberately imports nothing but itself, so these assertions hold even when the
 * wider workspace is mid-change. The composed proof that the ROUTER's decoded output reaches this
 * owner lives in `api/routes/local/services/publicExposureDataPlane.test.ts`.
 */

// Exactly what `find-my-way@9.6.0` puts in `params['*']` for a request path of
// `foo%0d%0aX-Injected:%20yes%0d%0a%0d%0aGET%20/admin%20HTTP/1.1` (reproduced live).
const ROUTER_DECODED_CRLF_PATH = "foo\r\nX-Injected: yes\r\n\r\nGET /admin HTTP/1.1";

describe("local service request target", () => {
    it("neutralizes a router-decoded CRLF so it cannot terminate a request line", () => {
        const encoded = encodeLocalServiceRequestPath(ROUTER_DECODED_CRLF_PATH);

        expect(encoded).toBe("/foo%0D%0AX-Injected:%20yes%0D%0A%0D%0AGET%20/admin%20HTTP/1.1");
        expect(encoded).not.toContain("\r");
        expect(encoded).not.toContain("\n");
        expect(encoded).not.toContain(" ");
        expect(isSafeLocalServiceRequestTarget(encoded)).toBe(true);
        // The guard must reject the raw value, so removing the encoder cannot pass silently.
        expect(isSafeLocalServiceRequestTarget(`/${ROUTER_DECODED_CRLF_PATH}`)).toBe(false);
    });

    it("round-trips the bytes the client actually sent", () => {
        // The router decodes exactly once, so encoding exactly once restores the wire form.
        for (const [clientSent, routerDecoded] of [
            ["/assets/app.js", "assets/app.js"],
            ["/a%2Fb", "a/b"],
            ["/a%2500b", "a%00b"],
            ["/%D1%84%D0%B0%D0%B9%D0%BB", "файл"],
            ["/x?y", "x?y"],
            ["/x%23y", "x#y"],
        ] as const) {
            const encoded = encodeLocalServiceRequestPath(routerDecoded);
            expect(isSafeLocalServiceRequestTarget(encoded)).toBe(true);
            expect(decodeURIComponent(encoded)).toBe(decodeURIComponent(clientSent));
        }
    });

    it("keeps ordinary path characters readable instead of over-encoding them", () => {
        expect(encodeLocalServiceRequestPath("assets/app.js")).toBe("/assets/app.js");
        expect(encodeLocalServiceRequestPath("a/b;c=d,e@f:g")).toBe("/a/b;c=d,e@f:g");
    });

    it("always produces exactly one leading separator so it cannot become protocol-relative", () => {
        expect(encodeLocalServiceRequestPath("")).toBe("/");
        expect(encodeLocalServiceRequestPath("/")).toBe("/");
        // `//evil.example` in a `Location` header is a scheme-relative redirect to another host.
        expect(encodeLocalServiceRequestPath("//evil.example/x")).toBe("/evil.example/x");
        expect(encodeLocalServiceRequestPath("///evil.example")).toBe("/evil.example");
    });

    it("rejects request targets and header fields that could split the wire framing", () => {
        expect(isSafeLocalServiceRequestTarget("/ok?a=b")).toBe(true);
        expect(isSafeLocalServiceRequestTarget("no-leading-slash")).toBe(false);
        expect(isSafeLocalServiceRequestTarget("/has space")).toBe(false);
        expect(isSafeLocalServiceRequestTarget("/has\rcr")).toBe(false);
        expect(isSafeLocalServiceRequestTarget("/has\nlf")).toBe(false);
        expect(isSafeLocalServiceRequestTarget("/has\u0000nul")).toBe(false);
        expect(isSafeLocalServiceRequestTarget("/has\u007fdel")).toBe(false);

        expect(isSafeLocalServiceHeaderField("bytes=0-3")).toBe(true);
        // Spaces and tabs are legal inside a header value; only the framing bytes are not.
        expect(isSafeLocalServiceHeaderField("has\ttab")).toBe(true);
        expect(isSafeLocalServiceHeaderField("has space")).toBe(true);
        expect(isSafeLocalServiceHeaderField("a\r\nX-Injected: yes")).toBe(false);
        expect(isSafeLocalServiceHeaderField("a\nX-Injected: yes")).toBe(false);
        expect(isSafeLocalServiceHeaderField("a\rX-Injected: yes")).toBe(false);
        expect(isSafeLocalServiceHeaderField("a\u0000b")).toBe(false);
    });
});
