import { isAbsolute, relative, sep } from 'node:path';
import { isLiteralLoopbackHostname } from '@happier-dev/protocol';
import type { DeploymentApprovalReviewV1 } from '@happier-dev/deployment-protocol/v1';
import { isNativeDefinitionRecord as record } from './nativePackageScripts';

export type NativeComposeRuntimeReview = Pick<Extract<DeploymentApprovalReviewV1, { inspection: string }>,
    'inspection' | 'services' | 'risks'>;
type Scalar = NativeComposeRuntimeReview['services'][number]['replicas'];
type RiskKind = NativeComposeRuntimeReview['risks'][number]['kind'];

/** Only native effective facts enter review. Raw env/config/argv never leave this capture. */
export function projectNativeComposeReview(model: Readonly<Record<string, unknown>>, releaseRoot: string,
    redact: (value: string) => string): NativeComposeRuntimeReview {
    const services: NativeComposeRuntimeReview['services'][number][] = [];
    const risks: NativeComposeRuntimeReview['risks'][number][] = [];
    let inspection: NativeComposeRuntimeReview['inspection'] = 'complete';
    const scalar = (value: unknown): Scalar => {
        if (typeof value !== 'string' && typeof value !== 'number') return null;
        const text = String(value);
        const safe = redact(text);
        return safe === text ? value : safe;
    };
    const text = (value: unknown) => typeof value === 'string' ? redact(value) : null;
    for (const [name, value] of Object.entries(record(model.services) ? model.services : {})) {
        const service = redact(name);
        const kinds = new Set<RiskKind>();
        const risk = (kind: RiskKind) => { if (!kinds.has(kind)) { kinds.add(kind); risks.push({ kind, service }); } };
        const unknown = () => { inspection = 'unknown'; risk('inspection_unknown'); };
        if (!record(value)) { unknown(); continue; }
        if (value.privileged === true) risk('privileged');
        if (value.network_mode === 'host') risk('host_network');
        if (value.pid === 'host') risk('host_pid');
        if (value.ipc === 'host') risk('host_ipc');
        if (Array.isArray(value.cap_add) && value.cap_add.length) risk('additional_capabilities');
        if (Array.isArray(value.devices) && value.devices.length) risk('devices');
        if (value.restart !== 'always' && value.restart !== 'unless-stopped') risk('missing_reboot_restart_policy');
        const ports: NativeComposeRuntimeReview['services'][number]['ports'][number][] = [];
        if (value.ports != null && !Array.isArray(value.ports)) unknown();
        for (const port of Array.isArray(value.ports) ? value.ports : []) {
            if (!record(port)) { unknown(); continue; }
            // Classify the actual address before masking structural secret values.
            if (typeof port.host_ip !== 'string' || !isLiteralLoopbackHostname(port.host_ip)) risk('non_loopback_publish');
            ports.push({ target: scalar(port.target), published: scalar(port.published), bindAddress: text(port.host_ip), protocol: text(port.protocol) });
        }
        const mounts: NativeComposeRuntimeReview['services'][number]['mounts'][number][] = [];
        if (value.volumes != null && !Array.isArray(value.volumes)) unknown();
        for (const mount of Array.isArray(value.volumes) ? value.volumes : []) {
            if (!record(mount)) { unknown(); continue; }
            if (mount.type === 'bind' && typeof mount.source === 'string') {
                risk('host_bind');
                const child = relative(releaseRoot, mount.source);
                if (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`) && mount.read_only !== true) risk('in_release_bind');
                if (mount.source.replaceAll('\\', '/').endsWith('/docker.sock')) risk('docker_socket');
            }
            if (mount.type === 'npipe') risk('docker_socket');
            mounts.push({ type: text(mount.type), source: text(mount.source), target: text(mount.target), readOnly: mount.read_only === true });
        }
        const deploy = record(value.deploy) ? value.deploy : undefined;
        const resources = deploy && record(deploy.resources) ? deploy.resources : undefined;
        const limits = resources && record(resources.limits) ? resources.limits : undefined;
        services.push({ name: service, replicas: scalar(value.scale ?? deploy?.replicas),
            resources: { cpus: scalar(value.cpus ?? limits?.cpus), memory: scalar(value.mem_limit ?? limits?.memory) },
            restartPolicy: text(value.restart), healthcheck: record(value.healthcheck) && value.healthcheck.disable !== true ? 'configured' : 'absent',
            ports, mounts });
    }
    if (!record(model.services) || !services.length) inspection = 'unknown';
    return { inspection, services, risks };
}
