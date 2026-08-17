import { describe, expect, it } from "vitest";

import { deriveSessionSystemRecordAddressKeys } from "./sessionSystemRecordAddressKeys";
import { encodeSessionSystemRecordRevision, parseSessionSystemRecordRevision } from "./sessionSystemRecordRevision";

describe("deriveSessionSystemRecordAddressKeys", () => {
    it.each([
        {
            address: { ownerKind: "host" as const, pluginId: null, namespace: "memory", localId: "memory:summary_shard:v1:1-10" },
            namespaceHex: "94f924d4d5cfbf803c112a9b5276f3f803072a910317f49242f1fb141c018f4b",
            recordHex: "5d29665ec81142c5e283f9ff961b6468fe33afae060ab0119cdd979e0f534f29",
        },
        {
            address: { ownerKind: "plugin" as const, pluginId: "com.exämple.plugin", namespace: "memory", localId: "Ä:一" },
            namespaceHex: "3dad3816c8a25d607129122cb8bd471c548432cf669e21d57e57e7f34a25fa35",
            recordHex: "94a8c2dcd4fc754b09e29c811f185b3b8ca0af4b01449e15f9cc458da24049b5",
        },
    ])("matches the provider-independent golden vector for $address.ownerKind", ({ address, namespaceHex, recordHex }) => {
        const keys = deriveSessionSystemRecordAddressKeys(address);
        expect(Buffer.from(keys.namespaceAddressKey).toString("hex")).toBe(namespaceHex);
        expect(Buffer.from(keys.recordAddressKey).toString("hex")).toBe(recordHex);
    });
});

describe("session system record revisions", () => {
    it("round-trips immutable row identity and version without accepting trailing or non-canonical bytes", () => {
        const revision = encodeSessionSystemRecordRevision({ id: "sysrec_1", version: 41 });
        expect(parseSessionSystemRecordRevision(revision)).toEqual({ id: "sysrec_1", version: 41 });
        expect(parseSessionSystemRecordRevision(`${revision}A`)).toBeNull();
        expect(parseSessionSystemRecordRevision("ssr1.AA==")).toBeNull();
    });
});
