import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import type { PluginActivationModule } from '@happier-dev/plugin-sdk';

import { parsePluginManifest, type PluginManifest } from '../manifest.js';
import * as targetedContributionsHost from '../host/targeted-contributions/index.public.js';
import type { NotificationsService } from '../notifications.js';
import type { SecretsService } from '../secrets.js';
import { createPluginTestkit } from '../testing/index.js';

// The examples must consume the current public source entry; publishing the
// separately emitted package is a staging concern.
vi.mock('@happier-dev/plugin-sdk', async () => await import('../index.js'));
vi.mock('@happier-dev/plugin-sdk/browser', async () => await import('../browser/index.js'));
vi.mock('@happier-dev/plugin-sdk/http', async () => await import('../http.js'));
vi.mock('@happier-dev/plugin-sdk/notifications', async () => await import('../notifications/index.js'));
vi.mock(
    '@happier-dev/plugin-sdk/protocol',
    async () => await import('../protocol/index.js'),
);
// The shared triage protocol is deliberately source-only in this fixture. Its
// public-like import is resolved by Vitest's source module runner; package
// publication is proved at the publisher boundary. Keep the fixture outside
// this package's TypeScript program: its authoring contract is checked by the
// dedicated feature-protocol fixture project.
vi.mock(
    '@happier-dev/triage-sources-protocol/v1',
    async () => await vi.importActual('../../fixtures/feature-protocols/triage-sources-protocol/src/v1.ts'),
);

const packageRoot = fileURLToPath(new URL('../..', import.meta.url));
const examplesRoot = join(packageRoot, 'examples');
const authoringSupportMetadataPath = join(examplesRoot, 'authoring-support.json');

type ExampleActivationEntry = Readonly<{
    manifest: PluginManifest;
    activate: PluginActivationModule['activate'];
}>;

type ExampleName =
    | 'action-contract-producer'
    | 'action-contract-consumer'
    | 'triage-source-target'
    | 'triage-source-contributor';

async function loadExample(
    name: ExampleName,
): Promise<ExampleActivationEntry> {
    const imported = await import(pathToFileURL(join(examplesRoot, name, 'src', 'index.ts')).href);
    const entry = imported as Partial<ExampleActivationEntry>;
    if (!entry.manifest || typeof entry.activate !== 'function') {
        throw new TypeError(`targeted_contribution_${name}_missing_activation`);
    }
    return entry as ExampleActivationEntry;
}

function expectTriageSourcePointSemantics(
    manifest: PluginManifest,
    pointId: string,
    descriptor: Readonly<{ kind: 'issue'; label: string }>,
): void {
    const parsed = parsePluginManifest(manifest);
    if (!parsed.ok) throw new Error(`targeted_contribution_${pointId}_manifest_invalid`);
    const point = targetedContributionsHost
        .readTargetedContributionPointSemanticRefs(manifest)
        .find((candidate) => candidate.id === pointId
            && candidate.protocol.id === 'triage-sources'
            && candidate.protocol.version === 1);
    if (!point) throw new Error(`targeted_contribution_${pointId}_semantic_ref_missing`);
    const declaration = parsed.manifest.contributes.pluginContributionPoints
        .find((candidate) => candidate.id === pointId);
    const protocol = declaration?.protocols.find((candidate) =>
        candidate.id === point.protocol.id && candidate.version === point.protocol.version);
    if (!protocol) throw new Error(`targeted_contribution_${pointId}_manifest_protocol_missing`);
    const operations = Object.keys(protocol.operations)
        .sort()
        .map((role) => ({ role }));

    const input = {
        protocol: point.protocol,
        descriptor,
        operations,
        surfaces: [{ role: 'detail', presentation: 'content' as const }],
    };
    expect(targetedContributionsHost.decodeTargetedContributionPointSemantics(point, input)).toEqual({
        ok: true,
        projection: {
            descriptor,
            operations: operations.map(({ role }) => expect.objectContaining({ role })),
            surfaces: [{ role: 'detail', presentation: 'content' }],
        },
    });
    expect(targetedContributionsHost.decodeTargetedContributionPointSemantics(point, {
        ...input,
        descriptor: { kind: 'issue' },
    })).toEqual({ ok: false, code: 'descriptor_semantic_invalid' });
}

