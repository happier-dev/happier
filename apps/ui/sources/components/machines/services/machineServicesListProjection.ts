import { MachineServicesListResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

type ListResult = ReturnType<typeof MachineServicesListResultV1Schema.parse>;

/** The Machine page and Environment controller consume the same admitted row identities. */
export const machineServicesListProjection = Object.freeze({
    decode(content: Readonly<{ bytes: Uint8Array }>, previous: ListResult | undefined): ListResult {
        const next = MachineServicesListResultV1Schema.parse(JSON.parse(new TextDecoder().decode(content.bytes)));
        if (next.kind !== 'snapshot' || previous?.kind !== 'snapshot') return next;
        const byId = new Map(previous.services.map(row => [row.serviceId, row]));
        const services = next.services.map(row => {
            const retained = byId.get(row.serviceId);
            return retained && sameStrictJsonValue(retained, row) ? retained : row;
        });
        return services.length === previous.services.length && services.every((row, index) => row === previous.services[index])
            ? previous : { ...next, services };
    },
});
