import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';
import { DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1 } from '@happier-dev/protocol';
import {
    PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1,
    PLUGIN_UI_HOST_API_VERSION_V1,
    PLUGIN_UI_HOST_METHODS_V1,
    PluginUiHostApiWireEnvelopeV1Schema,
    PluginUiTargetedContributionsV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
    PluginUiHostApiWireEnvelopeV1Schema as PluginUiHostApiClientWireEnvelopeV1Schema,
} from '@happier-dev/protocol/plugins/ui/client';

import type { PluginErrorData } from '../errors.js';
import type { PluginDiagnosticData } from '../diagnostics.js';
import { definePlugin } from '../definePlugin.js';
import type { ComposerContentHandleV1, ComposerSnapshotV1 } from '../ui/hostApi.js';
import {
    createPluginUiTestkit,
    createSurfaceContextFixture,
    PluginUiSemanticRoleSchema,
    readPluginUiTestkitTargetedSurfaceAdmission,
    SURFACE_CONTEXT_THEME_FIXTURE,
    type PluginUiTestkitReadOpenableContentInput,
    type PluginUiSemanticAdapterNode,
    type PluginUiSemanticSurfaceAdapter,
    type PluginUiSemanticSurfaceMount,
    type PluginUiTestkitMountAvailability,
    type PluginUiTestkitStatOpenableContentInput,
} from './index.js';

type AuthorSurface = Readonly<{ kind: 'author-surface' }>;
type SemanticMountInput = Parameters<PluginUiSemanticSurfaceAdapter<AuthorSurface>['mount']>[0];
type SemanticContext = SemanticMountInput['context'];
type SemanticInvokeInput = Parameters<PluginUiSemanticSurfaceMount['invoke']>[0];

const identity = {
    pluginId: 'com.acme.fixture',
    pluginVersion: '1.0.0',
    viewId: 'review',
    generation: 'generation-1',
    sessionId: 'session-1',
} as const;

const initialSurface = createSurfaceContextFixture();
const firstDigest = `sha256:${'1'.repeat(64)}`;
const secondDigest = `sha256:${'2'.repeat(64)}`;

function targetedSurfaceAdmissionFixture(input: Readonly<{
    targetGeneration?: string;
    contributorPluginId?: string;
    contributorGeneration?: string;
}> = {}) {
    const targetGeneration = input.targetGeneration ?? 'target-generation-a';
    const contributorPluginId = input.contributorPluginId ?? 'com.acme.external-contributor';
    const contributorGeneration = input.contributorGeneration ?? 'contributor-generation-a';
    const point = { pointId: 'sources', protocol: { id: 'review-sources', version: 1 } } as const;
    const contributor = {
        pluginId: contributorPluginId,
        contributionId: 'review-source',
        immutableGenerationId: contributorGeneration,
    } as const;
    return {
        target: { pluginId: 'com.acme.target', immutableGenerationId: targetGeneration },
        surface: {
            point,
            contributor,
            role: 'detail',
            presentation: 'content',
        },
        mount: {
            kind: 'targetedSurface',
            target: { pluginId: 'com.acme.target', immutableGenerationId: targetGeneration },
            point,
            contributor,
            role: 'detail',
            presentation: 'content',
            inputSchema: {
                type: 'object',
                properties: { entryId: { type: 'string', minLength: 1 } },
                required: ['entryId'],
                additionalProperties: false,
            },
            rendererChain: [{ pluginId: contributorPluginId, localId: 'review-detail' }],
            selectedRenderer: {
                identity: { pluginId: contributorPluginId, localId: 'review-detail' },
                renderer: {
                    kind: 'declarative',
                    contributionId: 'review-detail',
                    model: { visible: true },
                },
                availability: { state: 'available', reason: 'available', diagnostics: [] },
            },
            executionOrigin: {
                serverIdentityId: 'srv_external',
                materializationRef: {
                    machineId: 'machine-external',
                    materializationId: `materialization-${contributorGeneration}`,
                    pluginId: contributorPluginId,
                },
            },
            resourceCapability: { readable: true, dynamic: true },
            contributorTargetedContributions: {
                target: { pluginId: contributorPluginId, immutableGenerationId: contributorGeneration },
                points: [],
            },
        },
    } as const;
}

function targetedSurfaceContributorManifest(
    pluginId: string,
    rendererId = 'review-detail',
    text = 'External review detail',
) {
    return definePlugin({
        id: pluginId,
        version: '1.0.0',
        ui: {
            renderers: [{
                id: rendererId,
                kind: 'declarative',
                root: { kind: 'text', text },
            }],
        },
    }).manifest;
}

function createSemanticAdapter() {
    const mounts: SemanticMountInput[] = [];
    const updates: SemanticContext[] = [];
    const invokes: SemanticInvokeInput[] = [];
    let revision = 1;
    let disposals = 0;

    const adapter: PluginUiSemanticSurfaceAdapter<AuthorSurface> = {
        async mount(input) {
            mounts.push(input);
            return {
                async snapshot() {
                    return {
                        revision,
                        nodes: [{
                            handle: 'save-review',
                            role: 'button',
                            name: 'Save review',
                            state: { disabled: false },
                            actions: ['press'] as const,
                        }],
                    };
                },
                async update(context) {
                    updates.push(context);
                    revision += 1;
                },
                async invoke(input) {
                    invokes.push(input);
                },
                async dispose() {
                    disposals += 1;
                },
            };
        },
    };

    return Object.freeze({
        adapter,
        mounts,
        updates,
        invokes,
        advanceRevision: () => { revision += 1; },
        disposalCount: () => disposals,
    });
}

function createMutableSemanticAdapter(initialNodes: readonly PluginUiSemanticAdapterNode[]) {
    let nodes = initialNodes;
    const invokes: SemanticInvokeInput[] = [];
    const adapter: PluginUiSemanticSurfaceAdapter<AuthorSurface> = {
        async mount() {
            return {
                async snapshot() {
                    return { revision: 1, nodes };
                },
                async update() {},
                async invoke(input) {
                    invokes.push(input);
                },
                async dispose() {},
            };
        },
    };
    return Object.freeze({
        adapter,
        invokes,
        setNodes(next: readonly PluginUiSemanticAdapterNode[]) {
            nodes = next;
        },
    });
}

