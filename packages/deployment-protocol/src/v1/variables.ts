import type { DeploymentTargetOwnedVariableV1, DeploymentTargetVariablesSyncInputV1, DeploymentTargetVariablesSyncResultV1,
    DeploymentTargetVariableMetadataV1 } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { encodeTelemetryAuthorizationHeaderV1 } from './telemetry.js';

type SyncInput = Pick<DeploymentTargetVariablesSyncInputV1, 'owned' | 'desiredRevision' | 'set' | 'remove' | 'keepTheirs' | 'useOurs'>;
type SyncResult = DeploymentTargetVariablesSyncResultV1;
type FailureCode = SyncResult['failures'][number]['code'];
type Binding = SyncInput['set'][number];
type SupportedSource = Extract<Binding['source'], { kind: 'secret' | 'value' }>;
type WritableBinding = Binding & { source: SupportedSource };

export type DeploymentTargetObservedVariableV1 = Readonly<Pick<DeploymentTargetVariableMetadataV1,
    'key' | 'providerId' | 'providerRevision' | 'secret'>>;

type ProviderLimits = Readonly<{
    opaqueKeys?: ReadonlySet<string>;
    unsupportedSetKeys?: ReadonlySet<string>;
    unavailableSecretServiceCode?: 'secret_use_client_required' | 'outcome_unknown';
}>;

function groupObservations(observed: readonly DeploymentTargetObservedVariableV1[]) {
    const byKey = new Map<string, DeploymentTargetObservedVariableV1[]>();
    for (const row of observed) {
        const matches = byKey.get(row.key);
        if (matches) matches.push(row);
        else byKey.set(row.key, [row]);
    }
    return byKey;
}

function variableDrift(row: DeploymentTargetObservedVariableV1, retained: DeploymentTargetOwnedVariableV1 | undefined) {
    if (retained?.providerId !== row.providerId || retained.providerRevision === undefined || row.providerRevision === undefined) return 'unknown';
    return row.providerRevision === retained.providerRevision ? 'current' : 'changed';
}

function presentVariable(row: DeploymentTargetObservedVariableV1, retained: DeploymentTargetOwnedVariableV1 | undefined):
    DeploymentTargetVariableMetadataV1 {
    const { key, providerId, providerRevision, secret } = row;
    return { key, providerId, secret, ...(providerRevision === undefined ? {} : { providerRevision }),
        present: true, owned: retained?.providerId === providerId, drift: variableDrift(row, retained) };
}

function missingVariable({ key, providerId }: DeploymentTargetOwnedVariableV1): DeploymentTargetVariableMetadataV1 {
    return { key, providerId, present: false, secret: true, owned: true, drift: 'changed' };
}

function projectVariables(observed: ReadonlyMap<string, readonly DeploymentTargetObservedVariableV1[]>,
    owned: ReadonlyMap<string, DeploymentTargetOwnedVariableV1>): DeploymentTargetVariableMetadataV1[] {
    const variables: DeploymentTargetVariableMetadataV1[] = [];
    for (const [key, [row]] of observed) {
        if (!row) continue;
        variables.push(presentVariable(row, owned.get(key)));
    }
    for (const [key, retained] of owned) {
        if (observed.has(key)) continue;
        variables.push(missingVariable(retained));
    }
    return variables;
}

export function projectDeploymentTargetVariablesV1(observed: readonly DeploymentTargetObservedVariableV1[],
    retained: readonly DeploymentTargetOwnedVariableV1[], { distinctRows = false } = {}): DeploymentTargetVariableMetadataV1[] {
    const rows = groupObservations(observed);
    const owned = new Map(retained.map(value => [value.key, value]));
    if (!distinctRows) return projectVariables(rows, owned);
    // Vercel can list several independently scoped native rows with the same name.
    return [...observed.map(row => presentVariable(row, owned.get(row.key))),
        ...retained.filter(row => !rows.get(row.key)?.some(observed => observed.providerId === row.providerId)).map(missingVariable)];
}

function hasWritableSource(binding: Binding): binding is WritableBinding {
    return binding.source.kind === 'value' || binding.source.kind === 'secret';
}

function sameDelivery(left: Binding, right: Binding) {
    if (left.valueFormat !== right.valueFormat) return false;
    const a = left.source;
    const b = right.source;
    if (a.kind === 'value' && b.kind === 'value') return a.value === b.value;
    if (a.kind === 'secret' && b.kind === 'secret') return a.ref === b.ref && a.resourceRevision === b.resourceRevision;
    return JSON.stringify(a) === JSON.stringify(b);
}

