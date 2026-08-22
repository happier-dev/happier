import { definePlugin } from '@happier-dev/plugin-sdk';
import type { ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import { describe, expect, it } from 'vitest';

import { TriageSourcesContributionProtocolV1 } from '../../v1/contribution.js';
import {
    assertTriageSourceContributionV1,
    checkTriageSourceContributionV1,
    createTriageSourceV1Fixture,
} from './index.js';

const sourceOperations = TriageSourcesContributionProtocolV1.operations;
const fixture = createTriageSourceV1Fixture();

const ACTION_IDS = {
    listInstances: 'author/discover-scopes',
    scan: 'author/walk-lanes',
    get: 'author/read-item',
    prepareReviewWorkspace: 'author/prepare-worktree',
} as const;

type MutableSourceManifest = {
    contributes: {
        actions: Array<{
            id: string;
            dangerLevel: string;
            surfaces: string[];
            inputSchema?: unknown;
            resultSchema?: unknown;
        }>;
        targetedPluginContributions: Array<{
            operations: Record<string, string>;
            protocol: { id: string; version: number };
            descriptor?: unknown;
            surfaces?: Record<string, { renderer?: string }>;
        }>;
    };
};

function declareAction(
    role: keyof typeof sourceOperations,
    title: string,
    result: ProtocolJsonValue,
) {
    const declaration = sourceOperations[role].declaration;
    return {
        title,
        // Every Triage source role is a daemon read or write: the source owns
        // the credential materialization, so the handler is a root daemon
        // handler rather than a client artifact export.
        execution: { target: 'daemon' } as const,
        scopes: ['global'] as const,
        // Declared only when the role publishes one, rather than declared as
        // `undefined`: an Action author writes the key or omits it, and the
        // manifest grammar has no "present but absent" arm.
        ...(declaration.input.kind === 'protocolDefined'
            ? { inputSchema: declaration.input.schema.jsonSchema }
            : {}),
        resultSchema: declaration.resultSchema.jsonSchema,
        surfaces: declaration.surfaces,
        dangerLevel: declaration.dangerLevel,
        run: async () => result,
    };
}

function createExternalSourceManifest() {
    return definePlugin({
        id: 'example.forge-source',
        version: '1.0.0',
        actions: {
            [ACTION_IDS.listInstances]: declareAction(
                'listInstances',
                'Discover forge scopes',
                fixture.listInstancesResult,
            ),
            [ACTION_IDS.scan]: declareAction('scan', 'Walk forge lanes', fixture.scanResult),
            [ACTION_IDS.get]: declareAction('get', 'Read one forge item', fixture.getResult),
            [ACTION_IDS.prepareReviewWorkspace]: declareAction(
                'prepareReviewWorkspace',
                'Prepare review worktree',
                fixture.prepareReviewWorkspaceResult,
            ),
        },
        ui: {
            renderers: [{
                id: 'forge-detail',
                kind: 'declarative',
                root: { kind: 'text', text: 'Forge detail' },
            }],
        },
        contributesTo: {
            'happier.triage': {
                sources: {
                    'example-forge': TriageSourcesContributionProtocolV1.contribute({
                        descriptor: fixture.descriptor,
                        operations: {
                            listInstances: sourceOperations.listInstances.bind(ACTION_IDS.listInstances),
                            scan: sourceOperations.scan.bind(ACTION_IDS.scan),
                            get: sourceOperations.get.bind(ACTION_IDS.get),
                            prepareReviewWorkspace: sourceOperations.prepareReviewWorkspace
                                .bind(ACTION_IDS.prepareReviewWorkspace),
                        },
                        surfaces: { detail: { renderer: 'forge-detail' } },
                    }),
                },
            },
        },
    }).manifest;
}

function mutableManifest(): MutableSourceManifest {
    return JSON.parse(JSON.stringify(createExternalSourceManifest())) as MutableSourceManifest;
}

describe('Triage sources V1 contribution conformance', () => {
    it('accepts a public, external-style source with arbitrary local Action ids', () => {
        expect(() => assertTriageSourceContributionV1(createExternalSourceManifest())).not.toThrow();
    });

    it('accepts a source that omits the optional review-workspace role', () => {
        const manifest = mutableManifest();
        const contribution = manifest.contributes.targetedPluginContributions[0]!;
        delete contribution.operations.prepareReviewWorkspace;
        manifest.contributes.actions = manifest.contributes.actions
            .filter((action) => action.id !== ACTION_IDS.prepareReviewWorkspace);

        expect(checkTriageSourceContributionV1(manifest).ok).toBe(true);
    });

    it('rejects a source that omits a required read role', () => {
        const manifest = mutableManifest();
        delete manifest.contributes.targetedPluginContributions[0]!.operations.scan;

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain("'scan'");
    });

    it('rejects a review-workspace role bound to a safe Action', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions
            .find((candidate) => candidate.id === ACTION_IDS.prepareReviewWorkspace)!;
        action.dangerLevel = 'safe';

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('danger level');
    });

    it('rejects a role bound to an Action declaring a different input schema', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions
            .find((candidate) => candidate.id === ACTION_IDS.get)!;
        action.inputSchema = { type: 'object' };

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('input schema');
    });

    /**
     * `CONTRACT.md` §9 publishes one success member: the parsed manifest. The
     * checked contribution is the input the caller already holds, and a second
     * published member is a permanent name for a value nobody asked for.
     */
    it('returns only the parsed manifest on its success arm', () => {
        const result = checkTriageSourceContributionV1(createExternalSourceManifest());

        expect(Object.keys(result).sort()).toEqual(['manifest', 'ok']);
    });

    it('rejects a descriptor with duplicate kind ids', () => {
        const manifest = mutableManifest();
        const contribution = manifest.contributes.targetedPluginContributions[0]!;
        contribution.descriptor = {
            ...fixture.descriptor,
            kinds: [
                { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
                { id: 'pull-request', workflowSubject: 'issue', displayName: 'Issue' },
            ],
        };

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('unique');
    });

    it('rejects a source that declares no descriptor at all', () => {
        const manifest = mutableManifest();
        delete manifest.contributes.targetedPluginContributions[0]!.descriptor;

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('descriptor');
    });

    it('rejects a source that binds no detail renderer', () => {
        const manifest = mutableManifest();
        delete manifest.contributes.targetedPluginContributions[0]!.surfaces;

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain("'detail' surface binding");
    });

    it('rejects a manifest with no Triage sources contribution', () => {
        const manifest = mutableManifest();
        manifest.contributes.targetedPluginContributions = [];

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('exactly one');
    });

    it('rejects a manifest declaring two Triage sources contributions', () => {
        const manifest = mutableManifest();
        const contribution = manifest.contributes.targetedPluginContributions[0]!;
        // The canonical parser already rejects a duplicated local id, so the
        // reachable case is a second, differently named source contribution
        // aimed at the same target point.
        const second = JSON.parse(JSON.stringify(contribution)) as typeof contribution & { id?: string };
        second.id = 'example-forge-mirror';
        manifest.contributes.targetedPluginContributions.push(second);

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('exactly one');
    });

    it('rejects a contribution declaring a different protocol wire epoch', () => {
        const manifest = mutableManifest();
        manifest.contributes.targetedPluginContributions[0]!.protocol.version = 2;

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('version 1');
    });

    it('rejects a contribution declaring a different protocol id', () => {
        const manifest = mutableManifest();
        manifest.contributes.targetedPluginContributions[0]!.protocol.id = 'happier.triage/other';

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('happier.triage/sources');
    });

    it('rejects a source role this protocol does not define', () => {
        const manifest = mutableManifest();
        const contribution = manifest.contributes.targetedPluginContributions[0]!;
        contribution.operations.rescan = ACTION_IDS.scan;

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain("'rescan'");
    });

    it('rejects a role bound to an Action that is not declared at all', () => {
        const manifest = mutableManifest();
        manifest.contributes.targetedPluginContributions[0]!.operations.get = 'author/absent';

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('undeclared Action');
    });

    it('rejects a role bound to an Action declaring a different result schema', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions
            .find((candidate) => candidate.id === ACTION_IDS.scan)!;
        action.resultSchema = { type: 'object' };

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('result schema');
    });

    it('rejects a role bound to an Action that omits the required surface', () => {
        const manifest = mutableManifest();
        const action = manifest.contributes.actions
            .find((candidate) => candidate.id === ACTION_IDS.get)!;
        // A non-empty but different surface: the canonical parser accepts the
        // declaration, so only the Triage role contract can reject it.
        action.surfaces = ['cli'];

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain('incompatible surface');
    });

    it('rejects a surface role this protocol does not define', () => {
        const manifest = mutableManifest();
        const contribution = manifest.contributes.targetedPluginContributions[0]!;
        contribution.surfaces = {
            ...contribution.surfaces,
            sidebar: { renderer: 'forge-detail' },
        };

        const result = checkTriageSourceContributionV1(manifest);
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.errors.join(' ')).toContain("'sidebar'");
    });
});

describe('Triage sources V1 fixture', () => {
    it('produces every public value by parsing through its own published schema', () => {
        expect(fixture.descriptor.kinds.map((kind) => kind.id))
            .toEqual(['pull-request', 'issue']);
        expect(fixture.scanResult.kind).toBe('complete');
        expect(fixture.getResult.kind).toBe('present');
        expect(fixture.detailInput.linkedSessions).toHaveLength(1);
        expect(fixture.administrationResult).toEqual({
            kind: 'active',
            sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
        });
    });
});
