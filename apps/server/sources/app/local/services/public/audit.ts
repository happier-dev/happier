import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { LocalServicePublicAuditEventV1 } from "@happier-dev/protocol";

import type { LocalServicePublicAuditDependencyEnv } from "@/app/features/catalog/readFeatureEnv";

export type LocalServicePublicAuditRecorderRuntimeOptions = Readonly<{
    auditSinkDurable?: boolean;
    allowTestDevAuditSink?: boolean;
    recordAuditEvent?: (event: LocalServicePublicAuditEventV1) => void;
}>;

export function createLocalServicePublicAuditRecorder(
    dependency: LocalServicePublicAuditDependencyEnv,
): LocalServicePublicAuditRecorderRuntimeOptions {
    if (dependency.kind === "test_dev") {
        return {
            allowTestDevAuditSink: true,
            recordAuditEvent: () => undefined,
        };
    }
    if (dependency.kind !== "jsonl_file") {
        return {};
    }

    return {
        auditSinkDurable: true,
        recordAuditEvent: (event) => {
            mkdirSync(dirname(dependency.path), { recursive: true });
            appendFileSync(dependency.path, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
        },
    };
}
