import { afterEach } from 'vitest';

import type { PluginDaemonModuleNamespace } from '../../types';
import type { AgentContributionRuntimeRegistration } from '../../api/registrationRightsHost';
import type { CanonicalPluginManifest } from '@/plugins/manifest/types';
import { ingestCanonicalPluginManifest } from '@/plugins/manifest/ingest';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginActivationSourceResolver } from '../../pluginActivationSource';
import { createBundledActivationSourceResolver } from '../../bundledActivationSource';
import { isPrimaryAgentContributionDefinition } from '@/plugins/projection/registry/agentContributionDefinition';
import { BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { activateContributionModule } from '../activation/activateContributionModule';
import {
    createDeclarativeAcpAgentRuntimeRegistry as createDeclarativeAcpAgentRuntimeRegistryProduction,
    createTargetAgentRuntimeRegistry as createTargetAgentRuntimeRegistryProduction,
} from './targetAgents';

type TargetRegistryParams = Parameters<typeof createTargetAgentRuntimeRegistryProduction>[0];
type DeclarativeRegistryParams = Parameters<typeof createDeclarativeAcpAgentRuntimeRegistryProduction>[0];
type IdentityReaders = 'readPluginOccurrenceId' | 'readPluginSourceCustody';
type WithoutIdentityReaders<T> = T extends unknown ? Omit<T, IdentityReaders> : never;
type AuthoredFixture = Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>;
type AdmittedRegistry = ReturnType<typeof createTargetAgentRuntimeRegistryProduction> & Readonly<{
    fixture: AuthoredFixture;
    readPluginOccurrenceId: NonNullable<AuthoredFixture['registry']['readPluginOccurrenceId']>;
    readPluginSourceCustody: NonNullable<AuthoredFixture['registry']['readPluginSourceCustody']>;
}>;
type FixtureOptions = Readonly<{
    /** Physical behavior is loaded without injecting callbacks for custody assertions. */
    behavior?: 'activation_unit' | 'physical';
    /** Deliberately malformed owner input, after genuine source admission. */
    invalidOwnerInput?: boolean;
}>;
type TargetRegistryFixtureParams = WithoutIdentityReaders<TargetRegistryParams> & FixtureOptions;
type DeclarativeRegistryFixtureParams = WithoutIdentityReaders<DeclarativeRegistryParams> & FixtureOptions & Readonly<{
    occurrenceId?: string;
    admittedFixture?: AuthoredFixture;
}>;

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
});

const ACP_TRANSPORT = { kind: 'stdio', executable: { kind: 'systemTool', id: 'fixture-acp' } };
const SESSION_CAPABILITIES = { open: ['create'], delivery: ['newTurn'], cancel: true };
const SOURCE_DECLARATION = {
    sourceKind: 'fixture',
    schema: { fields: [{ name: 'kind', kind: 'literal', value: 'fixture' }] },
    key: { segments: [{ kind: 'literal', value: 'fixture' }] },
    instances: [{ kind: 'default', constants: {} }],
};

function requireManifest(value: unknown): CanonicalPluginManifest {
    const result = ingestCanonicalPluginManifest(value, { sourceProvenance: 'registryCustodied' });
    if (!result.ok) throw new Error(result.diagnostics.map(({ message }) => message).join('\n'));
    return result.manifest;
}