describe('readPluginUiTestkitTargetedSurfaceAdmission', () => {
    it('projects one exact strict cold admission and changes only its lifecycle key across generations', () => {
        const first = targetedSurfaceAdmissionFixture();
        const admission = readPluginUiTestkitTargetedSurfaceAdmission({
            mounts: [first.mount],
            target: first.target,
            surface: first.surface,
            launchInput: { entryId: 'review-42' },
            instanceKey: 'review-42',
            contributorManifest: targetedSurfaceContributorManifest(first.surface.contributor.pluginId),
        });

        expect(admission).toEqual(expect.objectContaining({
            target: first.target,
            contributor: first.surface.contributor,
            input: { entryId: 'review-42' },
            content: { kind: 'declarativeText', text: 'External review detail' },
        }));
        for (const privateName of [
            'rendererChain',
            'executionOrigin',
            'resourceCapability',
            'contributorTargetedContributions',
            'artifactProjection',
            'selectedRenderer',
            'trustTier',
            'source',
        ]) {
            expect(admission).not.toHaveProperty(privateName);
        }

        const replacement = targetedSurfaceAdmissionFixture({
            targetGeneration: 'target-generation-b',
            contributorGeneration: 'contributor-generation-b',
        });
        const replacementAdmission = readPluginUiTestkitTargetedSurfaceAdmission({
            mounts: [replacement.mount],
            target: replacement.target,
            surface: replacement.surface,
            launchInput: { entryId: 'review-42' },
            instanceKey: 'review-42',
            contributorManifest: targetedSurfaceContributorManifest(replacement.surface.contributor.pluginId),
        });
        expect(replacementAdmission?.instanceKey).toBe(admission?.instanceKey);
        expect(replacementAdmission?.key).not.toBe(admission?.key);
    });

    it('fails closed on stale, ambiguous, unavailable, invalid-input, and invented source-specific admission', () => {
        const fixture = targetedSurfaceAdmissionFixture();
        const read = (overrides: Readonly<{
            mounts?: unknown;
            target?: unknown;
            launchInput?: unknown;
        }> = {}) => readPluginUiTestkitTargetedSurfaceAdmission({
            mounts: overrides.mounts ?? [fixture.mount],
            target: (overrides.target ?? fixture.target) as typeof fixture.target,
            surface: fixture.surface,
            launchInput: overrides.launchInput ?? { entryId: 'review-42' },
            contributorManifest: targetedSurfaceContributorManifest(fixture.surface.contributor.pluginId),
        });

        expect(read({ target: { ...fixture.target, immutableGenerationId: 'stale-target' } })).toBeNull();
        expect(read({ mounts: [fixture.mount, fixture.mount] })).toBeNull();
        expect(read({ launchInput: { entryId: '' } })).toBeNull();
        expect(read({
            mounts: [{
                ...fixture.mount,
                selectedRenderer: {
                    ...fixture.mount.selectedRenderer,
                    availability: { state: 'fallback', reason: 'not-ready', diagnostics: [] },
                },
            }],
        })).toBeNull();
        expect(read({ mounts: [{ ...fixture.mount, source: 'bundled' }] })).toBeNull();
        expect(read({ mounts: [{ ...fixture.mount, trustTier: 'firstParty' }] })).toBeNull();
        expect(readPluginUiTestkitTargetedSurfaceAdmission({
            mounts: [fixture.mount],
            target: fixture.target,
            surface: fixture.surface,
            launchInput: { entryId: 'review-42' },
            contributorManifest: targetedSurfaceContributorManifest(
                fixture.surface.contributor.pluginId,
                'renamed-review-detail',
            ),
        })).toBeNull();
    });

    it('admits built-in-shaped and external contributor identities through the same source-neutral contract', () => {
        const readFixture = (fixture: ReturnType<typeof targetedSurfaceAdmissionFixture>) => (
            readPluginUiTestkitTargetedSurfaceAdmission({
                mounts: [fixture.mount],
                target: fixture.target,
                surface: fixture.surface,
                launchInput: { entryId: 'review-42' },
                contributorManifest: targetedSurfaceContributorManifest(fixture.surface.contributor.pluginId),
            })
        );
        const bundled = readFixture(targetedSurfaceAdmissionFixture({
            contributorPluginId: 'happier.bundled-contributor',
        }));
        const external = readFixture(targetedSurfaceAdmissionFixture({
            contributorPluginId: 'com.acme.external-contributor',
        }));

        expect(bundled).not.toBeNull();
        expect(external).not.toBeNull();
        expect(Object.keys(bundled ?? {}).sort()).toEqual(Object.keys(external ?? {}).sort());
    });
});

