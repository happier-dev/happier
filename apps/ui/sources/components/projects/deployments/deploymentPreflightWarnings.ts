import { environmentSecretBindingIdentityV1, type EnvironmentSecretBindingV1 } from '@happier-dev/deployment-protocol';
import { parseDeploymentComposeSourceV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { LocalServiceEndpointV1Schema } from '@happier-dev/protocol/local/services/inventory/v1';
import { projectDeploymentConfigurePreflightV1, type DeploymentConfigureDraftV1 } from '@happier-dev/protocol/deployments/deploymentPublishPreparationV1';
import { ProjectDefinitionInspectOutputSchema, type ProjectDefinitionWorkspace } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export { projectDeploymentConfigurePreflightV1 } from '@happier-dev/protocol/deployments/deploymentPublishPreparationV1';

/** One finite Configure/recognized-repository read. Inspection stays with projects.inspect;
 * invalid authoring text never requests native work or masquerades as availability. */
export async function readDeploymentPreparationFacts(lifetime: ServerAccountScopeLifetime,
    input: Readonly<{ configure: DeploymentConfigureDraftV1; workspace?: ProjectDefinitionWorkspace }>,
    options: Readonly<{ signal: AbortSignal }>) {
    const configurePreflight = projectDeploymentConfigurePreflightV1(input.configure);
    const stale = () => ({ ok: false as const, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' });
    options.signal.throwIfAborted();
    if (!lifetime.isCurrent()) return stale();
    if (!input.workspace) return { ok: true as const, configurePreflight, repository: { status: 'notInspected' as const } };
    const result = await createFrontDoorActionExecute()('projects.inspect', { workspace: input.workspace, read: { kind: 'applications' } },
        { surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId, signal: options.signal });
    options.signal.throwIfAborted();
    if (!lifetime.isCurrent()) return stale();
    if (!result.ok) return result;
    const parsed = ProjectDefinitionInspectOutputSchema.safeParse(result.result);
    if (!parsed.success) return { ok: false as const, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    const detection = parsed.data.detection;
    return { ok: true as const, configurePreflight, repository: {
        status: detection.applications === undefined ? 'notReported' as const : 'observed' as const,
        applications: detection.applications ?? [], coverage: detection.coverage, diagnostics: detection.diagnostics,
    } };
}

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

/**
 * The services a Compose document declares, and the container ports each one declares: its `expose` entries and the
 * container side of its `ports`. Literal numbers only; an interpolated, ranged or unreadable entry declares nothing.
 */
export async function readDeploymentComposeServiceFacts(document: string): Promise<Readonly<{
    services: readonly string[];
    containerPorts: ReadonlyArray<Readonly<{ service: string; containerPort: number }>>;
}>> {
    const source = await parseDeploymentComposeSourceV1(document);
    const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const literal = (value: unknown): number | null => {
        const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.split('/')[0]!.split(':').at(-1)! : '';
        const port = LocalServiceEndpointV1Schema.shape.port.safeParse(/^\d+$/u.test(text) ? Number(text) : Number.NaN);
        return port.success ? port.data : null;
    };
    const declarations = record(source.services) ? source.services : {};
    const containerPorts = Object.entries(declarations).flatMap(([service, declaration]) => {
        if (!record(declaration)) return [];
        const entries = [...(Array.isArray(declaration.expose) ? declaration.expose : []),
            ...(Array.isArray(declaration.ports) ? declaration.ports.map(port => record(port) ? port.target : port) : [])];
        const ports = new Set(entries.map(literal).filter((port): port is number => port !== null));
        return [...ports].map(containerPort => ({ service, containerPort }));
    });
    return { services: Object.keys(declarations), containerPorts };
}