function authoredFiles(entries: readonly Readonly<{
    localId: string;
    value: AgentContributionRuntimeRegistration;
    custom: boolean;
    sessionPrimary: boolean;
}>[]) {
    const physicalRuntime = `({ sessions: { open: async () => ({
        send: async () => ({ status: 'admitted' }),
        watch: () => ({ dispose() {} }), dispose() {},
    }) } })`;
    const physicalExternalSessions = `({
        resolveSource: async ({source}) => ({ok:true,value:{source}}),
        listCandidates: async () => ({ok:true,value:{candidates:[],nextCursor:null}}),
        resolveLinkIdentity: async ({source,remoteSessionId,linkData={}}) => ({ok:true,value:{source,remoteSessionId,linkData}}),
        resolveLinkedIdentity: async ({source,remoteSessionId,linkData}) => ({ok:true,value:{source,remoteSessionId,linkData}}),
        pageTranscript: async () => ({ok:true,value:{items:[],nextCursor:null}}),
        readAfterTranscript: async () => ({ok:true,value:{outcome:'already_current'}}),
    })`;
    const declarations = entries.map((entry, index) => `
        export let createAgent${index} = async () => ${physicalRuntime};
        export let externalSessions${index} = ${physicalExternalSessions};
        export let options${index} = {};
        export let terminal${index} = {resolveLaunch:async()=>({argv:['fixture-terminal']})};
        export let hooks${index} = {
            installationVariants:[{variantId:'fixture-v1',targets:[{targetId:'settings',format:'hook_event_json_arrays_v1',collectionId:'hooks'}],
                events:[{eventId:'session-start',targetId:'settings',nativeEventName:'SessionStart',command:{kind:'happier_observation_v1',shellDialect:'posix'}}]}],
            resolveInstallation:async()=>({ok:true,value:{kind:'supported',variantId:'fixture-v1',targets:[{targetId:'settings',absolutePath:'/var/lib/acme/settings.json'}],readiness:{kind:'ready'}}}),
            mapHookEvent:async()=>({ok:true,value:{kind:'ignored'}}),
        };
        export let observation${index} = {
            describeResource:()=>({resourceKey:'fixture-resource',linkKey:'fixture-link',changeObservation:'reconcile_only'}),
            observeResource:async()=>({dispose(){}}),
            reconcileResource:async({purpose,links})=>({purpose,outcomes:links.map(({linkKey})=>purpose==='resource_descriptors'?{kind:'unavailable',linkKey}:{linkKey,facts:[]})}),
        };
        export let takeover${index} = {resolveLaunch:async()=>({ok:true,value:{}})};
        export let cliAuth${index};
    `).join('\n');
    const configure = entries.map((entry, index) => `
        if (values[${index}]?.factory) createAgent${index} = values[${index}].factory;
        if (values[${index}]?.externalSessions) externalSessions${index} = values[${index}].externalSessions;
        const {factory:factory${index},externalSessions:external${index},terminal:terminalValue${index},
            externalSessionHooks:hookValue${index},externalSessionObservation:observationValue${index},externalSessionTakeover:takeoverValue${index},
            ...registeredOptions${index}} = values[${index}] ?? {};
        options${index} = registeredOptions${index};
        if (values[${index}]?.terminal) terminal${index} = values[${index}].terminal;
        if (values[${index}]?.externalSessionHooks) hooks${index} = values[${index}].externalSessionHooks;
        if (values[${index}]?.externalSessionObservation) observation${index} = values[${index}].externalSessionObservation;
        if (values[${index}]?.externalSessionTakeover) takeover${index} = values[${index}].externalSessionTakeover;
        cliAuth${index} = values[${index}]?.cliAuth;
    `).join('\n');
    const registrations = entries.map((entry, index) => {
        const id = JSON.stringify(entry.localId);
        const options = entry.sessionPrimary ? `{
            ...leaf.options${index},
            sessionRunnerFactory: {module:'./agent-runtime.mjs',export:'createAgent${index}',runtimeApiVersion:1,
                ${entry.value.externalSessions ? `externalSessionsExport:'externalSessions${index}'` : ''}},
        }` : `leaf.options${index}`;
        return [
            ...(entry.custom ? [`api.agents.register(${id},leaf.createAgent${index},${options});`] : []),
            ...(entry.value.externalSessions ? [`api.agents.registerExternalSessions(${id},leaf.externalSessions${index});`] : []),
            ...(entry.value.terminal ? [`api.agents.registerTerminal(${id},leaf.terminal${index});`] : []),
            ...(entry.value.externalSessionHooks ? [`api.agents.registerExternalSessionHooks(${id},leaf.hooks${index});`] : []),
            ...(entry.value.externalSessionObservation ? [`api.agents.registerExternalSessionObservation(${id},leaf.observation${index});`] : []),
            ...(entry.value.externalSessionTakeover ? [`api.agents.registerExternalSessionTakeover(${id},leaf.takeover${index});`] : []),
            ...(!entry.custom && entry.value.cliAuth ? [`api.agents.registerCliAuth(${id},leaf.cliAuth${index});`] : []),
            ...(!entry.custom && entry.value.connectedAccountLaunch ? [`api.agents.registerConnectedAccountLaunch(${id},leaf.options${index}.connectedAccountLaunch);`] : []),
        ].join('\n');
    }).join('\n');
    return {
        'agent-runtime.mjs': `${declarations}\nexport function configureUnitLeaves(values) {${configure}}\n`,
        'daemon.mjs': `import * as leaf from './agent-runtime.mjs';
            export function activate(api) {${registrations}}
            // Callback injection proves SDK activation, not callback byte integrity.
            export function createActivationUnitModule(values) {
                leaf.configureUnitLeaves(values); return {activate};
            }\n`,
    };
}