describe('createPluginUiTestkit', () => {
    it('keeps public UI testkit option signatures independently nameable', async () => {
        const sourceText = await readFile(new URL('./uiHost.ts', import.meta.url), 'utf8');
        const sourceFile = ts.createSourceFile(
            'uiHost.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exportedAlias = (name: string): ts.TypeAliasDeclaration => {
            const declaration = sourceFile.statements.find((statement) => (
                ts.isTypeAliasDeclaration(statement) && statement.name.text === name
            ));
            if (!declaration || !ts.isTypeAliasDeclaration(declaration)) {
                throw new Error(`Expected ${name} to be declared as a type alias`);
            }
            return declaration;
        };

        expect(exportedAlias('PluginUiTestkitOptions').type.getText(sourceFile))
            .not.toContain('PluginUiTestkitOptionsBase');
        expect(exportedAlias('PluginUiTestkitMountOptions').type.getText(sourceFile))
            .not.toContain('PluginUiTestkitOptionsBase');
        expect(sourceText).not.toContain('PluginUiTestkitFactory');
    });

    it('requires every canonical Host API method to have an explicit fixture handler policy', async () => {
        const sourceText = await readFile(new URL('./uiHost.ts', import.meta.url), 'utf8');
        const sourceFile = ts.createSourceFile(
            'uiHost.ts',
            sourceText,
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        let policy: ts.VariableDeclaration | undefined;
        const findPolicy = (node: ts.Node): void => {
            if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === 'hostMethodPolicies') {
                policy = node;
            }
            ts.forEachChild(node, findPolicy);
        };
        findPolicy(sourceFile);

        expect(policy).toBeDefined();
        if (!policy?.initializer || !ts.isSatisfiesExpression(policy.initializer)) {
            throw new Error('Expected hostMethodPolicies to use a typed exhaustive census.');
        }
        const policyObject = ts.isAsExpression(policy.initializer.expression)
            ? policy.initializer.expression.expression
            : policy.initializer.expression;
        if (!ts.isObjectLiteralExpression(policyObject)) {
            throw new Error('Expected hostMethodPolicies to be an object literal.');
        }

        expect(policy.initializer.type.getText(sourceFile))
            .toBe('Readonly<Record<(typeof PLUGIN_UI_HOST_METHODS_V1)[number], PluginUiTestkitHostMethodPolicy>>');
        expect(policyObject.properties.map((property) => property.name?.getText(sourceFile)))
            .toEqual([...PLUGIN_UI_HOST_METHODS_V1]);

        const probeFileName = 'fixture-host-method-policy-probe.ts';
        const probeSource = [
            'type Readonly<T> = { readonly [TKey in keyof T]: T[TKey] };',
            'type Record<TKeys extends string, TValue> = { [TKey in TKeys]: TValue };',
            "type CanonicalMethod = 'context' | 'newCanonicalMethod';",
            "type FixtureHostMethodPolicy = 'fixture' | 'executeAction';",
            "const policies = { context: 'fixture' } satisfies Readonly<Record<CanonicalMethod, FixtureHostMethodPolicy>>;",
        ].join('\n');
        const options: ts.CompilerOptions = { noEmit: true, noLib: true, strict: true };
        const compilerHost = ts.createCompilerHost(options);
        compilerHost.getSourceFile = (fileName, languageVersion) => (
            fileName === probeFileName
                ? ts.createSourceFile(fileName, probeSource, languageVersion, true, ts.ScriptKind.TS)
                : undefined
        );
        compilerHost.fileExists = (fileName) => fileName === probeFileName;
        compilerHost.readFile = (fileName) => fileName === probeFileName ? probeSource : undefined;
        const diagnostics = ts.createProgram({
            rootNames: [probeFileName],
            options,
            host: compilerHost,
        }).getSemanticDiagnostics();

        expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')))
            .toEqual(expect.arrayContaining([expect.stringContaining('newCanonicalMethod')]));
    });

    it('accepts the browser-safe client negotiation envelope at the fixture ingress', () => {
        const clientEnvelope = PluginUiHostApiClientWireEnvelopeV1Schema.parse({
            wireVersion: PLUGIN_UI_HOST_API_WIRE_VERSION_V1,
            kind: 'negotiate',
            identity,
            apiRange: PLUGIN_UI_HOST_API_COMPATIBLE_RANGE_V1,
        });

        expect(PluginUiHostApiWireEnvelopeV1Schema.safeParse(clientEnvelope).success).toBe(true);
    });

    it('accepts every Protocol-compatible host API range and refuses an incompatible major', async () => {
        for (const apiRange of ['^1', '>=1.0.0 <2.0.0']) {
            const fixture = await createPluginUiTestkit({
                identity,
                surface: { kind: 'author-surface' },
                surfaceContext: initialSurface,
                adapter: createSemanticAdapter().adapter,
                apiRange,
            });
            expect(fixture.context.hostApi.version().apiVersion).toBe(PLUGIN_UI_HOST_API_VERSION_V1);
            await fixture.dispose();
        }

        await expect(createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            apiRange: '^2.0.0',
        })).rejects.toMatchObject({ code: 'incompatible_api_version' });
    });

    it('keeps parsed openable-content handler requests normalized at the public boundary', () => {
        expectTypeOf<PluginUiTestkitReadOpenableContentInput['request']['maxBytes']>()
            .toEqualTypeOf<number>();
    });

    it('publishes the one strict surface-context fixture through the testing boundary', () => {
        expect(createSurfaceContextFixture().theme).toBe(SURFACE_CONTEXT_THEME_FIXTURE);
    });

    it('returns an exact host-provided mount refusal without invoking the semantic adapter', async () => {
        const refusals: readonly PluginUiTestkitMountAvailability[] = [
            {
                state: 'fallback',
                reason: 'destination_platform_unavailable',
                diagnostics: ['destination_platform_unavailable'],
            },
            {
                state: 'blocked',
                reason: 'compatibility_feature_disabled',
                diagnostics: ['compatibility_feature_disabled'],
            },
            {
                state: 'fallback',
                reason: 'renderer_unavailable',
                diagnostics: ['renderer_unavailable'],
            },
            {
                state: 'fallback',
                reason: 'hosted_web_frame_adapter_unavailable',
                diagnostics: ['hosted_web_frame_adapter_unavailable'],
            },
        ];

        for (const availability of refusals) {
            const semantic = createSemanticAdapter();
            const result = await createPluginUiTestkit({
                identity,
                surface: { kind: 'author-surface' },
                surfaceContext: initialSurface,
                adapter: semantic.adapter,
                mount: { availability },
            });

            expect(result).toEqual({ kind: 'refused', availability });
            expect(semantic.mounts).toEqual([]);
        }
    });

    it('returns a mounted result only when the supplied host availability permits it', async () => {
        const semantic = createSemanticAdapter();
        const result = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
            mount: {
                availability: {
                    state: 'available',
                    reason: 'renderer_available',
                    diagnostics: ['renderer_available'],
                },
            },
        });

        expect(result.kind).toBe('mounted');
        if (result.kind !== 'mounted') throw new Error('The available host fact must admit the semantic surface.');
        expect(result.fixture.context).toMatchObject({ surface: initialSurface });
        expect(semantic.mounts).toHaveLength(1);
        await result.fixture.dispose();
    });

    it('rejects malformed availability facts instead of treating a fixture-local refusal as host admission', async () => {
        const semantic = createSemanticAdapter();

        await expect(createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
            mount: {
                availability: {
                    state: 'fallback',
                    reason: '',
                    diagnostics: [],
                },
            },
        })).rejects.toThrow();

        expect(semantic.mounts).toEqual([]);
    });

    it('projects the one initial Host API 1.0.0 fixture with an exact empty target snapshot', async () => {
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            handlers: { selectActionInput: async () => ({ kind: 'cancelled' }) },
        });
        expect(fixture.context.hostApi.version().apiVersion).toBe(PLUGIN_UI_HOST_API_VERSION_V1);
        expect(fixture.context.hostApi.version().methods).toContain('selectActionInput');
        const targetedContributions = PluginUiTargetedContributionsV1Schema.parse(
            createSurfaceContextFixture().targetedContributions,
        );
        expect(targetedContributions.target).toEqual({
            pluginId: 'com.acme.fixture',
            immutableGenerationId: 'target-generation-a',
        });
        expect(targetedContributions.points).toEqual([]);
        await fixture.dispose();
    });

    it('routes every installed Composer Host API method through the canonical testkit transport', async () => {
        const composer = { kind: 'session', sessionId: 'session-1' } as const;
        const mediaHandle: ComposerContentHandleV1 = {
            v: 1,
            id: 'staged-image-1',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            owner: { pluginId: 'com.acme.fixture', localId: 'image' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'hero.png',
            sizeBytes: 2,
            sha256: 'a'.repeat(64),
        };
        const snapshot: ComposerSnapshotV1 = {
            revision: 3,
            ref: composer,
            text: 'Investigate the failure',
            references: [],
            attachments: [],
            layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
        };
        const calls: string[] = [];
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            handlers: {
                activeComposer: async ({ signal }) => {
                    expect(signal.aborted).toBe(false);
                    calls.push('active');
                    return composer;
                },
                readComposer: async ({ ref, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(ref).toEqual(composer);
                    calls.push('read');
                    return { status: 'ready', snapshot };
                },
                watchComposer: async ({ ref, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(ref).toEqual(composer);
                    calls.push('watch');
                },
                applyComposer: async ({ ref, transaction, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(ref).toEqual(composer);
                    expect(transaction).toEqual({
                        expectedRevision: 3,
                        operations: [{ kind: 'text.clear' }],
                    });
                    calls.push('apply');
                    return { status: 'applied', revision: 4 };
                },
                focusComposer: async ({ ref, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(ref).toEqual(composer);
                    calls.push('focus');
                    return { status: 'focused' };
                },
                setComposerDecorations: async ({ ref, key, decorations, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(ref).toEqual(composer);
                    expect(key).toBe('acme.diagnostics');
                    expect(decorations).toBeNull();
                    calls.push('decorations');
                    return { status: 'set' };
                },
                acquireComposerInputLock: async ({ ref, request, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(ref).toEqual(composer);
                    expect(request).toEqual({ reason: 'Checking the selected issue', mode: 'submit' });
                    calls.push('lock');
                },
                pickComposerMedia: async ({ ref, request, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(ref).toEqual(composer);
                    expect(request).toEqual({ attachmentLocalId: 'image', kinds: ['image'] });
                    calls.push('pick');
                    return mediaHandle;
                },
                inspectComposerContent: async ({ handle, request, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(handle).toEqual(mediaHandle);
                    expect(request).toEqual({ offset: 0, maxBytes: 2 });
                    calls.push('inspect');
                    return { offset: 0, bytes: new Uint8Array([0x89, 0x50]), eof: true };
                },
                releaseComposerContent: async ({ handle, signal }) => {
                    expect(signal.aborted).toBe(false);
                    expect(handle).toEqual(mediaHandle);
                    calls.push('release');
                },
            },
        });

        expect(fixture.context.hostApi.version().methods).toEqual(expect.arrayContaining([
            'activeComposer',
            'readComposer',
            'watchComposer',
            'applyComposer',
            'focusComposer',
            'setComposerDecorations',
            'acquireComposerInputLock',
            'pickComposerMedia',
            'inspectComposerContent',
            'releaseComposerContent',
        ]));
        await expect(fixture.context.hostApi.activeComposer()).resolves.toEqual(composer);
        await expect(fixture.context.hostApi.readComposer(composer)).resolves.toEqual({ status: 'ready', snapshot });
        const observation = await fixture.context.hostApi.watchComposer(composer, () => undefined);
        await expect(fixture.context.hostApi.applyComposer(composer, {
            expectedRevision: 3,
            operations: [{ kind: 'text.clear' }],
        })).resolves.toEqual({ status: 'applied', revision: 4 });
        await expect(fixture.context.hostApi.focusComposer(composer)).resolves.toEqual({ status: 'focused' });
        await expect(fixture.context.hostApi.setComposerDecorations(
            composer,
            'acme.diagnostics',
            null,
        )).resolves.toEqual({ status: 'set' });
        const lock = await fixture.context.hostApi.acquireComposerInputLock(composer, {
            reason: 'Checking the selected issue',
            mode: 'submit',
        });
        await expect(fixture.context.hostApi.pickComposerMedia(composer, {
            attachmentLocalId: 'image',
            kinds: ['image'],
        })).resolves.toEqual(mediaHandle);
        await expect(fixture.context.hostApi.inspectComposerContent(mediaHandle, {
            offset: 0,
            maxBytes: 2,
        })).resolves.toEqual({ offset: 0, bytes: new Uint8Array([0x89, 0x50]), eof: true });
        await expect(fixture.context.hostApi.releaseComposerContent(mediaHandle)).resolves.toBeUndefined();

        observation.dispose();
        lock.dispose();
        expect(calls).toEqual([
            'active',
            'read',
            'watch',
            'apply',
            'focus',
            'decorations',
            'lock',
            'pick',
            'inspect',
            'release',
        ]);
        await fixture.dispose();
    });

    it('delivers schema-checked Composer snapshots and retires every established Composer resource', async () => {
        const composer = { kind: 'session', sessionId: 'session-lifecycle' } as const;
        const initialSnapshot: ComposerSnapshotV1 = {
            revision: 1,
            ref: composer,
            text: 'Initial draft',
            references: [],
            attachments: [],
            layout: 'wrap',
            capabilities: { text: true, references: true, attachments: true, submit: true },
            state: { focused: false, editable: true, submittable: true, submitting: false, running: false },
        };
        const updatedSnapshot: ComposerSnapshotV1 = {
            ...initialSnapshot,
            revision: 2,
            text: 'Updated draft',
        };
        const releases: string[] = [];
        let watchSignal: AbortSignal | undefined;
        let lockSignal: AbortSignal | undefined;
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            handlers: {
                watchComposer: ({ signal }) => {
                    watchSignal = signal;
                    return { dispose: () => { releases.push('watch'); } };
                },
                acquireComposerInputLock: ({ signal }) => {
                    lockSignal = signal;
                    return { dispose: () => { releases.push('lock'); } };
                },
            },
        });
        const observedRevisions: number[] = [];
        const observation = await fixture.context.hostApi.watchComposer(composer, (snapshot) => {
            observedRevisions.push(snapshot.revision);
        });
        const lock = await fixture.context.hostApi.acquireComposerInputLock(composer, {
            reason: 'Keep the current draft stable',
            mode: 'submit',
        });

        fixture.emitComposerSnapshot(composer, updatedSnapshot);
        expect(observedRevisions).toEqual([2]);
        expect(() => fixture.emitComposerSnapshot(composer, {
            ...updatedSnapshot,
            revision: -1,
        })).toThrow();

        observation.dispose();
        expect(watchSignal?.aborted).toBe(true);
        expect(releases).toEqual(['watch']);
        fixture.emitComposerSnapshot(composer, {
            ...updatedSnapshot,
            revision: 3,
        });
        expect(observedRevisions).toEqual([2]);

        await fixture.retire('composer-lifecycle-replaced');
        expect(lockSignal?.aborted).toBe(true);
        expect(releases).toEqual(['watch', 'lock']);
        lock.dispose();
    });

    it('cancels a Composer resource before a late establishment can leak its release', async () => {
        const composer = { kind: 'session', sessionId: 'session-cancelled-observation' } as const;
        let handlerStarted!: () => void;
        const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
        let releaseObserved!: () => void;
        const released = new Promise<void>((resolve) => { releaseObserved = resolve; });
        let observedSignal: AbortSignal | undefined;
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            handlers: {
                watchComposer: ({ signal }) => {
                    observedSignal = signal;
                    handlerStarted();
                    return new Promise((resolve) => {
                        signal.addEventListener('abort', () => {
                            resolve({ dispose: releaseObserved });
                        }, { once: true });
                    });
                },
            },
        });
        const cancellation = new AbortController();
        const pending = fixture.context.hostApi.watchComposer(composer, () => undefined, {
            signal: cancellation.signal,
        });
        await started;
        cancellation.abort();

        await expect(pending).rejects.toMatchObject({ code: 'aborted' });
        await released;
        expect(observedSignal?.aborted).toBe(true);
        await fixture.dispose();
    });

    it('preserves one strict host-selected portable selection through the public testkit', async () => {
        const operation = {
            point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
            contributor: {
                pluginId: 'com.acme.provider',
                contributionId: 'github-connection',
                immutableGenerationId: 'provider-generation-a',
            },
            role: 'setup',
            action: { pluginId: 'com.acme.provider', localId: 'connection/prepare-v1' },
        } as const;
        const targeted = PluginUiTargetedContributionsV1Schema.parse(initialSurface.targetedContributions);
        const result = {
            kind: 'submitted' as const,
            action: operation.action,
            input: { repository: 'happier-dev/happier' },
            selection: {
                target: targeted.target,
                point: operation.point,
                contributor: operation.contributor,
            },
            connectedAccount: { kind: 'none' as const },
        };
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            handlers: {
                selectActionInput: async () => result,
            },
        });

        await expect(fixture.context.hostApi.selectActionInput({ operation })).resolves.toEqual(result);
        await fixture.dispose();
    });

    it('projects the literal no-invoke Session draft through the public testkit', async () => {
        const serverStartDraft = {
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            directory: '/workspace',
            agentTarget: {
                kind: 'agent' as const,
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
        };
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            handlers: {
                selectActionInput: async () => ({
                    kind: 'serverStartDraft' as const,
                    draft: serverStartDraft,
                }),
            },
        });

        const selected = await fixture.context.hostApi.selectActionInput({
            hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
            draft: { directory: '/workspace' },
        });
        expect(selected).toEqual({ kind: 'serverStartDraft', draft: serverStartDraft });
        expect('action' in selected).toBe(false);
        await fixture.dispose();
    });

    it('does not advertise semantic roles that no public producer can emit', () => {
        expect(PluginUiSemanticRoleSchema.safeParse('option').success).toBe(true);
        expect(PluginUiSemanticRoleSchema.safeParse('form').success).toBe(true);
        expect(PluginUiSemanticRoleSchema.safeParse('radiogroup').success).toBe(true);
        expect(PluginUiSemanticRoleSchema.safeParse('separator').success).toBe(true);
        expect(PluginUiSemanticRoleSchema.safeParse('tabpanel').success).toBe(true);
        expect(PluginUiSemanticRoleSchema.safeParse('combobox').success).toBe(false);
        expect(PluginUiSemanticRoleSchema.safeParse('text').success).toBe(false);
    });

    it('mounts a strict public context and routes real public host operations through supplied boundaries', async () => {
        const semantic = createSemanticAdapter();
        let resource = {
            contentType: 'application/json',
            digest: firstDigest,
            bytes: new Uint8Array([1, 2, 3]),
        };
        const calls: string[] = [];
        let resolveDiagnostic!: () => void;
        let deliveredDiagnostic: PluginDiagnosticData | undefined;
        const diagnosticDelivered = new Promise<void>((resolve) => { resolveDiagnostic = resolve; });

        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            launchInput: { reviewId: 'review-7' },
            subPath: 'reviews/current',
            adapter: semantic.adapter,
            handlers: {
                executeAction: async ({ action, input, signal }) => {
                    calls.push(`action:${typeof action === 'string' ? action : action.localId}`);
                    expect(signal.aborted).toBe(false);
                    return { accepted: input };
                },
                selectActionInput: async ({ request, signal }) => {
                    if (!('operation' in request)) throw new Error('expected targeted Action request');
                    calls.push(`select:${request.operation.action.localId}`);
                    expect(signal.aborted).toBe(false);
                    return { kind: 'cancelled' };
                },
                readResource: async ({ resource: requested }) => {
                    calls.push(`resource:${typeof requested === 'string' ? requested : requested.localId}`);
                    return resource;
                },
                watchResource: ({ resource: requested, signal }) => {
                    calls.push(`watch:${typeof requested === 'string' ? requested : requested.localId}`);
                    expect(signal.aborted).toBe(false);
                    return { digest: firstDigest };
                },
                openSurface: async ({ view, input, subPath, instanceKey }) => {
                    calls.push(`open:${typeof view === 'string' ? view : view.localId}:${subPath ?? ''}:${instanceKey ?? ''}:${JSON.stringify(input)}`);
                },
                replacePageLocation: async ({ subPath, backLocation }) => {
                    calls.push(`replace:${subPath}:${backLocation ?? ''}`);
                    return subPath;
                },
                notify: async ({ message }) => { calls.push(`notify:${message}`); },
                confirm: async ({ message }) => {
                    calls.push(`confirm:${message}`);
                    return true;
                },
                diagnostic: ({ data }) => {
                    calls.push(`diagnostic:${data.code}`);
                    deliveredDiagnostic = data;
                    resolveDiagnostic();
                },
                readClipboard: async () => 'copied review',
                writeClipboard: async ({ value }) => { calls.push(`clipboard:${value}`); },
                openExternalLink: async ({ url }) => { calls.push(`external:${url}`); },
            },
        });

        expect(fixture.context.plugin).toEqual({ id: identity.pluginId, version: identity.pluginVersion });
        expect(fixture.context.surface).toEqual(initialSurface);
        expect(fixture.context).not.toHaveProperty('view');
        expect(fixture.context.launchInput).toEqual({ reviewId: 'review-7' });
        expect(fixture.context.subPath).toBe('reviews/current');
        expect(fixture.context.signal.aborted).toBe(false);
        expect(semantic.mounts).toHaveLength(1);
        expect(semantic.mounts[0]?.context).toBe(fixture.context);
        expect(semantic.mounts[0]?.signal).toBe(fixture.context.signal);

        await expect(fixture.context.hostApi.executeAction('save-review', { reviewId: 'review-7' }))
            .resolves.toEqual({ accepted: { reviewId: 'review-7' } });
        await expect(fixture.context.hostApi.selectActionInput({
            operation: {
                point: { pointId: 'connection', protocol: { id: 'connection', version: 1 } },
                contributor: {
                    pluginId: 'com.acme.provider',
                    contributionId: 'provider',
                    immutableGenerationId: 'provider-generation-a',
                },
                role: 'setup',
                action: { pluginId: 'com.acme.provider', localId: 'setup' },
            },
        })).resolves.toEqual({ kind: 'cancelled' });
        await expect(fixture.context.hostApi.readResource('review'))
            .resolves.toMatchObject({ contentType: 'application/json', digest: firstDigest, bytes: new Uint8Array([1, 2, 3]) });
        await fixture.context.hostApi.openSurface('review-detail', { reviewId: 'review-7' }, {
            subPath: 'details',
            instanceKey: 'review-7',
        });
        await expect(fixture.context.hostApi.replacePageLocation('/details/7/', {
            backLocation: '/details/',
        })).resolves.toEqual({ subPath: 'details/7' });
        await fixture.context.hostApi.notify('Review saved');
        await expect(fixture.context.hostApi.confirm('Publish review?')).resolves.toBe(true);
        fixture.context.hostApi.diagnostic({
            code: 'fixture.ready',
            severity: 'info',
            remediation: { kind: 'openUrl', url: 'https://example.test/help' },
        });
        await diagnosticDelivered;
        expect(deliveredDiagnostic).toMatchObject({
            remediation: { kind: 'openUrl', url: 'https://example.test/help' },
        });
        await expect(fixture.context.hostApi.readClipboard()).resolves.toBe('copied review');
        await fixture.context.hostApi.writeClipboard('review link');
        await fixture.context.hostApi.openExternalLink('https://example.test/reviews/7');
        expect(calls).toContain('replace:details/7:details');

        const contextUpdates: string[] = [];
        const contextSubscription = await fixture.context.hostApi.watchContext((context) => {
            contextUpdates.push(context.locale);
        });
        const resourceEvents: string[] = [];
        const resourceSubscription = await fixture.context.hostApi.watchResource('review', (event) => {
            if (event.kind === 'invalidated') resourceEvents.push(`${event.kind}:${event.digest}`);
        });
        const target = await fixture.getByRole('button', { name: 'Save review', state: { disabled: false } });
        expect(target).toEqual({ role: 'button', name: 'Save review', state: { disabled: false } });
        expect(target).not.toHaveProperty('handle');
        expect(target).not.toHaveProperty('revision');
        await fixture.press(target);
        expect(semantic.invokes).toEqual([{
            revision: 1,
            handle: 'save-review',
            action: 'press',
            target: { role: 'button', name: 'Save review', state: { disabled: false } },
        }]);

        const updatedSurface = { ...initialSurface, locale: 'de-CH' as const };
        await fixture.updateSurface(updatedSurface);
        expect(semantic.updates).toHaveLength(1);
        expect(semantic.updates[0]?.surface).toEqual(updatedSurface);
        expect(contextUpdates).toEqual(['de-CH']);
        await expect(fixture.context.hostApi.context()).resolves.toEqual(updatedSurface);
        await expect(fixture.press(target)).rejects.toMatchObject({ code: 'stale_surface' });

        resource = { contentType: 'application/json', digest: secondDigest, bytes: new Uint8Array([4, 5, 6]) };
        fixture.invalidateResource('review', secondDigest);
        expect(resourceEvents).toEqual([`invalidated:${secondDigest}`]);
        await expect(fixture.context.hostApi.readResource('review'))
            .resolves.toMatchObject({ digest: secondDigest, bytes: new Uint8Array([4, 5, 6]) });

        contextSubscription.dispose();
        resourceSubscription.dispose();
        expect(calls).toEqual(expect.arrayContaining([
            'action:save-review',
            'select:setup',
            'resource:review',
            'watch:review',
            'open:review-detail:details:review-7:{"reviewId":"review-7"}',
            'notify:Review saved',
            'confirm:Publish review?',
            'diagnostic:fixture.ready',
            'clipboard:review link',
            'external:https://example.test/reviews/7',
        ]));
    });

    it('returns the exact Resource watch establishment digest through the public testkit', async () => {
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            handlers: {
                watchResource: () => ({ digest: firstDigest }),
            },
        });

        try {
            const subscription = await fixture.context.hostApi.watchResource('review', () => undefined);

            expect(subscription).toMatchObject({ admittedDigest: firstDigest });

            subscription.dispose();
        } finally {
            await fixture.dispose();
        }
    });

    it('preserves a supplied host-boundary refusal without pretending the fixture owns surface admission', async () => {
        let calls = 0;
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
            handlers: {
                openSurface: async ({ view }) => {
                    expect(typeof view === 'string' ? view : view.localId).toBe('review-detail');
                    calls += 1;
                    const refusal = {
                        name: 'PluginError',
                        code: 'denied',
                        message: 'The host did not admit the Review details panel.',
                    } satisfies PluginErrorData;
                    // A host boundary can cross a separately resolved SDK copy;
                    // only its closed public error shape is relevant here.
                    throw refusal;
                },
            },
        });

        try {
            await expect(fixture.context.hostApi.openSurface('review-detail', { reviewId: 'review-7' }))
                .rejects.toMatchObject({
                    code: 'denied',
                    message: 'The host did not admit the Review details panel.',
                });
            expect(calls).toBe(1);
        } finally {
            await fixture.dispose();
        }
    });

    it('keeps all matching list targets and waits for one asynchronously rendered semantic target', async () => {
        const semantic = createMutableSemanticAdapter([
            { handle: 'row-1', role: 'listitem', name: 'First review' },
            { handle: 'row-2', role: 'listitem', name: 'Second review' },
        ]);
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
        });

        await expect(fixture.getAllByRole('listitem')).resolves.toEqual([
            { role: 'listitem', name: 'First review' },
            { role: 'listitem', name: 'Second review' },
        ]);
        await expect(fixture.queryAllByRole('listitem')).resolves.toHaveLength(2);
        await expect(fixture.queryAllByRole('button')).resolves.toEqual([]);

        const rendered = fixture.findByRole('status', { name: 'Reviews loaded' });
        await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
        semantic.setNodes([{ handle: 'loaded-status', role: 'status', name: 'Reviews loaded' }]);
        await expect(rendered).resolves.toEqual({ role: 'status', name: 'Reviews loaded' });

        await fixture.dispose();
    });

    it('retires an awaiting semantic query with its surface generation', async () => {
        const semantic = createMutableSemanticAdapter([]);
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
        });

        const waiting = fixture.findByRole('status', { name: 'Reviews loaded' });
        await fixture.dispose();

        await expect(waiting).rejects.toMatchObject({ code: 'stale_surface' });
    });

    it('does not return a semantic target whose snapshot resolves after retirement', async () => {
        let resolveSnapshot!: (snapshot: Readonly<{
            revision: number;
            nodes: readonly PluginUiSemanticAdapterNode[];
        }>) => void;
        let resolveSnapshotStarted!: () => void;
        const snapshotStarted = new Promise<void>((resolve) => { resolveSnapshotStarted = resolve; });
        const adapter: PluginUiSemanticSurfaceAdapter<AuthorSurface> = {
            async mount() {
                return {
                    snapshot: async () => {
                        resolveSnapshotStarted();
                        return await new Promise((resolve) => { resolveSnapshot = resolve; });
                    },
                    async update() {},
                    async invoke() {},
                    async dispose() {},
                };
            },
        };
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter,
        });

        const pending = fixture.findByRole('button', { name: 'Save review' });
        await snapshotStarted;
        await fixture.dispose();
        resolveSnapshot({
            revision: 1,
            nodes: [{ handle: 'save-review', role: 'button', name: 'Save review', actions: ['press'] }],
        });

        await expect(pending).rejects.toMatchObject({ code: 'stale_surface' });
    });

    it('rejects a retained target when its adapter handle now names different semantics', async () => {
        const semantic = createMutableSemanticAdapter([
            { handle: 'reused-handle', role: 'button', name: 'Retry review', actions: ['press'] },
        ]);
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
        });
        const retained = await fixture.getByRole('button', { name: 'Retry review' });

        semantic.setNodes([
            { handle: 'reused-handle', role: 'button', name: 'Delete review', actions: ['press'] },
        ]);

        await expect(fixture.press(retained)).rejects.toMatchObject({ code: 'stale_surface' });
        expect(semantic.invokes).toEqual([]);
        await fixture.dispose();
    });

    it('advertises and routes optional opaque openable-content boundaries only when installed', async () => {
        const semantic = createSemanticAdapter();
        const reference = { kind: 'workspaceFile', handle: 'mounted_file_1' } as const;
        let observedStat: PluginUiTestkitStatOpenableContentInput | undefined;
        const observedReads: PluginUiTestkitReadOpenableContentInput[] = [];
        let resolveReadCancellation!: () => void;
        const readCancellationStarted = new Promise<void>((resolve) => { resolveReadCancellation = resolve; });
        let readCancellationObserved = false;
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
            handlers: {
                statOpenableContent: async ({ ref, signal }) => {
                    observedStat = { ref, signal };
                    return {
                        status: 'ready',
                        mimeType: 'text/plain',
                        contentClass: 'text',
                        extension: '.txt',
                        sizeBytes: 5,
                        revision: 'revision-1',
                    };
                },
                readOpenableContent: async ({ request, signal }) => {
                    observedReads.push({ request, signal });
                    if (request.expectedRevision === 'revision-cancellation') {
                        resolveReadCancellation();
                        await new Promise<void>((resolve) => {
                            signal.addEventListener('abort', () => {
                                readCancellationObserved = signal.aborted;
                                resolve();
                            }, { once: true });
                        });
                        return { status: 'cancelled' };
                    }
                    return {
                        status: 'ready',
                        content: { kind: 'utf8', text: 'hello' },
                        revision: 'revision-1',
                    };
                },
            },
        });

        expect(fixture.context.hostApi.version().methods).toEqual(expect.arrayContaining([
            'statOpenableContent',
            'readOpenableContent',
        ]));
        await expect(fixture.context.hostApi.statOpenableContent(reference)).resolves.toEqual({
            status: 'ready',
            mimeType: 'text/plain',
            contentClass: 'text',
            extension: '.txt',
            sizeBytes: 5,
            revision: 'revision-1',
        });
        await expect(fixture.context.hostApi.readOpenableContent({
            ref: reference,
            expectedRevision: 'revision-1',
            maxBytes: 64,
        })).resolves.toEqual({
            status: 'ready',
            content: { kind: 'utf8', text: 'hello' },
            revision: 'revision-1',
        });
        await expect(fixture.context.hostApi.readOpenableContent({
            ref: reference,
            expectedRevision: 'revision-1',
        })).resolves.toEqual({
            status: 'ready',
            content: { kind: 'utf8', text: 'hello' },
            revision: 'revision-1',
        });
        expect(observedStat?.ref).toEqual(reference);
        expect(observedStat?.signal.aborted).toBe(false);
        expect(observedReads.map((input) => input.request)).toEqual([
            { ref: reference, expectedRevision: 'revision-1', maxBytes: 64 },
            {
                ref: reference,
                expectedRevision: 'revision-1',
                maxBytes: DEFAULT_OPENABLE_CONTENT_MAX_BYTES_V1,
            },
        ]);
        for (const value of [observedStat, ...observedReads]) {
            if (!value) throw new Error('The installed openable-content handler was not invoked.');
            expect(value.signal.aborted).toBe(false);
            expect(value).not.toHaveProperty('path');
            expect(value).not.toHaveProperty('mount');
            expect(value).not.toHaveProperty('currentness');
        }
        const cancellation = new AbortController();
        const pendingCancellation = fixture.context.hostApi.readOpenableContent({
            ref: reference,
            expectedRevision: 'revision-cancellation',
        }, { signal: cancellation.signal });
        await readCancellationStarted;
        cancellation.abort();
        await expect(pendingCancellation).rejects.toMatchObject({ code: 'aborted' });
        expect(readCancellationObserved).toBe(true);
        await fixture.dispose();

        const absent = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: createSemanticAdapter().adapter,
        });
        expect(absent.context.hostApi.version().methods).not.toEqual(expect.arrayContaining([
            'statOpenableContent',
            'readOpenableContent',
        ]));
        await expect(absent.context.hostApi.statOpenableContent(reference)).rejects.toMatchObject({ code: 'unsupported_method' });
        await expect(absent.context.hostApi.readOpenableContent({
            ref: reference,
            expectedRevision: 'revision-1',
        })).rejects.toMatchObject({ code: 'unsupported_method' });
        await absent.dispose();
    });

    it('propagates cancellation, retires a generation, and disposes the semantic mount exactly once', async () => {
        const semantic = createSemanticAdapter();
        let resolveStarted!: () => void;
        const started = new Promise<void>((resolve) => { resolveStarted = resolve; });

        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
            handlers: {
                executeAction: async ({ signal }) => {
                    resolveStarted();
                    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
                    return null;
                },
            },
        });
        const cancellation = new AbortController();
        const pending = fixture.context.hostApi.executeAction('wait-for-review', {}, { signal: cancellation.signal });
        await started;
        cancellation.abort();

        await expect(pending).rejects.toMatchObject({ code: 'aborted' });
        await fixture.retire('replacement_generation');
        expect(fixture.context.signal.aborted).toBe(true);
        await expect(fixture.context.hostApi.context()).rejects.toMatchObject({ code: 'ui_host_unavailable' });
        await Promise.all([fixture.dispose(), fixture.dispose()]);
        expect(semantic.disposalCount()).toBe(1);
    });

    it('rejects a semantic target when the adapter advances its own revision', async () => {
        const semantic = createSemanticAdapter();
        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
        });
        const target = await fixture.getByRole('button', { name: 'Save review' });

        semantic.advanceRevision();

        await expect(fixture.press(target)).rejects.toMatchObject({ code: 'stale_surface' });
        expect(semantic.invokes).toEqual([]);
        await fixture.dispose();
    });

    it('rejects malformed mount contexts through the actual public client and exposes no renderer or host-private state', async () => {
        const semantic = createSemanticAdapter();
        await expect(createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: { ...initialSurface, locale: '' },
            adapter: semantic.adapter,
        })).rejects.toMatchObject({ code: 'invalid_payload' });

        const fixture = await createPluginUiTestkit({
            identity,
            surface: { kind: 'author-surface' },
            surfaceContext: initialSurface,
            adapter: semantic.adapter,
        });
        const found = await fixture.getByRole('button', { name: 'Save review' });
        const queried = await fixture.queryByRole('button', { name: 'Save review' });
        for (const result of [found, queried]) {
            expect(result).toBeDefined();
            for (const privateName of ['handle', 'revision', 'tree', 'nodes', 'renderer']) {
                expect(result).not.toHaveProperty(privateName);
            }
        }
        await expect(fixture.press({ ...found })).rejects.toMatchObject({ code: 'stale_surface' });
        for (const privateName of ['tree', 'nodes', 'transport', 'store', 'artifact', 'cache', 'generation', 'inspect']) {
            expect(fixture).not.toHaveProperty(privateName);
            expect(fixture.context).not.toHaveProperty(privateName);
        }
        await fixture.dispose();
    });
});
