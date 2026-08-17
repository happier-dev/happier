import {
    DetectedMcpServerV1Schema,
} from '@happier-dev/protocol';
import type {
    DaemonMcpServersDetectWarningV1,
    DetectedMcpServerV1,
} from '@happier-dev/protocol';
import type { PluginExecSpawnRequest } from './services/io.js';

export type McpServerTransportV1 =
    | Readonly<{
        kind: 'hosted';
        exposure?:
            | Readonly<{ kind: 'registryOnly' }>
            | Readonly<{ kind: 'loopbackHttp'; requested: true }>;
    }>
    | Readonly<{
        kind: 'stdio';
        launch: PluginExecSpawnRequest;
    }>
    | Readonly<{
        kind: 'http' | 'sse';
        url: string;
    }>;

export type McpDiscoveryWarningV1 = DaemonMcpServersDetectWarningV1;
export type {
    DaemonMcpServersDetectWarningV1,
    DetectedMcpServerV1,
};

export function normalizeDetectedMcpServerV1(value: unknown): DetectedMcpServerV1 | null {
    const parsed = DetectedMcpServerV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