/** Plan from the provider's scoped metadata. Only acknowledged effects update retained ownership. */
export function createDeploymentTargetVariableSyncV1(input: SyncInput, observed: readonly DeploymentTargetObservedVariableV1[],
    limits: ProviderLimits = {}) {
    const rows = groupObservations(observed);
    const owned = new Map(input.owned.map(row => [row.key, row]));
    const failures: SyncResult['failures'] = [];
    function fail(key: string, code: FailureCode) { failures.push({ key, code }); }
    const keep = new Set(input.keepTheirs);
    const overwrite = new Set(input.useOurs);
    for (const key of keep) owned.delete(key);

    const desired = new Map<string, Binding>();
    const conflicts = new Set<string>();
    for (const binding of input.set) {
        const previous = desired.get(binding.name);
        if (previous && !sameDelivery(previous, binding)) conflicts.add(binding.name);
        desired.set(binding.name, binding);
    }

    const set: WritableBinding[] = [];
    for (const [key, binding] of desired) {
        if (keep.has(key)) continue;
        const current = rows.get(key)?.[0];
        const retained = owned.get(key);
        if (conflicts.has(key)) fail(key, 'deployment_conflict');
        else if (limits.unsupportedSetKeys?.has(key)) fail(key, 'deployment_content_unavailable');
        else if ((!current && limits.opaqueKeys?.has(key)) || (current && !overwrite.has(key)
            && (current.providerId !== retained?.providerId || variableDrift(current, retained) === 'changed'))) {
            fail(key, 'deployment_conflict');
        } else if (hasWritableSource(binding)) set.push(binding);
        else fail(key, 'deployment_content_unavailable');
    }

    const remove: DeploymentTargetObservedVariableV1[] = [];
    for (const key of new Set(input.remove)) {
        const retained = owned.get(key);
        if (!retained || desired.has(key)) continue;
        const current = rows.get(key)?.find(row => row.providerId === retained.providerId);
        if (!current) owned.delete(key);
        else if (variableDrift(current, retained) === 'changed' && !overwrite.has(key)) fail(key, 'deployment_conflict');
        else remove.push(current);
    }

    async function materialize(binding: WritableBinding, context: Pick<PluginAccountActionContext, 'services' | 'signal'>):
        Promise<{ value: string; secret: boolean } | null> {
        const source = binding.source;
        let value: string;
        if (source.kind === 'value') value = source.value;
        else {
            if (!context.services.secrets) {
                fail(binding.name, limits.unavailableSecretServiceCode ?? 'secret_use_client_required');
                return null;
            }
            try {
                // The invocation service records redaction before supplying the exact Saved Secret revision.
                value = await context.services.secrets.readSavedSecret(source.ref,
                    { resourceRevision: source.resourceRevision, signal: context.signal });
            } catch (error) {
                const code = isPluginError(error) && (error.code === 'secret_use_client_required' || error.code === 'secret_missing'
                    || error.code === 'plugin_secret_custody_unavailable') ? error.code : 'outcome_unknown';
                fail(binding.name, code);
                return null;
            }
        }
        return { value: binding.valueFormat === 'otelAuthorizationHeader' ? encodeTelemetryAuthorizationHeaderV1(value) : value,
            secret: source.kind === 'secret' };
    }

    function acknowledgeSet(row: DeploymentTargetObservedVariableV1) {
        const { key, providerId, providerRevision } = row;
        owned.set(key, { key, providerId, desiredRevision: input.desiredRevision,
            ...(providerRevision === undefined ? {} : { providerRevision }) });
        rows.set(key, [row, ...(rows.get(key) ?? []).filter(other => other.providerId !== providerId)]);
    }

    function acknowledgeRemove(key: string) {
        const retained = owned.get(key);
        if (!retained) return;
        owned.delete(key);
        const remaining = rows.get(key)?.filter(row => row.providerId !== retained.providerId);
        if (remaining?.length) rows.set(key, remaining);
        else rows.delete(key);
    }

    function result(latest?: readonly DeploymentTargetObservedVariableV1[]): SyncResult {
        return { v: 1, variables: projectVariables(latest ? groupObservations(latest) : rows, owned),
            owned: [...owned.values()], failures };
    }
    return { set, remove, materialize, acknowledgeSet, acknowledgeRemove, fail, result };
}
