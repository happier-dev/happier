import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { HealthCheckServiceHttpConfigV1Schema, HealthCheckTcpConfigV1Schema,
    HealthCheckDnsConfigV1Schema, HealthCheckHeartbeatConfigV1Schema,
    type HealthCheckDefinitionV1, type HealthCheckSubjectV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { isHealthCheckLoopbackRefusedV1 } from '@happier-dev/protocol/deployments/healthCheckSourceV1';
import { readCertificateHealthCheckV1, readHttpHealthCheckV1,
    type AdmittedHttpHealthCheckV1, type HealthCheckFiniteLeafContextV1 } from './finiteHttpHealthCheck';
import { readDnsHealthCheckV1, readTcpHealthCheckV1 } from './finiteNetworkHealthCheck';

function unavailable(code: string): never {
    throw new PluginError({ code, message: 'The saved health check is unavailable', retryable: false });
}

/** Generic checks have one admission and producer path for both saved subjects. */
export function admitSavedEndpointCheck(input: Readonly<{
    sourceInstanceId: string; check: HealthCheckDefinitionV1; subject: HealthCheckSubjectV1;
    observer: Readonly<{ machineId: string; installationId: string }>; vantage: 'sameMachine' | 'outside';
}>) {
    const { check, subject, observer, vantage } = input;
    const basis = { observer, vantage };
    if (check.kind.localId === 'tcp') {
        const config = HealthCheckTcpConfigV1Schema.safeParse(check.config);
        if (!config.success) return unavailable('source_config_invalid');
        if (isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: observer.machineId,
            kindLocalId: check.kind.localId, config: config.data })) return unavailable('health_check_subject_mismatch');
        return { kind: 'tcp' as const, checkId: check.checkId, value: { ...basis, ...config.data } };
    }
    if (check.kind.localId === 'dns') {
        const config = HealthCheckDnsConfigV1Schema.safeParse(check.config);
        if (!config.success) return unavailable('source_config_invalid');
        return { kind: 'dns' as const, checkId: check.checkId, value: { ...basis, ...config.data } };
    }
    if (check.kind.localId === 'heartbeat') {
        const config = HealthCheckHeartbeatConfigV1Schema.safeParse(check.config);
        if (!config.success) return unavailable('source_config_invalid');
        return { kind: 'heartbeat' as const, checkId: check.checkId,
            value: { ...basis, ...config.data, periodMs: check.periodMs } };
    }
    const config = HealthCheckServiceHttpConfigV1Schema.safeParse(check.config);
    if (!config.success) return unavailable('source_config_invalid');
    if (isHealthCheckLoopbackRefusedV1({ subject, observerMachineId: observer.machineId,
        kindLocalId: check.kind.localId, config: config.data })) return unavailable('health_check_subject_mismatch');
    return { kind: 'httpOrCertificate' as const, checkId: check.checkId, kindId: check.kind.localId,
        value: { sourceInstanceId: input.sourceInstanceId, checkId: check.checkId, subject, observer, vantage,
            target: { ...subject, endpoint: config.data.endpoint, expectStatus: config.data.expectStatus },
            ...(config.data.keyword === undefined ? {} : { keyword: config.data.keyword }),
        } satisfies AdmittedHttpHealthCheckV1 };
}

export async function readSavedEndpointCheck(check: ReturnType<typeof admitSavedEndpointCheck>,
    context: HealthCheckFiniteLeafContextV1,
    readHeartbeat: (checkId: string, value: Extract<ReturnType<typeof admitSavedEndpointCheck>,
        { kind: 'heartbeat' }>['value']) => Promise<Readonly<{ checkId: string; result: import('@happier-dev/plugin-sdk').HealthCheckResultV1;
            nextEligibleAt?: number | null }>>) {
    if (check.kind === 'heartbeat') return readHeartbeat(check.checkId, check.value);
    const result = check.kind === 'tcp' ? await readTcpHealthCheckV1(check.value, context)
        : check.kind === 'dns' ? await readDnsHealthCheckV1(check.value, context)
        : await (check.kindId === 'http' ? readHttpHealthCheckV1 : readCertificateHealthCheckV1)(check.value, context);
    return { checkId: check.checkId, result };
}
