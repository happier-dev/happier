import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveSessionCreationTagV1, SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import {
    createAccountEncryptionCurrentnessFixture,
    createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

const PLUGIN_ID = 'acme.external.lane05-session-action';
const ACTION_ID = 'forward-to-session-run';
const SESSION_ID = 'c123456789012345678901234';
const RUN_ID = 'run-lane05-dogfood';
const ACCOUNT_TOKEN = 'lane05-external-plugin-account-token';

const persistenceBoundary = vi.hoisted(() => ({
    readStoredCredentials: vi.fn(async () => ({ token: ACCOUNT_TOKEN, encryption: null })),
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: persistenceBoundary.readStoredCredentials,
}));

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('installed external plugin Lane 05 Session Action', () => {
    it('uses the public Session service and canonical Action executor, and rechecks a revoked grant', async () => {
        const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-lane05-plugin-home-'));
        const pluginRoot = await mkdtemp(join(tmpdir(), 'happier-lane05-plugin-source-'));
        const home = fastify();
        const homeUrl = 'http://lane05-plugin-home.test';
        const admissions: unknown[] = [];
        let sessionReadCount = 0;
        let denyAfterSessionReadCount: number | null = null;
        const correspondence = {
            v: 1,
            sessionCreationTag: deriveSessionCreationTagV1({
                callerCreationNamespace: 'user',
                creationKey: 'lane05-plugin-session',
            }),
            recipe: {
                execution: { machineId: 'machine-lane05-plugin', directory: { kind: 'path', path: '/workspace' } },
                organization: { folderId: null, tagIds: [] },
                agentTarget: {
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                },
                modelSelection: null,
                profileId: null,
                requestedPermissionMode: null,
                agentModeId: null,
                configuration: null,
                connectedServices: null,
                capabilitySelection: null,
                transcriptStorage: null,
                terminal: null,
                agentSessionStartupInstructionsMarkerV1: null,
                checkout: null,
            },
        };
        expect(SessionCreationCorrespondenceV1Schema.safeParse(correspondence).success).toBe(true);
        const session = createSessionRecordFixture({
            id: SESSION_ID,
            active: true,
            encryptionMode: 'plain',
            metadata: JSON.stringify({ sessionCreationCorrespondenceV1: correspondence }),
        });

        home.get('/v1/account/encryption/currentness', async () => (
            createAccountEncryptionCurrentnessFixture({ mode: 'plain' })
        ));
        home.get(`/v2/sessions/${SESSION_ID}`, async (_request, reply) => {
            sessionReadCount += 1;
            if (
                denyAfterSessionReadCount !== null
                && sessionReadCount > denyAfterSessionReadCount
            ) return await reply.status(404).send({ error: 'not_found' });
            return { session };
        });
        const restoreHttp = installAxiosFastifyAdapter({ app: home, origin: homeUrl });
        let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | null = null;
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'never');
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({
            v: 1,
            actions: {},
            approvalWaivedSurfaces: { 'session.message.send': ['plugin'] },
        }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            features: {},
            capabilities: { session: { pendingInput: { protocolVersion: 3 } } },
        }), { status: 200 })));

        try {
            await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.happier-plugin', 'plugin.json'), JSON.stringify({
                schemaVersion: 2,
                id: PLUGIN_ID,
                version: '1.0.0',
                displayName: 'External Lane 05 Session Action fixture',
                engines: { happier: '^0.3.0' },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: './daemon.mjs' },
                hostAccess: {
                    required: [{
                        id: 'session-send',
                        capability: 'sessions',
                        reason: 'Resolve and send to a selected Session execution run.',
                        scope: { access: ['read', 'write'] },
                    }],
                    optional: [],
                },
                contributes: {
                    actions: [{
                        id: ACTION_ID,
                        title: 'Forward to Session execution run',
                        scopes: ['global'],
                        surfaces: ['cli'],
                        execution: { target: 'daemon' },
                        placementBindings: ['primary'],
                        dangerLevel: 'safe',
                        hostAccess: ['session-send'],
                        inputSchema: {
                            type: 'object',
                            properties: {
                                sessionId: { type: 'string', minLength: 1 },
                                runId: { type: 'string', minLength: 1 },
                                text: { type: 'string', minLength: 1 },
                                idempotencyKey: { type: 'string', minLength: 1 },
                            },
                            required: ['sessionId', 'runId', 'text', 'idempotencyKey'],
                            additionalProperties: false,
                        },
                    }],
                },
            }), 'utf8');
            // This is the installed external form of the public
            // action-contract-producer example: only activate(api) and public
            // Session services are available inside the plugin process.
            await writeFile(join(pluginRoot, 'daemon.mjs'), `
                export function activate(api) {
                    api.actions.register(${JSON.stringify(ACTION_ID)}, async (input, context) => {
                        const session = await context.services.sessions.get(input.sessionId, {
                            signal: context.signal,
                        });
                        if (!session) throw new Error('forward_session_unavailable');
                        return await session.send({
                            kind: 'userText',
                            text: input.text,
                            idempotencyKey: input.idempotencyKey,
                            recipient: { kind: 'execution_run', runId: input.runId },
                        }, { signal: context.signal });
                    });
                }
            `, 'utf8');

            const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
            const trust = createPluginTrustRecord({ pluginId: PLUGIN_ID, distribution, approvedAtMs: 1 });
            await writeCommittedLocalPathPluginFixture({
                happyHomeDir,
                pluginId: PLUGIN_ID,
                sourceRootPath: pluginRoot,
                plugin: {
                    source: {
                        kind: 'path',
                        locator: pluginRoot,
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedPath: pluginRoot,
                        manifestPath: join(pluginRoot, '.happier-plugin', 'plugin.json'),
                    },
                    compatibility: { status: 'compatible', diagnostics: [] },
                    install: {
                        mode: 'link',
                        manifestVersion: '1.0.0',
                        installedPath: null,
                        trust,
                        updatePolicy: 'allowed',
                        optionalAccess: [],
                    },
                    state: { enabled: true },
                },
            });

            const resolvedContributes = await resolveMergedContributionRegistry({ happyHomeDir });
            const contributes = Object.freeze({
                ...resolvedContributes,
                // Production obtains this from the installed Machine
                // materialization. The fixture projects that same host-owned
                // fact; the plugin never supplies or bypasses it.
                materializationIdsByPluginId: Object.freeze({
                    ...(resolvedContributes.materializationIdsByPluginId ?? {}),
                    [PLUGIN_ID]: 'materialization-lane05-plugin-current',
                }),
            });
            expect(contributes.activationTargets.find((target) => target.pluginId === PLUGIN_ID))
                .toMatchObject({ provenance: 'external' });
            const generationAuthority = await readCurrentCommittedPluginGenerations(
                resolvePluginStorePaths({ happyHomeDir }),
                {},
            );
            if (!generationAuthority) {
                throw new Error('Expected committed external plugin generation authority');
            }
            registry = await runWithServerHttpBaseUrl(homeUrl, async () => (
                await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    contributes,
                    generationAuthority,
                    pluginIds: [PLUGIN_ID],
                    resolveCurrentMachineId: () => 'machine-lane05-plugin',
                    machineAdmissionTransport: async (request) => {
                        admissions.push(request);
                        return {
                            status: 'accepted',
                            localId: request.localId,
                        };
                    },
                })
            ));
            await registry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'actions',
                localId: ACTION_ID,
            }]);

            const invoke = async (idempotencyKey: string) => (
                await runWithServerHttpBaseUrl(homeUrl, async () => (
                    await registry?.targetActionInvocations?.invoke({
                        pluginId: PLUGIN_ID,
                        localId: ACTION_ID,
                        input: {
                            sessionId: SESSION_ID,
                            runId: RUN_ID,
                            text: 'Continue the exact retained run',
                            idempotencyKey,
                        },
                        surface: 'cli',
                    })
                ))
            );

            const accepted = await invoke('lane05-dogfood-accepted');
            expect(accepted, JSON.stringify(accepted)).toMatchObject({
                status: 'executed',
                value: { status: 'accepted', localId: expect.any(String) },
            });
            if (
                accepted?.status !== 'executed'
                || typeof accepted.value !== 'object'
                || accepted.value === null
                || !('localId' in accepted.value)
                || typeof accepted.value.localId !== 'string'
            ) {
                throw new Error('Expected an executed Session Action result with a local id');
            }
            expect(admissions).toHaveLength(1);
            expect(admissions[0]).toMatchObject({
                v: 2,
                sessionId: SESSION_ID,
                recipient: { kind: 'execution_run', runId: RUN_ID },
                targetMachineId: 'machine-lane05-plugin',
                localId: accepted.value.localId,
                content: {
                    t: 'plain',
                    v: expect.objectContaining({
                        content: { type: 'text', text: 'Continue the exact retained run' },
                    }),
                },
            });

            // Permit the plugin's public sessions.get read, then revoke before
            // the canonical session.message.send Action resolves its target.
            // This proves the host does not turn the handle into cached write
            // authority. The public Session adapter preserves uncertainty when
            // current Action authorization fails before it can prove admission.
            denyAfterSessionReadCount = sessionReadCount + 1;
            await expect(invoke('lane05-dogfood-revoked')).resolves.toEqual({
                status: 'executed',
                value: {
                    status: 'outcomeUnknown',
                    localId: expect.any(String),
                    code: 'session_input_action_execution_failed',
                },
            });
            expect(admissions).toHaveLength(1);
        } finally {
            restoreHttp();
            await registry?.dispose();
            await home.close();
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
            ]);
        }
    }, 60_000);
});
