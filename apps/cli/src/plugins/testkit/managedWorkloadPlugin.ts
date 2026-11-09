import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import type { ManagedServices } from '@happier-dev/plugin-sdk/managed-services';

/** Public author fixture: the host supplies admission, not an authority operand. */
export async function exerciseManagedWorkload(managedServices: ManagedServices, serviceId: string) {
    const result = await managedServices.observeWorkload({ serviceId });
    if (result.kind !== 'ready') return { kind: result.kind, reason: result.reason };
    const workload = result.workload;
    const observation = workload.observe(() => {});
    try {
        const current = workload.snapshot();
        const control = await workload.control('restart');
        const logs = await workload.readLogs();
        return { kind: 'observed', generation: current.generation, control: control.kind, logs: logs.kind };
    } finally {
        observation.dispose();
        await workload.dispose();
    }
}

const plugin = definePlugin({
    id: 'examples.managed-workload', version: '1.0.0', displayName: 'Managed workload author fixture',
    runtime: { apiVersion: 1 }, entrypoints: { daemon: './index.js' },
    actions: {
        inspect: {
            title: 'Observe admitted workload', surfaces: ['plugin'], execution: { target: 'daemon' },
            inputSchema: defineProtocolObject({ serviceId: defineProtocolString() }, { policy: 'closed' }),
            run: async (input, context) => exerciseManagedWorkload(context.services.managedServices, input.serviceId),
        },
    },
});

export const { manifest, activate } = plugin;