describe('cross-plugin contribution public authoring example', () => {
    it('classifies external-author examples and advanced inference fixtures without promoting SDK capabilities', () => {
        expect(JSON.parse(readFileSync(authoringSupportMetadataPath, 'utf8'))).toEqual({
            purpose: 'Example and fixture support guidance only; this does not define SDK capability availability.',
            assets: {
                'examples/action-contract-producer': 'external-author-supported',
                'examples/action-contract-consumer': 'external-author-supported',
                'examples/triage-source-target': 'first-party-preview',
                'examples/triage-source-contributor': 'first-party-preview',
                'fixtures/authoring-inference': 'SDK-inference-fixture',
                'fixtures/external-targeted-packages': 'SDK-inference-fixture',
                'fixtures/feature-protocols/triage-sources-protocol': 'future-protocol-fixture',
            },
        });

        const operationTargetSource = readFileSync(
            join(examplesRoot, 'action-contract-producer', 'src', 'index.ts'),
            'utf8',
        );
        const operationContributorSource = readFileSync(
            join(examplesRoot, 'action-contract-consumer', 'src', 'index.ts'),
            'utf8',
        );
        const triageContributorSource = readFileSync(
            join(examplesRoot, 'triage-source-contributor', 'src', 'index.ts'),
            'utf8',
        );

        expect(operationTargetSource).toContain("from '@happier-dev/triage-sources-protocol/v1'");
        expect(operationContributorSource).toContain("from '@happier-dev/triage-sources-protocol/v1'");
        expect(operationTargetSource).not.toContain('defineContributionProtocol');
        expect(operationContributorSource).not.toContain('defineContributionProtocol');
        expect(operationTargetSource).toContain('browserTargets:');
        expect(operationTargetSource).toContain('browserActions:');
        expect(operationTargetSource).toContain('requestInterceptors:');
        expect(operationTargetSource).not.toContain("capability: 'network.intercept'");
        expect(operationTargetSource).not.toContain('hostAccess:');
        expect(operationContributorSource).toMatch(/\.contribute\(\{[\s\S]*?\bsurfaces\s*:/u);
        expect(triageContributorSource).toContain("descriptor: { kind: 'issue', label: 'Project issues' }");
        expect(triageContributorSource).toMatch(/\.contribute\(\{[\s\S]*?\bsurfaces\s*:/u);
    });

    it('uses one feature-owned protocol package in the copyable target and contributor examples', () => {
        for (const name of ['action-contract-producer', 'action-contract-consumer'] as const) {
            const source = readFileSync(join(examplesRoot, name, 'src', 'index.ts'), 'utf8');
            expect(source).toContain("from '@happier-dev/triage-sources-protocol/v1'");
            expect(source).not.toContain('defineContributionProtocol');
            expect(source).not.toContain('defineTargetedContribution');
        }
    });

    it('uses only the public SDK package surface from each independently authored package', () => {
        for (const name of ['action-contract-producer', 'action-contract-consumer'] as const) {
            const source = readFileSync(join(examplesRoot, name, 'src', 'index.ts'), 'utf8');
            const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)]
                .map(([, specifier]) => specifier)
                .sort();
            expect(imports).toEqual(name === 'action-contract-producer'
                ? [
                    '@happier-dev/plugin-sdk',
                    '@happier-dev/plugin-sdk/browser',
                    '@happier-dev/plugin-sdk/http',
                    '@happier-dev/plugin-sdk/notifications',
                    '@happier-dev/plugin-sdk/secrets',
                    '@happier-dev/triage-sources-protocol/v1',
                ]
                : [
                    '@happier-dev/plugin-sdk',
                    '@happier-dev/plugin-sdk/browser',
                    '@happier-dev/triage-sources-protocol/v1',
                ]);
        }
    });

    it('declares a target point while its independent contributor executes an arbitrary local Action without that target', async () => {
        const [target, contributor] = await Promise.all([
            loadExample('action-contract-producer'),
            loadExample('action-contract-consumer'),
        ]);

        expect(target.manifest).toMatchObject({
            id: 'examples.action-contract-producer',
            contributes: {
                requestInterceptors: [{
                    id: 'document-review-api-policy',
                    origins: ['https://api.example.test'],
                    methods: ['GET'],
                }],
                pluginContributionPoints: [{
                    id: 'document-reviewers',
                    protocols: [{
                        id: 'triage-sources',
                        version: 1,
                        descriptor: {
                            type: 'object',
                            properties: {
                                kind: {
                                    anyOf: [{ const: 'issue' }, { const: 'pull-request' }],
                                },
                                label: { type: 'string' },
                            },
                            required: ['kind', 'label'],
                            additionalProperties: false,
                        },
                        operations: {
                            inspect: {
                                required: true,
                                input: { kind: 'contributorDefined' },
                                resultSchema: {
                                    type: 'object',
                                    properties: {
                                        inspected: { anyOf: [{ const: true }, { const: false }] },
                                        entryId: { type: 'string' },
                                    },
                                    required: ['inspected', 'entryId'],
                                    additionalProperties: false,
                                },
                                action: { surface: 'plugin', dangerLevel: 'safe' },
                            },
                        },
                        surfaces: {
                            detail: {
                                required: true,
                                inputSchema: {
                                    type: 'object',
                                    properties: { entryId: { type: 'string' } },
                                    required: ['entryId'],
                                    additionalProperties: false,
                                },
                                presentation: 'content',
                            },
                        },
                    }],
                }],
            },
        });
        // `definePlugin` emits cold declaration facts only, so a target that
        // declares no host access omits the family instead of materializing
        // empty `required`/`optional` arrays; `parsePluginManifest` is the
        // sole normalizer that supplies them to host consumers.
        expect(target.manifest.hostAccess).toBeUndefined();
        expect(contributor.manifest).toMatchObject({
            id: 'examples.action-contract-consumer',
            contributes: {
                targetedPluginContributions: [{
                    id: 'local-document-reviewer',
                    target: {
                        pluginId: 'examples.action-contract-producer',
                        pointId: 'document-reviewers',
                    },
                    protocol: { id: 'triage-sources', version: 1 },
                    descriptor: { kind: 'issue', label: 'Document review' },
                    operations: { inspect: 'prepare-document-review' },
                    surfaces: {
                        detail: { renderer: 'document-review-detail' },
                    },
                }],
            },
        });
        expectTriageSourcePointSemantics(
            target.manifest,
            'document-reviewers',
            { kind: 'issue', label: 'Document review' },
        );

        // No target fixture is installed. The contributor's unrelated Action
        // remains host-dispatched and usable while its target is absent.
        const contributorTestkit = await createPluginTestkit({
            manifest: contributor.manifest,
            module: { activate: contributor.activate },
        });
        try {
            await expect(contributorTestkit.invokeAction('prepare-document-review', {
                entryId: 'review-public-contract',
            }, { surface: 'plugin' })).resolves.toEqual({
                inspected: true,
                entryId: 'review-public-contract',
            });
        } finally {
            await contributorTestkit.dispose();
        }
    });

    it('proves a public author command and tool through a registered notification channel and service invocation', async () => {
        const target = await loadExample('action-contract-producer');
        const send = vi.fn(async () => ({
            deliveries: [{
                deliveryId: 'document-review-delivery',
                channelId: 'webhook',
                status: 'accepted' as const,
                evidence: 'provider' as const,
            }],
            replayed: false,
        }));
        const notifications = Object.freeze({
            send,
            listChannels: async () => ({ items: [] }),
            listCategories: async () => ({ items: [] }),
            preferences: async (categoryId: string) => ({
                categoryId,
                enabled: true,
                channelIds: ['webhook'],
                revision: '1',
            }),
            watchPreferences: () => Object.freeze({ dispose(): void {} }),
        }) satisfies NotificationsService;

        expect(target.manifest).toMatchObject({
            contributes: {
                commands: [{
                    id: 'send-document-review-ready-command',
                    path: ['document-review', 'notify-ready'],
                    action: 'send-document-review-ready',
                }],
                tools: [{
                    id: 'send-document-review-ready-tool',
                    name: 'document_review_notify_ready',
                    action: 'send-document-review-ready',
                }],
                notifications: [{
                    id: 'document-review-ready',
                    defaultChannels: ['webhook'],
                }],
                notificationChannels: [{
                    id: 'webhook',
                    configurable: true,
                    settings: [{ id: 'endpoint' }],
                }],
            },
        });

        const testkit = await createPluginTestkit({
            manifest: target.manifest,
            module: { activate: target.activate },
            services: { notifications },
        });
        try {
            expect(testkit.registration('notificationChannels', 'webhook')).toBeDefined();
            await expect(testkit.invokeAction(
                'send-document-review-ready',
                null,
                { surface: 'cli' },
            )).resolves.toEqual({
                deliveries: [{
                    deliveryId: 'document-review-delivery',
                    channelId: 'webhook',
                    status: 'accepted',
                    evidence: 'provider',
                }],
                replayed: false,
            });
            expect(send).toHaveBeenCalledWith({
                clientRequestId: 'document-review-ready',
                categoryId: 'document-review-ready',
                title: 'Document review ready',
            }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
        } finally {
            await testkit.dispose();
        }
    });

    it('rotates a declared plugin secret through the public SecretsService without returning the value', async () => {
        const target = await loadExample('action-contract-producer');

        expect(target.manifest).toMatchObject({
            secrets: [{ id: 'document-review-webhook-token' }],
        });

        const stored = new Map<string, string>();
        let revisionCounter = 0;
        const calls: string[] = [];
        const nextRevision = (): string => {
            revisionCounter += 1;
            return `secret-r${revisionCounter}`;
        };
        let revision = 'secret-r0';
        const secrets = Object.freeze({
            async status(id: string) {
                calls.push(`status:${id}`);
                return stored.has(id)
                    ? { state: 'configured' as const, revision }
                    : { state: 'missing' as const, revision };
            },
            async get(id: string, options?: { reason?: string }) {
                calls.push(`get:${id}:${options?.reason ?? ''}`);
                const value = stored.get(id);
                if (value === undefined) throw new Error('plugin_secret_missing');
                return value;
            },
            async set(id: string, value: string, options?: { expectedRevision?: string }) {
                calls.push(`set:${id}:${options?.expectedRevision ?? 'none'}`);
                if (options?.expectedRevision !== undefined && options.expectedRevision !== revision) {
                    throw new Error('plugin_secret_revision_conflict');
                }
                stored.set(id, value);
                revision = nextRevision();
                return { revision };
            },
            async delete(id: string, options?: { expectedRevision?: string }) {
                calls.push(`delete:${id}:${options?.expectedRevision ?? 'none'}`);
                if (options?.expectedRevision !== undefined && options.expectedRevision !== revision) {
                    throw new Error('plugin_secret_revision_conflict');
                }
                stored.delete(id);
                revision = nextRevision();
                return { revision };
            },
        }) satisfies SecretsService;

        const testkit = await createPluginTestkit({
            manifest: target.manifest,
            module: { activate: target.activate },
            services: { secrets },
        });
        try {
            await expect(testkit.invokeAction(
                'rotate-document-review-webhook-token',
                { token: 'first-webhook-token' },
                { surface: 'cli' },
            )).resolves.toEqual({ state: 'configured', revision: 'secret-r1' });

            await expect(testkit.invokeAction(
                'rotate-document-review-webhook-token',
                { token: 'second-webhook-token' },
                { surface: 'cli' },
            )).resolves.toEqual({ state: 'configured', revision: 'secret-r2' });

            await expect(testkit.invokeAction(
                'rotate-document-review-webhook-token',
                {},
                { surface: 'cli' },
            )).resolves.toEqual({ state: 'missing', revision: 'secret-r3' });
        } finally {
            await testkit.dispose();
        }

        // The incumbent revision is read before every mutation, the read-back
        // uses a user-readable reason, and no result carries the value.
        expect(calls).toEqual([
            'status:document-review-webhook-token',
            'set:document-review-webhook-token:none',
            'get:document-review-webhook-token:Confirm the rotated document review webhook credential',
            'status:document-review-webhook-token',
            'set:document-review-webhook-token:secret-r1',
            'get:document-review-webhook-token:Confirm the rotated document review webhook credential',
            'status:document-review-webhook-token',
            'delete:document-review-webhook-token:secret-r2',
        ]);
        expect(stored.size).toBe(0);
    });

    it('declares Triage-shaped source detail through a target-owned descriptor and contributor-owned renderer chain', async () => {
        for (const name of ['triage-source-target', 'triage-source-contributor'] as const) {
            const source = readFileSync(join(examplesRoot, name, 'src', 'index.ts'), 'utf8');
            const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu)]
                .map(([, specifier]) => specifier)
                .sort();
            expect(imports).toEqual([
                '@happier-dev/plugin-sdk',
                '@happier-dev/plugin-sdk/browser',
                '@happier-dev/triage-sources-protocol/v1',
            ]);
        }

        const [target, contributor] = await Promise.all([
            loadExample('triage-source-target'),
            loadExample('triage-source-contributor'),
        ]);

        expect(target.manifest).toMatchObject({
            id: 'examples.triage-source-target',
            contributes: {
                pluginContributionPoints: [{
                    id: 'sources',
                    protocols: [{
                        id: 'triage-sources',
                        version: 1,
                        descriptor: {
                            type: 'object',
                            properties: {
                                kind: {
                                    anyOf: [{ const: 'issue' }, { const: 'pull-request' }],
                                },
                                label: { type: 'string' },
                            },
                            required: ['kind', 'label'],
                            additionalProperties: false,
                        },
                        surfaces: {
                            detail: {
                                required: true,
                                inputSchema: {
                                    type: 'object',
                                    properties: { entryId: { type: 'string' } },
                                    required: ['entryId'],
                                    additionalProperties: false,
                                },
                                presentation: 'content',
                            },
                        },
                    }],
                }],
            },
        });
        expect(contributor.manifest).toMatchObject({
            id: 'examples.triage-source-contributor',
            contributes: {
                targetedPluginContributions: [{
                    id: 'local-triage-source',
                    target: {
                        pluginId: 'examples.triage-source-target',
                        pointId: 'sources',
                    },
                    protocol: { id: 'triage-sources', version: 1 },
                    descriptor: { kind: 'issue', label: 'Project issues' },
                    surfaces: {
                        detail: {
                            renderer: 'triage-detail-card',
                            fallbackRenderers: ['triage-detail-fallback'],
                        },
                    },
                }],
                ui: {
                    renderers: expect.arrayContaining([
                        expect.objectContaining({ id: 'triage-detail-card' }),
                        expect.objectContaining({ id: 'triage-detail-fallback' }),
                    ]),
                },
            },
        });
        expectTriageSourcePointSemantics(
            target.manifest,
            'sources',
            { kind: 'issue', label: 'Project issues' },
        );

        const contributorTestkit = await createPluginTestkit({
            manifest: contributor.manifest,
            module: { activate: contributor.activate },
        });
        try {
            await expect(contributorTestkit.invokeAction('inspect-triage-source', {
                entryId: 'issue-42',
            }, { surface: 'plugin' })).resolves.toEqual({
                inspected: true,
                entryId: 'issue-42',
            });
        } finally {
            await contributorTestkit.dispose();
        }
    });
});
