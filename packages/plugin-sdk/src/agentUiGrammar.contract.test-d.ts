/**
 * Declaration-level fixture for the PUBLIC Agent UI authoring grammar.
 *
 * `contributes.agents[].ui` used to be an untyped JSON bag, so an external
 * author's misspelled or unreachable declaration compiled cleanly and then
 * silently no-opped when the client interpreted it. The grammar now types the
 * field, and this fixture pins both directions: everything an installed Agent
 * can actually reach stays authorable, and the shapes it cannot satisfy fail to
 * typecheck where they are written.
 */
import type { PluginManifestAuthorInput } from './manifest.js';

type AgentContributions = NonNullable<NonNullable<PluginManifestAuthorInput['contributes']>['agents']>;

const supported: AgentContributions = [{
    id: 'acme.agent',
    ui: {
        behavior: {
            newSession: {
                transcriptStorageModes: ['persisted', 'direct'],
                agentOptions: [{ key: 'allowIndexing', kind: 'boolean', spawnConfigOption: true }],
            },
            payload: {
                spawnSessionExtras: { kind: 'static', value: { acmeMode: 'fast' } },
                sessionExtras: { outputKey: 'acmeMode', values: ['fast', 'thorough'] },
            },
            externalSessions: { browse: { order: 4 } },
        },
        message: {
            metaOverrides: [{
                id: 'acme.mode',
                targetKey: 'acmeMode',
                value: { kind: 'sessionConfigOptionOverride', key: 'acmeMode' },
            }],
        },
        components: {
            slots: [{
                id: 'acme-allow-indexing',
                slot: 'newSession.agentInputExtraActionChips',
                chip: {
                    kind: 'booleanOption',
                    optionStateKey: 'allowIndexing',
                    iconName: 'magnifying-glass',
                    onLabelKey: 'acme.indexing.on',
                    offLabelKey: 'acme.indexing.off',
                },
            }],
        },
    },
}];

const misspelledOptionKind: AgentContributions = [{
    id: 'acme.agent',
    ui: {
        behavior: {
            // @ts-expect-error 'bool' is not a declarable new-session option kind.
            newSession: { agentOptions: [{ key: 'allowIndexing', kind: 'bool' }] },
        },
    },
}];

const unknownBehaviorBlock: AgentContributions = [{
    id: 'acme.agent',
    ui: {
        // @ts-expect-error `newSesion` is not part of the Agent UI grammar.
        behavior: { newSesion: { canSelectWithoutDetectedCli: true } },
    },
}];

const repeatedAgentIdentity: AgentContributions = [{
    id: 'acme.agent',
    ui: {
        behavior: {
            payload: {
                sessionExtras: {
                    // @ts-expect-error nested behavior inherits `contributes.agents[].id`.
                    providerId: 'another.agent',
                    outputKey: 'acmeMode',
                    values: ['fast'],
                },
            },
        },
    },
}];

/**
 * The compiled first-party escape hatches. They name components, adapters and
 * meta descriptors built into the app, so no manifest can satisfy them; the
 * grammar refuses them instead of promising a capability that only ever
 * produces a refusal diagnostic.
 */
const compiledComponentId: AgentContributions = [{
    id: 'acme.agent',
    ui: {
        components: {
            // @ts-expect-error compiled first-party component ids are not authorable.
            slots: [{ id: 'x', slot: 'session.detailsTabs', componentId: 'firstParty.claude.teammateDetailsTab' }],
        },
    },
}];

const compiledPayloadAdapter: AgentContributions = [{
    id: 'acme.agent',
    ui: {
        behavior: {
            // @ts-expect-error only the `static` spawn-extras form is authorable.
            payload: { spawnSessionExtras: { kind: 'adapter', adapterId: 'codex.backendMode' } },
        },
    },
}];

const nonScalarStaticSpawnOption: AgentContributions = [{
    id: 'acme.agent',
    ui: {
        behavior: {
            payload: {
                spawnSessionExtras: {
                    kind: 'static',
                    // @ts-expect-error static spawn configuration is scalar-only.
                    value: { acmeMode: { nested: true } },
                },
            },
        },
    },
}];

const compiledMessageMetaDescriptors: AgentContributions = [{
    id: 'acme.agent',
    // @ts-expect-error compiled message-meta descriptor ids are not authorable.
    ui: { message: { metaDescriptorIds: ['claude.thinking'] } },
}];

export type _AgentUiGrammarFixtures = [
    typeof supported,
    typeof misspelledOptionKind,
    typeof unknownBehaviorBlock,
    typeof repeatedAgentIdentity,
    typeof compiledComponentId,
    typeof compiledPayloadAdapter,
    typeof nonScalarStaticSpawnOption,
    typeof compiledMessageMetaDescriptors,
];