function authoredPlugin(params: Readonly<{
    pluginId: string;
    version: string;
    agents: TargetRegistryParams['agents'];
    registrations: TargetRegistryParams['targetRegistrations'];
    behavior: 'activation_unit' | 'physical';
    invalidOwnerInput?: boolean;
}>) {
    const registrations = params.registrations.flatMap(({ registration }) => registration.family === 'agents' ? [registration] : []);
    const localIds = [...new Set([
        ...registrations.map(({ localId }) => localId),
        ...params.agents.map((agent) => agent.identity?.localId ?? agent.richDefinition?.definition.id ?? agent.id),
    ])];
    const entries = localIds.map((localId) => {
        const value = registrations.find((entry) => entry.localId === localId)?.value ?? {};
        const selected = params.agents.find((agent) => (agent.identity?.localId ?? agent.richDefinition?.definition.id ?? agent.id) === localId)?.richDefinition?.definition;
        const custom = value.factory !== undefined || value.daemonSpawnHooks !== undefined || value.terminalPromptSubmitVerification !== undefined;
        const sessionPrimary = custom && !(selected
            && isPrimaryAgentContributionDefinition(selected)
            && selected.primary === 'executionRuns');
        const surfaces = [...(value.externalSessions ? ['externalSessions'] : []), ...(value.terminal ? ['terminal'] : [])];
        const declared = selected ?? {
            id: localId, title: localId, runtime: custom ? { kind: 'custom' } : { kind: 'acp', transport: ACP_TRANSPORT },
            primary: 'sessions', capabilities: { sessions: SESSION_CAPABILITIES },
        };
        const definition = {
            ...declared,
            ...(custom ? { runtime: { kind: 'custom' } } : {}),
            capabilities: {
                ...declared.capabilities,
                ...(surfaces.length > 0 ? { surfaces } : {}),
                ...(params.invalidOwnerInput ? { sessions: { ...SESSION_CAPABILITIES, open: ['create', 'resume'] } } : {}),
            },
            ...(value.externalSessions ? {
                surfaces: { ...('surfaces' in declared ? declared.surfaces : undefined), externalSession: {
                    externalLinkedTakeover: { writerSafety: 'unsupported' }, sources: [SOURCE_DECLARATION],
                } },
            } : {}),
        };
        return { localId, value, custom, sessionPrimary, definition };
    });
    const manifest = requireManifest(createPluginManifestV2Fixture({
        id: params.pluginId, version: params.version, entrypoints: { daemon: './daemon.mjs' },
        contributes: { agents: entries.map(({ definition }) => definition) },
    }));
    return {
        manifest, files: authoredFiles(entries),
        ...(params.behavior === 'activation_unit' ? {
            instantiateCommittedModule(module: PluginDaemonModuleNamespace) {
                const factory = module.createActivationUnitModule;
                if (typeof factory !== 'function') throw new Error('Expected the authored activation unit module factory');
                const instantiated: unknown = factory(entries.map(({ value }) => value));
                if (!instantiated || typeof instantiated !== 'object' || !('activate' in instantiated)) throw new Error('Authored unit module has no activate(api)');
                // Actual file-module boundary: the imported factory authors the
                // callback scope for these exact manifest declarations.
                return instantiated as PluginDaemonModuleNamespace;
            },
        } : {}),
    };
}

function attachFixture(registry: ReturnType<typeof createTargetAgentRuntimeRegistryProduction>, fixture: AuthoredFixture): AdmittedRegistry {
    const readPluginOccurrenceId = fixture.registry.readPluginOccurrenceId;
    const readPluginSourceCustody = fixture.registry.readPluginSourceCustody;
    if (!readPluginOccurrenceId || !readPluginSourceCustody) throw new Error('Admitted fixture has no source identity readers');
    return Object.assign(registry, { fixture, readPluginOccurrenceId, readPluginSourceCustody });
}

