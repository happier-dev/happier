import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { OtlpAdmission } from '../otlp/types.js';
import type { DeploymentTelemetryAssignmentV1 } from '@happier-dev/plugin-sdk';

export type TelemetryAssignment = DeploymentTelemetryAssignmentV1;
export type TelemetryContext = Readonly<{ partition: string; environmentId: string;
    capabilities?: DeploymentTelemetryAssignmentV1['capabilities'] }>;
export const TELEMETRY_PARTITION_PREFIX = 'environment:';
export const telemetryPartition = (environmentId: string): string => `${TELEMETRY_PARTITION_PREFIX}${environmentId}`;

type RefreshAssignments = () => Promise<void>;
const refusedTelemetryToken = { accepted: false, status: 401, message: 'Invalid telemetry token' } as const;

export function createTelemetryAssignments() {
    let byHash = new Map<string, { digest: Buffer; context: TelemetryContext }>();
    function lookup(digest: Buffer): OtlpAdmission<TelemetryContext> {
        const assignment = byHash.get(digest.toString('hex'));
        return assignment && timingSafeEqual(digest, assignment.digest)
            ? { accepted: true, context: assignment.context }
            : refusedTelemetryToken;
    }

    function admit(request: IncomingMessage): OtlpAdmission<TelemetryContext>;
    function admit(request: IncomingMessage, refresh: RefreshAssignments): OtlpAdmission<TelemetryContext> | Promise<OtlpAdmission<TelemetryContext>>;
    function admit(request: IncomingMessage, refresh?: RefreshAssignments) {
        const authorization = request.headers.authorization;
        const match = authorization && /^Bearer ([^\s]+)$/i.exec(authorization);
        if (!match) return refusedTelemetryToken;

        const digest = createHash('sha256').update(match[1]!).digest();
        const result = lookup(digest);
        return result.accepted || !refresh ? result : refresh().then(() => lookup(digest), () => refusedTelemetryToken);
    }

    return {
        replace(assignments: readonly TelemetryAssignment[]): void {
            byHash = new Map();
            for (const assignment of assignments) {
                if (assignment.tokenHash === null) continue;
                byHash.set(assignment.tokenHash, {
                    digest: Buffer.from(assignment.tokenHash, 'hex'),
                    context: { partition: telemetryPartition(assignment.environmentId), environmentId: assignment.environmentId,
                        ...(assignment.capabilities === undefined ? {} : { capabilities: assignment.capabilities }) },
                });
            }
        },
        admit,
    };
}
