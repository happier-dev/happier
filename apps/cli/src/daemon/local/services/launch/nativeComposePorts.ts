import { projectNativeComposeReview, type NativeComposeRuntimeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { isNativeDefinitionRecord as record } from '@/workspaces/projectSetup/nativePackageScripts';

/** Warm and cold captures project Docker's effective bindings, including
 * ephemeral published ports, through the same masked structural review. */
export function readNativeComposePublishedPorts(bindingsByContainer: readonly unknown[], redact: (value: string) => string):
    NativeComposeRuntimeReview['services'][number]['ports'] | null {
    const ports: { target: number; published: string; host_ip: string; protocol: string }[] = [];
    for (const published of bindingsByContainer) {
        if (published === null) continue;
        if (!record(published)) return null;
        for (const [key, bindings] of Object.entries(published)) {
            // Docker includes exposed but unpublished ports with null bindings.
            if (bindings === null) continue;
            const port = /^([0-9]+)\/([^/]+)$/u.exec(key);
            if (!port || !Array.isArray(bindings)) return null;
            for (const binding of bindings) {
                if (!record(binding) || typeof binding.HostIp !== 'string' || typeof binding.HostPort !== 'string') return null;
                ports.push({ target: Number(port[1]), published: binding.HostPort, host_ip: binding.HostIp, protocol: port[2]! });
            }
        }
    }
    return projectNativeComposeReview({ services: { service: { ports } } }, '', redact).services[0]!.ports;
}
