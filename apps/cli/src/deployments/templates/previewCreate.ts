import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorContext, ActionExecutorDeps, DeploymentEnvironmentCreateInputV1, EnvironmentSecretBindingInputV1,
    EnvironmentSecretBindingV1, EnvironmentVariableBindingInputV1, EnvironmentVariableBindingV1, StoredAppPresetInputV1 } from '@happier-dev/protocol';
import { applyEnvironmentSecretBindingsPatchV1 } from '@happier-dev/protocol/deployments/deploymentBindingPatchV1';
import { DeploymentEnvironmentCreateResultV1Schema, DeploymentBindingsSetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentBackupConfigureResultV1Schema } from '@happier-dev/protocol/deployments/deploymentBackupConfigureV1';
import { DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DeploymentPreviewDataSelectionV1 } from '@happier-dev/protocol/deployments/deploymentPreviewTemplateV1';
import { buildCatalogAppTemplateBindings } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { createDeploymentDumpBackupSourceIdV1, createDeploymentVolumeBackupSourceIdV1,
    prepareDeploymentTemplateInstantiationV1, type DeploymentTemplateInstantiationPreparationInputV1 } from '@happier-dev/deployments';
import type { DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import { createOwnServerEnvironmentConfigurationV1 } from '@happier-dev/deployment-protocol';
import type { StoredCredentials } from '@/persistence';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { normalizeStoredComposeDefinitionInput, parseNativeComposeSource } from '@/workspaces/projectSetup/nativeComposeSource';
import { withDeploymentTemplateGeneratedSecretsForHost, validateDeploymentTemplateGeneratedSecretProfileForHost } from './generatedSecretForHost';
import { readPinnedDeploymentTemplateForHost } from './readPinnedTemplateForHost';
import { projectDeploymentException } from '../deploymentFailure';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';

type Selection = Extract<DeploymentPreviewDataSelectionV1, { kind: 'template' }>;
type Host = Readonly<{ credentials: StoredCredentials; serverHttpBaseUrl: string;
    savedSecretOperationContext?: SavedSecretOperationContextV1 }>;
type Preparation = ReturnType<typeof prepareDeploymentTemplateInstantiationV1>;
export type PreviewTemplateCreationPlanForHost = Readonly<{
    name: string; definition: DeploymentEnvironmentContentV1['definition'];
    template?: NonNullable<DeploymentEnvironmentContentV1['template']>;
    companionRequired?: true;
    data: readonly Readonly<{ service: string; database: string }>[];
    preparations: readonly Readonly<{ input: DeploymentTemplateInstantiationPreparationInputV1; prepared: Preparation }>[];
    selections: readonly Selection[];
    explicitBindings?: readonly EnvironmentVariableBindingInputV1[];
    serviceExports?: NonNullable<DeploymentEnvironmentContentV1['ownServer']>['serviceExports'];
    backup?: Selection['destinationBackup'];
}>;
const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
function templateCustody(context: ActionExecutorContext, host: Host) {
    return resolveRequesterSavedSecretActionCustody({ authorization: context.externalActionExecutionAuthorization,
        credentials: host.credentials, operationContext: host.savedSecretOperationContext });
}

/** Add owns aliases; backup configuration follows its actual prepared resource metadata. */
function prepareSelectionBackup(selection: Selection, input: DeploymentTemplateInstantiationPreparationInputV1,
    prepared: Preparation): Selection['destinationBackup'] {
    const backup = selection.destinationBackup;
    if (!backup) return undefined;
    const data = prepared.template.data?.at(-1);
    const volumes = prepared.template.volumes?.slice(-input.template.volumes.length) ?? [];
    const sources = backup.configuration.sources.map(source => {
        const service = source.service === input.template.data?.service ? data!.service : source.service;
        if (source.kind === 'dump') return { ...source, service,
            sourceId: service === source.service ? source.sourceId : createDeploymentDumpBackupSourceIdV1(service) };
        const originalIndex = input.template.volumes.findIndex(volume => volume.id === source.volume && volume.service === source.service);
        const selectedVolume = originalIndex < 0 ? undefined : volumes[originalIndex];
        const volume = selectedVolume?.id ?? source.volume;
        const volumeService = selectedVolume?.service ?? service;
        return { ...source, service: volumeService, volume, sourceId: volumeService === source.service && volume === source.volume
            ? source.sourceId : createDeploymentVolumeBackupSourceIdV1(volumeService, volume) };
    });
    return { ...backup, configuration: { ...backup.configuration, sources } };
}

function combineSelectionBackups(backups: readonly NonNullable<Selection['destinationBackup']>[]): Selection['destinationBackup'] {
    const first = backups[0];
    if (!first) return undefined;
    const destination = (backup: NonNullable<Selection['destinationBackup']>) => {
        const { sources: _sources, ...configuration } = backup.configuration;
        return { ...backup, configuration };
    };
    const selectedDestination = destination(first);
    if (backups.some(backup => !isDeepStrictEqual(destination(backup), selectedDestination)))
        return refuse('invalid_backup_configuration');
    const sources = backups.flatMap(backup => backup.configuration.sources);
    return { ...first, configuration: { ...first.configuration,
        sources: [...new Map(sources.map(source => [JSON.stringify(source), source])).values()] } };
}

/** Creation and retained readiness consume the same template-owned database declaration. */
export function readPreviewTemplateNativeDataForHost(content: Readonly<{
    template?: Pick<NonNullable<DeploymentEnvironmentContentV1['template']>, 'data'>;
    bindings: DeploymentEnvironmentContentV1['bindings'];
}>):
    readonly Readonly<{ service: string; database: string }>[] {
    return (content.template?.data ?? []).map(declaration => {
        if (declaration.logicalBackup?.adapter !== 'postgres-v1') return refuse('unsupported_action');
        const database = content.bindings.find(binding => binding.purpose === 'variable'
            && binding.name === declaration.variables?.database)?.source;
        if (database?.kind !== 'value') return refuse('unsupported_action');
        return { service: declaration.service, database: database.value };
    });
}

export type PreviewNativeDataPlacementForHost = Readonly<{
    selectionIndex: number; placement: 'repository' | 'companion'; service: string; database: string;
}>;

async function prepareNativeSelections(input: Readonly<{
    selections: readonly DeploymentPreviewDataSelectionV1[];
    existingTemplate: DeploymentEnvironmentContentV1['template']; context: ActionExecutorContext;
}>, host: Host) {
    const custody = templateCustody(input.context, host);
    const rows = [];
    const repositoryServices = new Set<string>();
    for (const [selectionIndex, selection] of input.selections.entries()) {
        if (selection.kind !== 'template') continue;
        input.context.signal?.throwIfAborted();
        if (selection.copyFrom && !selection.destinationBackup) return refuse('backup_required');
        const template = await readPinnedDeploymentTemplateForHost(selection.templateRef, { credentials: custody.credentials,
            signal: input.context.signal, operationContext: custody.operation });
        const data = template.data;
        if (data?.logicalBackup?.adapter !== 'postgres-v1'
            || !template.volumes.some(volume => volume.persistent && volume.service === data.service)) return refuse('unsupported_action');
        if (selection.dataExportNames.some(name => !template.exports?.[name])) return refuse('template_needs_review');
        const defaults = buildCatalogAppTemplateBindings(template);
        const selectedTemplate = { ...template, exports: Object.fromEntries(selection.dataExportNames.map(name => [name, template.exports![name]!])) };
        const preparation: DeploymentTemplateInstantiationPreparationInputV1 = { template: selectedTemplate, templateRef: selection.templateRef,
            source: await parseNativeComposeSource(template.compose.document), bindings: defaults.bindings };
        const prepared = prepareDeploymentTemplateInstantiationV1(preparation);
        // Endpoint variables describe consumption, not the existing database or its storage.
        const identity = (entry: NonNullable<typeof template.data>) => {
            const { host: _host, port: _port, ...variables } = entry.variables ?? {};
            return { ...entry, variables };
        };
        const declared = input.existingTemplate?.data?.find(entry => isDeepStrictEqual(identity(entry), identity(data)));
        const repository = declared && !repositoryServices.has(data.service)
            && input.existingTemplate?.volumes?.some(volume => volume.persistent && volume.service === data.service);
        if (repository) repositoryServices.add(data.service);
        const native = readPreviewTemplateNativeDataForHost({ template: prepared.template, bindings: prepared.bindings })[0]!;
        rows.push({ placement: { selectionIndex, placement: repository ? 'repository' as const : 'companion' as const, ...native },
            input: preparation, prepared });
    }
    return rows;
}

/** A companion is ordinary catalog Compose, composed by the existing Add namespace owner. */
export async function preparePreviewCompanionTemplateCreationForHost(input: Readonly<{
    name: string; existingTemplate: DeploymentEnvironmentContentV1['template'];
    selections: readonly Selection[]; context: ActionExecutorContext;
    reservedVariableNames?: readonly string[];
}>, host: Host): Promise<PreviewTemplateCreationPlanForHost> {
    const rows = (await prepareNativeSelections(input, host)).filter(row => row.placement.placement === 'companion');
    if (!rows.length) return refuse('template_needs_review');
    const preparations: PreviewTemplateCreationPlanForHost['preparations'][number][] = [];
    const backups: NonNullable<Selection['destinationBackup']>[] = [];
    const serviceExports: NonNullable<PreviewTemplateCreationPlanForHost['serviceExports']> = [];
    let content: DeploymentEnvironmentContentV1 | undefined;
    for (const row of rows) {
        const preparation: DeploymentTemplateInstantiationPreparationInputV1 = { ...row.input,
            ...(input.reservedVariableNames?.length ? { reservedVariableNames: input.reservedVariableNames } : {}),
            ...(content ? { intent: 'add', current: { content,
                source: await parseNativeComposeSource(content.definition.kind === 'stored'
                    ? content.definition.document : refuse('template_needs_review')) } } : {}) };
        const prepared = prepareDeploymentTemplateInstantiationV1(preparation);
        const backup = prepareSelectionBackup(input.selections[row.placement.selectionIndex]!, preparation, prepared);
        if (backup) backups.push(backup);
        for (const secret of prepared.generatedSecrets)
            validateDeploymentTemplateGeneratedSecretProfileForHost({ name: `${input.name} · ${secret.name}`, profile: secret.profile });
        const definition = await normalizeStoredComposeDefinitionInput({ from: 'compose', document: prepared.document,
            profiles: prepared.profiles, services: prepared.services, primaryService: prepared.primaryService,
            ...(prepared.publicFiles ? { publicFiles: prepared.publicFiles } : {}) });
        const data = prepared.template.data?.at(-1) ?? refuse('template_needs_review');
        if (!data.variables?.host || !data.variables.port) return refuse('template_needs_review');
        const output = Object.values(prepared.template.exports ?? {}).find(output => output.service === data.service);
        if (!output) return refuse('template_needs_review');
        serviceExports.push({ key: data.service, service: data.service, containerPort: output.port,
            scheme: output.scheme ?? refuse('template_needs_review'), exposure: 'loopback', transport: { kind: 'iroh' } });
        content = { name: input.name, retainPreviousDeployments: 1, definition,
            bindings: applyEnvironmentSecretBindingsPatchV1(content?.bindings ?? [], { set: prepared.bindings, remove: [] }, randomUUID),
            ownServer: createOwnServerEnvironmentConfigurationV1(), template: { ...prepared.template,
                definition: { kind: 'stored', contentRevision: definition.contentRevision, composeDigest: definition.composeDigest } } };
        preparations.push({ input: preparation, prepared });
    }
    return { name: input.name, definition: content!.definition, template: content!.template, serviceExports,
        backup: combineSelectionBackups(backups),
        data: readPreviewTemplateNativeDataForHost(content!), preparations,
        selections: rows.map(row => input.selections[row.placement.selectionIndex]!) };
}

/** Workflow compilation and creation consume the same pinned native data placement. */
export async function preparePreviewNativeDataPlacementsForHost(input: Readonly<{
    selections: readonly DeploymentPreviewDataSelectionV1[];
    existingTemplate: DeploymentEnvironmentContentV1['template']; context: ActionExecutorContext;
}>, host: Host): Promise<readonly PreviewNativeDataPlacementForHost[]> {
    return (await prepareNativeSelections(input, host)).map(row => row.placement);
}

/** Repository Compose remains authoritative; only fresh bindings and declared data metadata are prepared. */
export async function preparePreviewTemplateCreationForHost(input: Readonly<{
    name: string; definition: Extract<DeploymentEnvironmentContentV1['definition'], { kind: 'repository' }>;
    existingTemplate: DeploymentEnvironmentContentV1['template']; selections: readonly Selection[]; context: ActionExecutorContext;
    explicitBindings?: readonly EnvironmentVariableBindingInputV1[];
}>, host: Host): Promise<PreviewTemplateCreationPlanForHost> {
    if (!input.definition.compose) return refuse('deployment_source_unavailable');
    const rows = await prepareNativeSelections(input, host);
    if (!rows.length) return refuse('template_needs_review');
    // Every selected native database owns its variables, including future companion placements.
    const nativeVariables = new Set(rows.flatMap(row => Object.values(row.input.template.data?.variables ?? {})));
    const explicitBindings = input.explicitBindings?.filter(binding => !nativeVariables.has(binding.name));
    const blueprints = explicitBindings ? { explicitBindings } : {};
    const repositoryRows = rows.filter(row => row.placement.placement === 'repository');
    const selections = repositoryRows.map(row => input.selections[row.placement.selectionIndex]!);
    if (!repositoryRows.length) return { name: input.name, definition: input.definition, companionRequired: true,
        data: [], preparations: [], selections: [], ...blueprints };
    for (const row of repositoryRows) for (const secret of row.prepared.generatedSecrets)
        validateDeploymentTemplateGeneratedSecretProfileForHost({ name: `${input.name} · ${secret.name}`, profile: secret.profile });
    const services = new Set(repositoryRows.map(row => row.placement.service));
    const template = { ...repositoryRows[0]!.prepared.template,
        services: [...services], data: repositoryRows.flatMap(row => row.prepared.template.data ?? []),
        volumes: input.existingTemplate!.volumes?.filter(volume => services.has(volume.service)),
        health: input.existingTemplate!.health?.filter(health => services.has(health.service)),
        exports: Object.assign({}, ...repositoryRows.map(row => row.prepared.template.exports)), definition: input.definition };
    return { name: input.name, definition: input.definition, template, ...blueprints,
        backup: combineSelectionBackups(repositoryRows.flatMap(row => {
            const backup = prepareSelectionBackup(input.selections[row.placement.selectionIndex]!, row.input, row.prepared);
            return backup ? [backup] : [];
        })),
        ...(repositoryRows.length === rows.length ? {} : { companionRequired: true as const }),
        data: repositoryRows.map(row => ({ service: row.placement.service, database: row.placement.database })),
        preparations: repositoryRows.map(row => ({ input: row.input, prepared: row.prepared })), selections };
}

/** Entropy is acquired only by the admitted create continuation, through the ordinary Saved Secret owner. */
export async function materializePreviewTemplateBindingsForHost(plan: PreviewTemplateCreationPlanForHost,
    context: ActionExecutorContext, host: Host): Promise<EnvironmentSecretBindingV1[]> {
    const custody = templateCustody(context, host);
    const bindings = new Map<string, EnvironmentSecretBindingInputV1>();
    for (const step of plan.preparations) {
        const generated: StoredAppPresetInputV1['bindings'] = [];
        await withDeploymentTemplateGeneratedSecretsForHost(async createGeneratedSecret => {
            for (const secret of step.prepared.generatedSecrets) {
                const source = await createGeneratedSecret({ key: secret.key, phase: secret.phase, name: `${plan.name} · ${secret.name}`,
                    profile: secret.profile, audience: { accountGrants: [], teamGrants: [], groupGrants: [] },
                    expectedScopeKey: resolveAccountSettingsScopeKey(custody.credentials),
                    signal: context.signal ?? new AbortController().signal, readCredentials: async () => custody.credentials,
                    operationContext: custody.operation });
                generated.push({ purpose: 'variable', name: secret.name, phase: secret.phase, source });
            }
        });
        const prepared = prepareDeploymentTemplateInstantiationV1({ ...step.input, bindings: generated });
        for (const binding of prepared.bindings) bindings.set(`${binding.phase}:${binding.name}`, binding);
    }
    for (const binding of plan.explicitBindings ?? []) bindings.set(`${binding.phase}:${binding.name}`, binding);
    return applyEnvironmentSecretBindingsPatchV1([], { set: [...bindings.values()], remove: [] }, randomUUID);
}

/** The app consumes the companion's fresh variable refs and its ordinary private export. */
export function readPreviewCompanionBindingsForHost(plan: PreviewTemplateCreationPlanForHost,
    bindings: readonly EnvironmentSecretBindingV1[], environmentId: string): EnvironmentVariableBindingInputV1[] {
    const declarations = plan.template?.data ?? [];
    const names = new Set(declarations.flatMap(data => Object.values(data.variables ?? {})));
    const result = new Map<string, EnvironmentVariableBindingInputV1>(bindings.filter((binding): binding is EnvironmentVariableBindingV1 =>
        binding.purpose === 'variable' && names.has(binding.name)).map(binding => [binding.name, binding]));
    for (const data of declarations) for (const component of ['host', 'port'] as const) {
        const name = data.variables?.[component] ?? refuse('template_needs_review');
        result.set(name, { purpose: 'variable', phase: 'runtime', name,
            source: { kind: 'reference', environmentId, export: data.service, via: 'auto', component } });
    }
    return [...result.values()];
}

/** Existing reviewed create composition owns the child and its ordinary binding/configuration writers. */
export async function executePreviewTemplateCreationForHost(input: Readonly<{
    plan: PreviewTemplateCreationPlanForHost; prepared: DeploymentEnvironmentCreateInputV1; context: ActionExecutorContext;
    existing?: Readonly<{ environmentId: string; revision: number; runtimeTargetLinkId: string }>;
}>, host: Host & Readonly<{ storage: NonNullable<ActionExecutorDeps['deploymentAction']> }>): Promise<ActionExecuteResult> {
    let effectAttempted = false;
    try {
        effectAttempted = true;
        const bindings = await materializePreviewTemplateBindingsForHost(input.plan, input.context, host);
        const created = input.existing ? { ok: true as const, ...input.existing }
            : DeploymentEnvironmentCreateResultV1Schema.parse(await host.storage('deployments.environments.create',
                input.prepared, input.context));
        if (!created.ok) return { ok: false, errorCode: created.error, error: created.error, effectAttempted };
        const backup = input.plan.backup;
        let revision = created.revision;
        if (bindings.length) {
            const child = input.context.hostReviewedChild ?? refuse('credential_scope_denied');
            const bound = await child.invoke({ action: 'deployments.bindings.set', role: 'preview.bindings', input: normalizeStrictJsonValue({
                serverId: input.prepared.serverId, environmentId: created.environmentId, expectedRevision: created.revision,
                set: bindings, remove: [],
            }) });
            if (!bound.ok) return { ...bound, effectAttempted };
            const bindingResult = DeploymentBindingsSetResultV1Schema.parse(bound.result);
            if (!bindingResult.ok) return { ok: false, errorCode: bindingResult.error, error: bindingResult.error, effectAttempted };
            revision = bindingResult.revision;
        }
        if (backup) {
            const child = input.context.hostReviewedChild ?? refuse('credential_scope_denied');
            const updated = await child.invoke({ action: DEPLOYMENT_BACKUP_CONFIGURE_ACTION_ID_V1, role: 'preview.backup', input: normalizeStrictJsonValue({
                serverId: input.prepared.serverId, environmentId: created.environmentId, expectedRevision: revision,
                intent: 'initializeAndSave', backupBindings: backup.bindings,
                configuration: { ...backup.configuration, ownership: { environmentId: created.environmentId,
                    prefix: `${backup.prefix}/${created.environmentId}` } },
            }) });
            if (!updated.ok) return { ...updated, effectAttempted };
            const updateResult = DeploymentBackupConfigureResultV1Schema.parse(updated.result);
            if (updateResult.kind !== 'configured') return { ok: false, errorCode: 'backup_required', error: 'backup_required',
                effectAttempted, details: { environmentId: created.environmentId, revision, configurationResult: updateResult } };
            revision = updateResult.revision;
        }
        return { ok: true, result: { ...created, revision, previewNativeData: input.plan.data,
            ...(input.prepared.previewCompanionOfEnvironmentId ? {
                previewNativeBindings: readPreviewCompanionBindingsForHost(input.plan, bindings, created.environmentId) } : {}),
            ...(input.plan.companionRequired ? { previewCompanionRequired: true } : {}) } };
    } catch (error) {
        return { ...projectDeploymentException(error, { signal: input.context.signal }), effectAttempted };
    }
}
