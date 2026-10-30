import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAllDocuments } from "yaml";
import { describe, expect, it } from "vitest";

interface KubernetesDocument {
    kind?: string;
    metadata?: { name?: string };
    data?: Record<string, string>;
    spec?: {
        replicas?: number;
        strategy?: {
            type?: string;
            rollingUpdate?: unknown;
        };
        template?: {
            spec?: {
                containers?: Array<{
                    envFrom?: Array<{ configMapRef?: { name?: string } }>;
                }>;
            };
        };
    };
}

function readDeploymentDocuments(file: string): KubernetesDocument[] {
    const source = readFileSync(join(import.meta.dirname, "../deploy", file), "utf8");
    return parseAllDocuments(source).map((document) => document.toJS() as KubernetesDocument);
}

describe("server Kubernetes deployment manifest", () => {
    it("replaces a single memory-adapter server without overlapping independent socket servers", () => {
        const apiDeployment = readDeploymentDocuments("server.yaml").find(
            (document) => document.kind === "Deployment" && document.metadata?.name === "happier-server",
        );
        const config = readDeploymentDocuments("config.yaml").find(
            (document) => document.kind === "ConfigMap" && document.metadata?.name === "happier-server-config",
        );

        expect(apiDeployment).toBeDefined();
        expect(apiDeployment?.spec?.replicas).toBe(1);
        expect(apiDeployment?.spec?.template?.spec?.containers?.[0]?.envFrom).toEqual(
            expect.arrayContaining([
                { configMapRef: { name: "happier-server-config" } },
            ]),
        );
        expect(config?.data).toMatchObject({
            SERVER_ROLE: "all",
            HAPPIER_SOCKET_ADAPTER: "memory",
            RUN_MIGRATIONS: "0",
        });
        expect(apiDeployment?.spec?.strategy).toEqual({ type: "Recreate" });
    });
});
