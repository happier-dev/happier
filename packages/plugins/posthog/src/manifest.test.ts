import { readFile } from 'node:fs/promises';

import { definePlugin } from '@happier-dev/plugin-sdk';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import { TriageScanInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { assertTriageSourceContributionV1 } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import { posthogConnectedAccountRuntime } from './connect/account.js';
import {
    PLUGIN_MANIFEST,
    POSTHOG_ACTION_IDS,
    POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
    POSTHOG_DETAIL_ARTIFACT_ID,
    POSTHOG_DETAIL_FALLBACK_RENDERER_ID,
    POSTHOG_DETAIL_RENDERER_ID,
} from './manifest.js';
import {
    POSTHOG_API_ORIGIN_FIELD_ID,
    POSTHOG_PERSONAL_API_KEY_MODE_ID,
} from './posthogContracts.js';

/**
 * Declares one Action carrying the *published* scan input — the discriminated union
 * this source cannot replace — with whichever credential-ref binding path the caller
 * wants proven or refuted, then puts it through the SAME manifest ingest a host runs
 * before any manifest may contribute anything.
 *
 * Ingest, not `definePlugin`, is the credential-ref binding walker's decision point:
 * `definePlugin` is an authoring projector and validates no contribution schema, so a
 * probe that only called it could never observe a rejection and proved nothing.
 *
 * A guarantee that cannot fail is not a guarantee: this is what lets the accepted union
 * binding below be distinguished from a walker that silently admits whatever it is handed.
 */
function defineScanBindingProbe(bindingPath: string) {
    return definePlugin({
        id: 'happier.posthog-manifest-probe',
        version: '0.0.0',
        displayName: 'PostHog manifest probe',
        engines: { happier: '^0.0.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './.happier-plugin/daemon.js' },
        hostAccess: {
            required: [{
                id: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
                capability: 'connectedAccounts',
                reason: 'Probe the canonical credential-ref binding walker.',
                scope: {
                    serviceRefs: [POSTHOG_CONNECTED_ACCOUNT_PURPOSE],
                    operations: ['select', 'use'],
                    materializationKinds: ['httpHeaders'],
                },
            }],
            optional: [],
        },
        connectedAccountDescriptors: {
            [POSTHOG_CONNECTED_ACCOUNT_PURPOSE]: {
                declaration: {
                    title: 'Probe account',
                    authentication: {
                        defaultModeId: 'manual',
                        modes: [{
                            id: 'manual',
                            kind: 'manual',
                            title: 'Manual',
                            outcomeReconciliation: 'none',
                            fields: [{
                                id: 'token',
                                title: 'Token',
                                schema: { type: 'string', minLength: 1 },
                                secret: true,
                            }],
                        }],
                    },
                },
                runtime: posthogConnectedAccountRuntime,
            },
        },
        actions: {
            probe: {
                title: 'Probe',
                execution: { target: 'daemon' },
                scopes: ['global'],
                surfaces: ['plugin'],
                dangerLevel: 'safe',
                inputSchema: TriageScanInputV1Schema.jsonSchema,
                hostAccess: [POSTHOG_CONNECTED_ACCOUNT_PURPOSE],
                connectedAccountPurposeBindings: [{
                    path: bindingPath,
                    purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
                }],
                run: () => ({ kind: 'failed' as const }),
            },
        },
    });
}

describe('PostHog plugin manifest', () => {
    it('publishes the manifest subpath consumed by the bundled-plugin registry', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

        expect(packageJson.exports['./manifest']).toEqual({
            types: './dist/manifest.d.ts',
            default: './dist/manifest.js',
        });
    });

    it('declares one conforming Triage source contribution and no Composer surface', () => {
        expect(() => assertTriageSourceContributionV1(PLUGIN_MANIFEST)).not.toThrow();
        // The claim is that this plugin contributes NOTHING to any Composer family:
        // `happier.triage` owns the one whole-entry attachment and control, and a
        // second owner here would make the aggregate ambiguous about what a row is.
        //
        // It is asserted over whatever families the projection actually emits rather
        // than over four hard-coded key names. Two things changed underneath that
        // spelling — an omitted family now projects as absent rather than as `[]`, and
        // the authorable key names are the SDK's to move — and neither is a fact about
        // PostHog. The substring guard is what keeps this from passing vacuously: a
        // declared composer contribution puts its family name in these bytes under any
        // spelling, including the attachment and region families.
        const contributes = PLUGIN_MANIFEST.contributes as Readonly<Record<string, unknown>>;
        for (const [family, declared] of Object.entries(contributes)) {
            if (!family.toLowerCase().startsWith('composer')) continue;
            expect(declared, family).toEqual([]);
        }
        expect(JSON.stringify(contributes).toLowerCase()).not.toContain('composer');
    });

    it('authorizes exact account materialization and GET+POST to its origin, including the PAT pilot', () => {
        expect(PLUGIN_MANIFEST.hostAccess.required).toEqual(expect.arrayContaining([{
            id: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            capability: 'connectedAccounts',
            reason: expect.any(String),
            scope: {
                serviceRefs: [POSTHOG_CONNECTED_ACCOUNT_PURPOSE],
                operations: ['select', 'use'],
                materializationKinds: ['httpHeaders'],
            },
        }, {
            id: 'posthog-network',
            capability: 'network',
            reason: expect.any(String),
            scope: {
                targets: [{ kind: 'connectedAccountOrigin', service: POSTHOG_CONNECTED_ACCOUNT_PURPOSE }],
                methods: ['GET', 'POST'],
                privateNetwork: true,
            },
        }]));

        const actions = new Map(PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]));
        expect(actions.has(POSTHOG_ACTION_IDS.capability)).toBe(true);
        for (const id of Object.values(POSTHOG_ACTION_IDS)) {
            expect(actions.get(id)?.execution).toEqual({ target: 'daemon' });
            expect(actions.get(id)?.hostAccess)
                .toEqual([POSTHOG_CONNECTED_ACCOUNT_PURPOSE, 'posthog-network']);
        }
        // Every Action that reaches a Connected Account declares which input leaf names
        // it. `listInstances` is the sole exception, and not by omission: discovering
        // accounts is what it does, so its published input carries no account at all.
        const declaredBinding = [{
            path: 'instance.binding.account',
            purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
        }];
        expect(actions.get(POSTHOG_ACTION_IDS.get)?.connectedAccountPurposeBindings)
            .toEqual(declaredBinding);
        expect(actions.get(POSTHOG_ACTION_IDS.scan)?.connectedAccountPurposeBindings)
            .toEqual(declaredBinding);
        expect(actions.get(POSTHOG_ACTION_IDS.configuration)?.connectedAccountPurposeBindings)
            .toEqual([{
                path: 'binding.account',
                purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            }]);
        expect(actions.get(POSTHOG_ACTION_IDS.capability)?.connectedAccountPurposeBindings)
            .toEqual([{
                path: 'draft.binding.account',
                purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
            }]);
        expect(actions.get(POSTHOG_ACTION_IDS.listInstances)?.connectedAccountPurposeBindings)
            .toBeUndefined();
    });

    it('binds scan through the union-shaped published input and rejects a malformed path', () => {
        const ingestScanBinding = (bindingPath: string) => parsePluginManifest(
            defineScanBindingProbe(bindingPath).manifest,
        );
        const rejectedBindingPaths = (bindingPath: string): readonly string[] => {
            const parsed = ingestScanBinding(bindingPath);
            if (parsed.ok) return [];
            return parsed.diagnostics
                .filter((diagnostic) => diagnostic.message.includes('Connected Account purpose bindings'))
                .map((diagnostic) => diagnostic.path.join('.'));
        };

        // `instance` is carried identically by both published scan arms, so the leaf is
        // proven for every representable input rather than for whichever arm was read
        // first. This is the declaration the real manifest makes.
        expect(ingestScanBinding('instance.binding.account').ok).toBe(true);

        // A path only the `initial` arm can reach proves nothing about a `continuation`
        // invocation, so it must be rejected — otherwise the accepted declaration above
        // would only mean the walker looked at one arm. The diagnostic path is asserted
        // so an unrelated ingest failure cannot masquerade as this rejection.
        expect(rejectedBindingPaths('page.limit'))
            .toEqual(['contributes.actions.0.connectedAccountPurposeBindings.0.path']);

        // Reachable in both arms, but not a qualified credential ref: a binding that
        // admitted this would let the source name a purpose over a value the host cannot
        // resolve to one exact account.
        expect(rejectedBindingPaths('instance.binding'))
            .toEqual(['contributes.actions.0.connectedAccountPurposeBindings.0.path']);
    });

    it('binds the detail surface to the native renderer and keeps a truthful fallback', () => {
        const renderers = new Map(
            PLUGIN_MANIFEST.contributes.ui.renderers.map((renderer) => [renderer.id, renderer]),
        );

        expect(renderers.get(POSTHOG_DETAIL_RENDERER_ID)).toMatchObject({
            kind: 'reactNative',
            artifact: POSTHOG_DETAIL_ARTIFACT_ID,
            // The body reads through this plugin's own Actions, so a mount without them
            // would be an empty shell rather than a useful surface.
            requiredHostMethods: ['executeAction'],
        });
        // A host that cannot mount a React Native artifact still gets a body that says
        // what it is, instead of an empty pane.
        expect(renderers.get(POSTHOG_DETAIL_FALLBACK_RENDERER_ID)).toMatchObject({
            kind: 'declarative',
        });

        // Declaring the fallback is not what makes it render: the contribution's own
        // detail binding is the renderer chain the host resolves, so a fallback missing
        // from it can never be selected.
        const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions
            .find((candidate) => candidate.target.pluginId === 'happier.triage');
        expect(contribution?.surfaces).toEqual({
            detail: {
                renderer: POSTHOG_DETAIL_RENDERER_ID,
                fallbackRenderers: [POSTHOG_DETAIL_FALLBACK_RENDERER_ID],
            },
        });
    });

    it('declares the source-native sampled read without giving it a Triage role', () => {
        const actions = new Map(
            PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]),
        );
        const sampled = actions.get(POSTHOG_ACTION_IDS.issueEvents);

        expect(sampled?.inputSchema).toMatchObject({ type: 'object' });
        expect(sampled?.connectedAccountPurposeBindings).toEqual([{
            path: 'instance.binding.account',
            purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
        }]);
        // The Triage roles are exactly the three published ones. Binding a PostHog-native
        // read to a role would make the aggregate treat a sampled exception event as an
        // entry it can hold.
        const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions
            .find((candidate) => candidate.target.pluginId === 'happier.triage');
        expect(Object.values(contribution?.operations ?? {}))
            .not.toContain(POSTHOG_ACTION_IDS.issueEvents);
    });

    it('declares the source-native activity read without giving it a Triage role', () => {
        const actions = new Map(
            PLUGIN_MANIFEST.contributes.actions.map((action) => [action.id, action]),
        );
        const activity = actions.get(POSTHOG_ACTION_IDS.issueActivity);

        // The Activity plane is a real read with its own route, not a declared tab with
        // nothing behind it: the Action that feeds it is declared, bound to the exact
        // account, and separate from the sampled read.
        expect(activity?.inputSchema).toMatchObject({ type: 'object' });
        expect(activity?.connectedAccountPurposeBindings).toEqual([{
            path: 'instance.binding.account',
            purpose: POSTHOG_CONNECTED_ACCOUNT_PURPOSE,
        }]);
        expect(POSTHOG_ACTION_IDS.issueActivity).not.toBe(POSTHOG_ACTION_IDS.issueEvents);

        const contribution = PLUGIN_MANIFEST.contributes.targetedPluginContributions
            .find((candidate) => candidate.target.pluginId === 'happier.triage');
        expect(Object.values(contribution?.operations ?? {}))
            .not.toContain(POSTHOG_ACTION_IDS.issueActivity);
    });

    it('takes the PostHog deployment only from the declared origin-semantic field', () => {
        // This guards what is left of a deleted plugin-local OAuth module that
        // re-decided which deployments may run authorization code and which fall
        // back to a pasted key. That decision has no implementation here at all
        // any more — the canonical Connected Accounts owner keeps it — so the one
        // thing worth holding is that this plugin names no deployment of its own:
        // the route comes from an explicit `connectedAccountOrigin` field. An
        // origin field that stopped carrying that semantic, or a mode that named
        // an issuer or region itself, would put a second routing authority back
        // inside the plugin.
        //
        // It deliberately does NOT assert the exhaustive list of modes. Pinning
        // "exactly one mode" restates today's configuration rather than a
        // contract: it catches no defect, and it would make legitimately adding
        // an OAuth route later a test edit rather than a product decision. The
        // mode is therefore looked up BY ID, so a second mode neither breaks this
        // guard nor silently shifts which one it inspects.
        const descriptor = PLUGIN_MANIFEST.contributes.connectedAccountDescriptors
            .find((candidate) => candidate.id === POSTHOG_CONNECTED_ACCOUNT_PURPOSE);
        const personalApiKeyMode = descriptor?.authentication.modes
            .find((mode) => mode.id === POSTHOG_PERSONAL_API_KEY_MODE_ID);

        expect(descriptor?.authentication.defaultModeId).toBe(POSTHOG_PERSONAL_API_KEY_MODE_ID);
        expect(personalApiKeyMode?.kind).toBe('manual');
        expect(personalApiKeyMode?.configuration?.fields
            .map((field) => [field.id, field.semantic]))
            .toEqual([[POSTHOG_API_ORIGIN_FIELD_ID, 'connectedAccountOrigin']]);
    });
});
