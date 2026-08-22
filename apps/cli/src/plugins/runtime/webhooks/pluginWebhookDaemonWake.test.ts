import { describe, expect, it, vi } from "vitest";

import type { ApiMachineClient } from "@/api/apiMachine";
import type { Update } from "@/api/types";

import { attachPluginWebhookDaemonWakeV1 } from "./pluginWebhookDaemonWake";

type UpdateListener = (update: Update) => boolean | void;

describe("plugin webhook daemon wake", () => {
    it("nudges the existing single-flight claim worker only for canonical AccountChange hints", () => {
        const listener = { current: null as UpdateListener | null };
        const unsubscribe = vi.fn();
        const onUpdate: Pick<ApiMachineClient, "onUpdate">["onUpdate"] = (next) => {
            listener.current = next;
            return unsubscribe;
        };
        const trigger = vi.fn();
        const cleanup = attachPluginWebhookDaemonWakeV1({
            apiMachine: { onUpdate },
            getWorker: () => ({ trigger }),
        });

        expect(listener.current?.({
            id: "update-machine-1",
            seq: 1,
            createdAt: 1,
            body: { t: "update-machine", machineId: "machine-1" },
        })).toBeUndefined();
        expect(trigger).not.toHaveBeenCalled();
        expect(listener.current?.({
            id: "account-change-1",
            seq: 2,
            createdAt: 2,
            body: { t: "account-change" },
        })).toBe(true);
        expect(trigger).toHaveBeenCalledTimes(1);

        cleanup();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
});
