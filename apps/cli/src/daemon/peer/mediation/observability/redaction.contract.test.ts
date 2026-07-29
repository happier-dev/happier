import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

// B5 / DUP-3 gate: the peer-mediation observability redactor has a single owner in
// `@happier-dev/protocol`. The daemon and server modules may only be thin env-base adapters that
// delegate to the shared protocol owner — they must NOT re-implement the header allowlist, URL
// stripping, or recursive metadata sanitizer (that drift is exactly what this remediation removes).

const here = path.dirname(fileURLToPath(import.meta.url));
const daemonRedaction = path.resolve(here, "redaction.ts");
const serverRedaction = path.resolve(
    here,
    "../../../../../../server/sources/app/api/socket/peer/mediation/observability/redaction.ts",
);

function read(file: string): string {
    return readFileSync(file, "utf8");
}

describe("peer mediation observability redaction single-owner contract", () => {
    it("the daemon redactor imports the shared protocol owner and only binds a url base", () => {
        const source = read(daemonRedaction);
        expect(source).toContain("@happier-dev/protocol");
        expect(source).toContain("redactPeerMediationObservabilityMetadata");
        // No re-implemented header allowlist or recursive sanitizer.
        expect(source).not.toContain("SAFE_HEADER_NAMES");
        expect(source).not.toContain("isUnsafeTelemetryDataKey");
        expect(source).not.toContain("createHash");
    });

    it("the server redactor imports the shared protocol owner and only binds a url base", () => {
        const source = read(serverRedaction);
        expect(source).toContain("@happier-dev/protocol");
        expect(source).toContain("redactSharedPeerMediationObservabilityMetadata");
        expect(source).not.toContain("SAFE_HEADER_NAMES");
        expect(source).not.toContain("isUnsafeTelemetryDataKey");
        expect(source).not.toContain("createHash");
    });
});
