import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentSecretBindingSourceV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentEnvironmentContentPatchV1Schema } from '@happier-dev/protocol/deployments/deploymentEnvironmentContentPatchV1';
import type { DeploymentEnvironmentUpdateInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { isMap, isSeq, parseDocument } from 'yaml';
import { storedComposeDocumentText } from './storedComposeDocumentText';

export type DatabaseMoveCutoverSelection = Readonly<{
    sourceService: string; destinationEnvironmentId: string; exportKey: string;
    username: string; database: string; password: DeploymentSecretBindingSourceV1;
}>;
type Unavailable = Readonly<{ kind: 'unavailable';
    reason: 'repository_definition' | 'non_machine_rewritable_dsn' | 'no_connected_services'; variable?: string }>;
type EnvironmentPatch = NonNullable<DeploymentEnvironmentUpdateInputV1['patch']>;
type CutoverBindings = NonNullable<EnvironmentPatch['bindings']>;
type CutoverPatch = Readonly<{ definition: NonNullable<EnvironmentPatch['definition']>;
    bindings: Omit<CutoverBindings, 'set'> & {
        set: Array<Extract<NonNullable<CutoverBindings['set']>[number], { purpose: 'variable' }>>;
    } }>;
export type DatabaseMoveCutoverPreparation = Unavailable | Readonly<{ kind: 'ready'; patch: CutoverPatch }>;

/** Authors the reviewed Connect patch; the Workflow gates its application on verified restore and health. */
export function authorDatabaseMoveCutoverPatch(content: DeploymentEnvironmentContentV1,
    selection: DatabaseMoveCutoverSelection): DatabaseMoveCutoverPreparation {
    const definition = content.definition;
    if (definition.kind !== 'stored') return { kind: 'unavailable', reason: 'repository_definition' } satisfies Unavailable;
    const unavailable = (variable: string): Unavailable => ({ kind: 'unavailable', reason: 'non_machine_rewritable_dsn', variable });
    const document = parseDocument(definition.document, { merge: true });
    const services = document.get('services', true);
    if (document.errors.length || !isMap(services) || !services.has(selection.sourceService)) return unavailable('DATABASE_URL');
    const variableNames = ['DB_MOVE_HOST', 'DB_MOVE_PORT', 'DB_MOVE_PASSWORD'] as const;
    const occupied = content.bindings.find(binding => binding.purpose === 'variable' && binding.phase === 'runtime'
        && variableNames.some(name => binding.name === name));
    if (occupied?.purpose === 'variable') return unavailable(occupied.name);
    let rewritten = 0;
    let refusal: Unavailable | undefined;
    const rewrite = (name: string, value: unknown): unknown => {
        let parsed: URL | undefined;
        if (typeof value === 'string') {
            try { parsed = new URL(value); } catch { /* An opaque connection variable needs a person to edit it. */ }
        }
        const local = parsed?.hostname === selection.sourceService;
        const postgres = parsed && ['postgres:', 'postgresql:'].includes(parsed.protocol);
        if (parsed && !local && !(postgres && parsed.hostname.includes('$'))) return value;
        const hostVariable = name === 'PGHOST' || name === 'HOST' || /_HOST(?:NAME)?$/u.test(name);
        const unresolvedLocalDsn = typeof value === 'string'
            && (value.includes(`@${selection.sourceService}:`) || value.includes(`@${selection.sourceService}/`));
        if (hostVariable && value === selection.sourceService || !parsed && unresolvedLocalDsn) {
            refusal = unavailable(name);
            return value;
        }
        if (!local && name !== 'DATABASE_URL' && name !== 'DIRECT_URL') return value;
        if (!local || !parsed || !postgres) {
            refusal = unavailable(name);
            return value;
        }
        rewritten++;
        return `${parsed.protocol}//${encodeURIComponent(selection.username)}:\${DB_MOVE_PASSWORD}@\${DB_MOVE_HOST}:\${DB_MOVE_PORT}/${encodeURIComponent(selection.database)}${parsed.search}${parsed.hash}`;
    };
    for (const item of services.items) {
        if (String(item.key) === selection.sourceService || !isMap(item.value)) continue;
        const service = item.value;
        const environment = service.get('environment', true);
        if (isMap(environment)) {
            for (const variable of environment.items) {
                const name = String(variable.key);
                const value = environment.get(name);
                const next = rewrite(name, value);
                if (next !== value) environment.set(name, next);
            }
        } else if (isSeq(environment)) {
            for (let index = 0; index < environment.items.length; index++) {
                const entry = environment.get(index);
                if (typeof entry !== 'string') continue;
                const separator = entry.indexOf('=');
                const name = separator < 0 ? entry : entry.slice(0, separator);
                const value = separator < 0 ? undefined : entry.slice(separator + 1);
                const next = rewrite(name, value);
                if (next !== value) environment.set(index, `${name}=${String(next)}`);
            }
        }
        const dependencies = service.get('depends_on', true);
        if (isMap(dependencies)) {
            dependencies.delete(selection.sourceService);
            if (!dependencies.items.length) service.delete('depends_on');
        } else if (isSeq(dependencies)) {
            for (let index = dependencies.items.length - 1; index >= 0; index--)
                if (dependencies.get(index) === selection.sourceService) dependencies.delete(index);
            if (!dependencies.items.length) service.delete('depends_on');
        }
    }
    if (refusal) return refusal;
    if (!rewritten) return { kind: 'unavailable', reason: 'no_connected_services' };
    services.delete(selection.sourceService);
    const reference = { kind: 'reference' as const, environmentId: selection.destinationEnvironmentId,
        export: selection.exportKey, via: 'auto' as const };
    const patch = {
        definition: { from: 'compose' as const, document: storedComposeDocumentText(document), profiles: definition.profiles,
            services: definition.services.filter(service => service !== selection.sourceService),
            ...(definition.primaryService && definition.primaryService !== selection.sourceService ? { primaryService: definition.primaryService } : {}),
            ...(definition.publicFiles ? { publicFiles: definition.publicFiles } : {}) },
        bindings: { set: [
            { purpose: 'variable' as const, phase: 'runtime' as const, name: variableNames[0], source: { ...reference, component: 'host' as const } },
            { purpose: 'variable' as const, phase: 'runtime' as const, name: variableNames[1], source: { ...reference, component: 'port' as const } },
            { purpose: 'variable' as const, phase: 'runtime' as const, name: variableNames[2], source: selection.password },
        ], remove: [] },
    };
    DeploymentEnvironmentContentPatchV1Schema.parse(patch);
    return { kind: 'ready' as const, patch };
}
