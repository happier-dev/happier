import { environmentSecretBindingIdentityV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { parseDeploymentComposeSourceV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { LocalServiceEndpointV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';

export type DeploymentPromotionBindingGap = Readonly<{ name: string; phase: 'build' | 'runtime'; secret: boolean }>;

/** Advisory P42 variable identities only; values and secret references never leave this projection. */
export function projectDeploymentPromotionBindingGaps(
    source: readonly EnvironmentSecretBindingV1[], destination: readonly EnvironmentSecretBindingV1[],
): readonly DeploymentPromotionBindingGap[] {
    const present = new Set(destination.map(environmentSecretBindingIdentityV1));
    return source.flatMap(binding => binding.purpose === 'variable' && !present.has(environmentSecretBindingIdentityV1(binding))
        ? [{ name: binding.name, phase: binding.phase, secret: binding.source.kind === 'secret' }] : []);
}

export type DeploymentDeclaredAddInputs = Readonly<{
    services: ReadonlyArray<Readonly<{ service: string; name: string | null; ports: ReadonlyArray<string | number | Readonly<{
        target: string | number | null; published: string | number | null; bindAddress: string | null; protocol: string | null;
    }>> }>>;
    /** Literal numeric long-form publications only. No interpolation or short-form evaluation. */
    query: { ports: number[]; nativeNames: [] };
    /** Native effective ports and runtime names settle only after first start. */
    unresolved: true;
}>;

export async function readDeploymentAddDeclaredInputs(document: string, services: readonly string[]): Promise<DeploymentDeclaredAddInputs> {
    const source = await parseDeploymentComposeSourceV1(document);
    const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const scalar = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? value : null;
    const text = (value: unknown) => typeof value === 'string' ? value : null;
    const declarations = record(source.services) ? source.services : {};
    const published = new Set<number>();
    const selected = services.map(service => {
        const declaration = declarations[service];
        const value = record(declaration) ? declaration : {};
        const ports: DeploymentDeclaredAddInputs['services'][number]['ports'][number][] = [];
        for (const port of Array.isArray(value.ports) ? value.ports : []) {
            if (typeof port === 'string' || typeof port === 'number') { ports.push(port); continue; }
            if (!record(port)) continue;
            const literal = LocalServiceEndpointV1Schema.shape.port.safeParse(port.published);
            if (literal.success) published.add(literal.data);
            ports.push({ target: scalar(port.target), published: scalar(port.published),
                bindAddress: text(port.host_ip), protocol: text(port.protocol) });
        }
        return { service, name: text(value.container_name), ports };
    });
    return { services: selected, query: { ports: [...published], nativeNames: [] }, unresolved: true };
}