/** UNIT callbacks exercise public registration and host wrapping, not source byte integrity. */
export async function createTargetAgentRuntimeRegistry(params: TargetRegistryFixtureParams): Promise<AdmittedRegistry> {
    const behavior = params.behavior ?? 'activation_unit';
    const plugins = params.activationTargets.map((target) => authoredPlugin({
        pluginId: target.pluginId, version: target.manifest.version,
        agents: params.agents.filter((agent) => agent.pluginId === target.pluginId),
        registrations: params.targetRegistrations.filter((entry) => entry.pluginId === target.pluginId), behavior,
    }));
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ plugins });
    disposers.push(() => fixture.dispose());
    const targets = fixture.registry.contributes.activationTargets.filter((target) => plugins.some(({ manifest }) => manifest.id === target.pluginId));
    if (behavior === 'physical') {
        const physical = new Map<string, (typeof fixture.registry.agentRuntimesByAgentId extends ReadonlyMap<string, infer Lease> ? Lease : never)>();
        for (const selected of params.agents) {
            const localId = selected.identity?.localId ?? selected.richDefinition?.definition.id ?? selected.id;
            const lease = [...fixture.registry.agentRuntimesByAgentId.values()].find((candidate) => candidate.pluginId === selected.pluginId && candidate.localAgentId === localId);
            if (lease) physical.set(selected.id, lease);
        }
        return attachFixture(physical, fixture);
    }
    const resolveSource = createPluginActivationSourceResolver({
        committed: fixture.committed,
        preparedActivationGraphsByPluginId: fixture.preparedActivationGraphsByPluginId,
        happyHomeDir: fixture.happyHomeDir,
        resolveBundledActivationSource: createBundledActivationSourceResolver({ bundledPackageNames: BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES }),
        activatedManifestAuthorityByPluginId: new Map(),
    });
    const targetRegistrations: TargetRegistryParams['targetRegistrations'][number][] = [];
    for (const target of targets) {
        const occurrenceId = fixture.registry.readPluginOccurrenceId?.(target.pluginId);
        const source = resolveSource(target);
        if (!occurrenceId || !source || source.kind !== 'prepared') throw new Error('Expected the same admitted authored activation unit source');
        const activated = await activateContributionModule({
            pluginId: target.pluginId, occurrenceId, manifest: target.manifest, moduleNamespace: source.module,
            isOccurrenceCurrent: () => fixture.registry.isPluginOccurrenceCurrent?.(target.pluginId, occurrenceId) === true,
            ...(source.resolveRelativeModule ? { resolveRelativeModule: source.resolveRelativeModule } : {}),
        });
        disposers.push(() => activated.dispose());
        if (activated.status !== 'active') throw new Error(activated.diagnostics.map(({ message }) => message).join('\n'));
        targetRegistrations.push(...activated.registrations.map((registration) => ({ pluginId: target.pluginId, occurrenceId, registration })));
    }
    const agents = params.invalidOwnerInput ? params.agents : params.agents.map((agent) => ({
        ...agent,
        identity: agent.identity ?? (agent.pluginId ? { pluginId: agent.pluginId, localId: agent.richDefinition?.definition.id ?? agent.id } : undefined),
    }));
    const immutableGenerationIdsByPluginId = new Map(targets.flatMap((target) => {
        const custody = fixture.registry.readPluginSourceCustody?.(target.pluginId);
        return custody?.kind === 'managed' ? [[target.pluginId, custody.immutableGenerationId] as const] : [];
    }));
    return attachFixture(createTargetAgentRuntimeRegistryProduction({
        ...params, agents, activationTargets: targets, targetRegistrations, immutableGenerationIdsByPluginId,
        readPluginOccurrenceId: (pluginId) => fixture.registry.readPluginOccurrenceId?.(pluginId) ?? null,
        readPluginSourceCustody: (pluginId) => fixture.registry.readPluginSourceCustody?.(pluginId) ?? null,
    }), fixture);
}

export async function createDeclarativeAcpAgentRuntimeRegistry(params: DeclarativeRegistryFixtureParams): Promise<AdmittedRegistry> {
    const fixture = params.admittedFixture ?? await createAuthoredAdmittedPluginRuntimeFixture({
        plugins: [...new Set(params.agents.flatMap((agent) => agent.pluginId ? [agent.pluginId] : []))].map((pluginId) => authoredPlugin({
            pluginId, version: params.agents.find((agent) => agent.pluginId === pluginId)?.sourceSpec?.resolvedVersion ?? '0.0.0',
            agents: params.agents.filter((agent) => agent.pluginId === pluginId), registrations: [],
            behavior: 'physical', invalidOwnerInput: params.invalidOwnerInput,
        })),
    });
    if (!params.admittedFixture) disposers.push(() => fixture.dispose());
    return attachFixture(createDeclarativeAcpAgentRuntimeRegistryProduction({
        ...params,
        readPluginOccurrenceId: (pluginId) => fixture.registry.readPluginOccurrenceId?.(pluginId) ?? null,
        readPluginSourceCustody: (pluginId) => fixture.registry.readPluginSourceCustody?.(pluginId) ?? null,
    }), fixture);
}
