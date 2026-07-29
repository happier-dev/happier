import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import { createVoiceRouteAbortScope } from "./voiceRouteAbortScope";

function createRawReply(): EventEmitter & { destroyed: boolean; writableEnded: boolean } {
    const raw = new EventEmitter() as EventEmitter & { destroyed: boolean; writableEnded: boolean };
    raw.destroyed = false;
    raw.writableEnded = false;
    return raw;
}

describe("createVoiceRouteAbortScope", () => {
    it("aborts and releases listeners when the HTTP response disconnects", () => {
        const raw = createRawReply();
        const scope = createVoiceRouteAbortScope({ raw });

        expect(scope.signal?.aborted).toBe(false);
        expect(raw.listenerCount("close")).toBe(1);
        expect(raw.listenerCount("error")).toBe(1);

        raw.emit("close");

        expect(scope.signal?.aborted).toBe(true);
        expect(raw.listenerCount("close")).toBe(0);
        expect(raw.listenerCount("error")).toBe(0);
    });

    it("releases listeners without aborting after a provider operation settles", () => {
        const raw = createRawReply();
        const scope = createVoiceRouteAbortScope({ raw });

        scope.dispose();
        scope.dispose();

        expect(scope.signal?.aborted).toBe(false);
        expect(raw.listenerCount("close")).toBe(0);
        expect(raw.listenerCount("error")).toBe(0);
    });
});
