import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
    AgentExternalSessionHookMapEventRequest,
    AgentExternalSessionHookResolveInstallationRequest,
    AgentExternalSessionsInvocation,
} from '@happier-dev/plugin-sdk/experimental/sessions';

import {
    CLAUDE_CLEAN_STOP_FIXTURE,
    CLAUDE_CTRL_C_SEQUENCE_FIXTURE,
    CLAUDE_FORK_START_FIXTURE,
    CLAUDE_HOOK_SUPPORTED_VERSION_FIXTURE,
    CLAUDE_HOOK_UNSUPPORTED_VERSION_FIXTURES,
    CLAUDE_NORMAL_RESUME_FIXTURES,
    CLAUDE_RECURSIVE_STOP_FIXTURE,
    CLAUDE_SESSION_START_FIXTURE,
} from './__fixtures__/hookEvidence.fixtures.test-support.js';
import { createClaudeExternalSessionsContribution } from './contribution.js';
import {
    CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID,
    CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
    CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_COLLECTION_ID,
    CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
    CLAUDE_EXTERNAL_SESSION_HOOK_STOP_EVENT_ID,
    CLAUDE_EXTERNAL_SESSION_HOOK_SUPPORTED_VERSION,
    claudeExternalSessionHooksContribution,
} from './hooks.js';

const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, {
        recursive: true,
        force: true,
    })));
});

function invocation(
    overrides: Partial<AgentExternalSessionsInvocation> = {},
): AgentExternalSessionsInvocation {
    return {
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 10_000,
        maxSerializedBytes: 65_536,
        ...overrides,
    };
}

function resolveInstallationRequest(
    installedVersion = CLAUDE_EXTERNAL_SESSION_HOOK_SUPPORTED_VERSION,
): AgentExternalSessionHookResolveInstallationRequest {
    return {
        ...invocation(),
        installation: {
            installationIdentity: 'claude-installation-v1',
            executableIdentity: 'sha256:claude-binary',
            installedVersion,
            platform: 'darwin',
            architecture: 'arm64',
        },
    };
}

function mapHookEventRequest(params: Readonly<{
    eventId: string;
    observedAtMs: number;
    nativePayload: AgentExternalSessionHookMapEventRequest['nativePayload'];
}>): AgentExternalSessionHookMapEventRequest {
    return {
        ...invocation(),
        installationIdentity: 'claude-installation-v1',
        variantId: CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID,
        ...params,
    };
}

describe('Claude External Session hooks', () => {
    it('declares one immutable SessionStart/Stop installation variant and only two callbacks', () => {
        expect(claudeExternalSessionHooksContribution).toEqual({
            installationVariants: [{
                variantId: CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID,
                targets: [{
                    targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
                    format: 'hook_event_json_arrays_v1',
                    collectionId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_COLLECTION_ID,
                }],
                events: [
                    {
                        eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                        targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
                        nativeEventName: 'SessionStart',
                        command: {
                            kind: 'happier_observation_v1',
                            shellDialect: 'posix',
                            timeoutMs: 500,
                        },
                    },
                    {
                        eventId: CLAUDE_EXTERNAL_SESSION_HOOK_STOP_EVENT_ID,
                        targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
                        nativeEventName: 'Stop',
                        command: {
                            kind: 'happier_observation_v1',
                            shellDialect: 'posix',
                            timeoutMs: 500,
                        },
                    },
                ],
            }],
            resolveInstallation: expect.any(Function),
            mapHookEvent: expect.any(Function),
        });
        expect(Object.keys(claudeExternalSessionHooksContribution).sort()).toEqual([
            'installationVariants',
            'mapHookEvent',
            'resolveInstallation',
        ]);
        expect(JSON.stringify(claudeExternalSessionHooksContribution)).not.toMatch(
            /adapter|recipe|planConfiguration|rootSelector|nativePath|fieldId/u,
        );
    });

    it('supports only the pinned installed version and resolves the current config-root target', async () => {
        expect(CLAUDE_EXTERNAL_SESSION_HOOK_SUPPORTED_VERSION).toBe(
            CLAUDE_HOOK_SUPPORTED_VERSION_FIXTURE,
        );
        const overrideRoot = await mkdtemp(join(tmpdir(), 'claude-hook-root-'));
        roots.push(overrideRoot);
        vi.stubEnv('CLAUDE_CONFIG_DIR', overrideRoot);
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '');

        for (const installedVersion of [
            CLAUDE_HOOK_SUPPORTED_VERSION_FIXTURE,
            `${CLAUDE_HOOK_SUPPORTED_VERSION_FIXTURE} (Claude Code)`,
        ]) {
            await expect(Promise.resolve(
                claudeExternalSessionHooksContribution.resolveInstallation(
                    resolveInstallationRequest(installedVersion),
                ),
            )).resolves.toEqual({
                ok: true,
                value: {
                    kind: 'supported',
                    variantId: CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID,
                    targets: [{
                        targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
                        absolutePath: join(overrideRoot, 'settings.json'),
                    }],
                    readiness: { kind: 'ready' },
                },
            });
        }

        for (const installedVersion of CLAUDE_HOOK_UNSUPPORTED_VERSION_FIXTURES) {
            await expect(Promise.resolve(
                claudeExternalSessionHooksContribution.resolveInstallation(
                    resolveInstallationRequest(installedVersion),
                ),
            )).resolves.toEqual({
                ok: true,
                value: {
                    kind: 'unsupported',
                    reason: 'version_unsupported',
                },
            });
        }
    });

    it('uses the official default config root without creating settings.json', async () => {
        vi.stubEnv('CLAUDE_CONFIG_DIR', '');
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '');
        const settingsPath = join(homedir(), '.claude', 'settings.json');

        const result = await claudeExternalSessionHooksContribution.resolveInstallation(
            resolveInstallationRequest(),
        );

        expect(result).toEqual({
            ok: true,
            value: {
                kind: 'supported',
                variantId: CLAUDE_EXTERNAL_SESSION_HOOK_INSTALLATION_VARIANT_ID,
                targets: [{
                    targetId: CLAUDE_EXTERNAL_SESSION_HOOK_SETTINGS_TARGET_ID,
                    absolutePath: settingsPath,
                }],
                readiness: { kind: 'ready' },
            },
        });
    });

    it('maps SessionStart as target-free identity only', async () => {
        const result = await claudeExternalSessionHooksContribution.mapHookEvent(
            mapHookEventRequest({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                observedAtMs: 1_000,
                nativePayload: CLAUDE_SESSION_START_FIXTURE,
            }),
        );

        expect(result).toEqual({
            ok: true,
            value: {
                kind: 'mapped',
                sourceInput: { kind: 'claudeConfig' },
                remoteSessionId: 'claude-session-a',
                facts: [],
            },
        });
        expect(JSON.stringify(result)).not.toMatch(
            /private|transcript|cwd|targetSessionId|happierSessionId/u,
        );
        expect(result.ok && result.value.kind === 'mapped'
            ? result.value
            : null).not.toHaveProperty('createdAtMs');
    });

    it('maps only a clean Stop to expiring qualified idle without claiming completion', async () => {
        const clean = await claudeExternalSessionHooksContribution.mapHookEvent(
            mapHookEventRequest({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_STOP_EVENT_ID,
                observedAtMs: 2_000,
                nativePayload: CLAUDE_CLEAN_STOP_FIXTURE,
            }),
        );

        expect(clean).toEqual({
            ok: true,
            value: {
                kind: 'mapped',
                sourceInput: { kind: 'claudeConfig' },
                remoteSessionId: 'claude-session-a',
                facts: [
                    {
                        kind: 'turn_phase',
                        value: 'idle',
                        evidenceClass: 'qualified_hook',
                        observedAtMs: 2_000,
                        expiresAtMs: 17_000,
                    },
                ],
            },
        });
        expect(JSON.stringify(clean)).not.toMatch(
            /liveness|running|stopped|interrupted|process|quiescen|writer/u,
        );

        await expect(Promise.resolve(
            claudeExternalSessionHooksContribution.mapHookEvent(
                mapHookEventRequest({
                    eventId: CLAUDE_EXTERNAL_SESSION_HOOK_STOP_EVENT_ID,
                    observedAtMs: 2_001,
                    nativePayload: CLAUDE_RECURSIVE_STOP_FIXTURE,
                }),
            ),
        )).resolves.toEqual({
            ok: true,
            value: { kind: 'ignored' },
        });
    });

    it('ignores unknown, mismatched, and malformed native payloads', async () => {
        const requests: AgentExternalSessionHookMapEventRequest[] = [
            mapHookEventRequest({
                eventId: 'unknown-event',
                observedAtMs: 3_000,
                nativePayload: {
                    hook_event_name: 'SessionStart',
                    session_id: 'claude-session-a',
                },
            }),
            mapHookEventRequest({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                observedAtMs: 3_001,
                nativePayload: {
                    hook_event_name: 'Stop',
                    session_id: 'claude-session-a',
                },
            }),
            mapHookEventRequest({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                observedAtMs: 3_002,
                nativePayload: {
                    hook_event_name: 'SessionStart',
                    session_id: 42,
                },
            }),
            mapHookEventRequest({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_STOP_EVENT_ID,
                observedAtMs: 3_003,
                nativePayload: {
                    hook_event_name: 'Stop',
                    session_id: 'claude-session-a',
                    stop_hook_active: 'false',
                },
            }),
        ];

        for (const request of requests) {
            await expect(Promise.resolve(
                claudeExternalSessionHooksContribution.mapHookEvent(request),
            )).resolves.toEqual({
                ok: true,
                value: { kind: 'ignored' },
            });
        }
    });

    it('does not fabricate Stop or completion for a user interrupt', async () => {
        const ctrlCObservedEvents = await Promise.all(
            CLAUDE_CTRL_C_SEQUENCE_FIXTURE.map((nativePayload, index) => (
                claudeExternalSessionHooksContribution.mapHookEvent(
                    mapHookEventRequest({
                        eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                        observedAtMs: 4_000 + index,
                        nativePayload,
                    }),
                )
            )),
        );

        expect(ctrlCObservedEvents.flatMap((result) => (
            result.ok && result.value.kind === 'mapped' ? result.value.facts : []
        ))).toEqual([]);
    });

    it('preserves same-id resume identity and maps explicit fork to a new identity', async () => {
        const resumes = await Promise.all(CLAUDE_NORMAL_RESUME_FIXTURES.map(
            (nativePayload, index) => (
                claudeExternalSessionHooksContribution.mapHookEvent(
                    mapHookEventRequest({
                        eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                        observedAtMs: 4_100 + index,
                        nativePayload,
                    }),
                )
            ),
        ));
        const fork = await claudeExternalSessionHooksContribution.mapHookEvent(
            mapHookEventRequest({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                observedAtMs: 4_200,
                nativePayload: CLAUDE_FORK_START_FIXTURE,
            }),
        );

        expect(resumes).toHaveLength(2);
        expect(resumes[0]).toEqual(resumes[1]);
        expect(resumes[0]).toMatchObject({
            ok: true,
            value: { remoteSessionId: 'claude-session-a' },
        });
        expect(fork).toMatchObject({
            ok: true,
            value: { remoteSessionId: 'claude-session-fork' },
        });
        expect(fork).not.toEqual(resumes[0]);
    });

    it('feeds mapped identity through the canonical six-method source/link owners', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-hook-identity-'));
        roots.push(root);
        const configDir = join(root, '.claude');
        const projectId = 'project-a';
        const remoteSessionId = 'claude-session-a';
        await mkdir(join(configDir, 'projects', projectId), { recursive: true });
        await writeFile(
            join(configDir, 'projects', projectId, `${remoteSessionId}.jsonl`),
            `${JSON.stringify({
                uuid: 'message-a',
                type: 'user',
                timestamp: '2026-07-24T10:00:00.000Z',
                message: { role: 'user', content: 'fixture' },
            })}\n`,
            'utf8',
        );
        vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '');

        const mapped = await claudeExternalSessionHooksContribution.mapHookEvent(
            mapHookEventRequest({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                observedAtMs: 5_000,
                nativePayload: {
                    hook_event_name: 'SessionStart',
                    session_id: remoteSessionId,
                    source: 'startup',
                },
            }),
        );
        if (!mapped.ok || mapped.value.kind !== 'mapped') {
            throw new Error('Expected mapped Claude hook identity');
        }

        const externalSessions = createClaudeExternalSessionsContribution({
            env: { CLAUDE_CONFIG_DIR: configDir },
        });
        const resolvedSource = await externalSessions.resolveSource({
            ...invocation(),
            source: mapped.value.sourceInput,
        });
        expect(resolvedSource).toMatchObject({
            ok: true,
            value: {
                source: {
                    kind: 'claudeConfig',
                    configDir: expect.any(String),
                },
            },
        });
        if (!resolvedSource.ok) return;

        const resolvedLink = await externalSessions.resolveLinkIdentity({
            ...invocation(),
            source: resolvedSource.value.source,
            remoteSessionId: mapped.value.remoteSessionId,
            ...(mapped.value.linkData ? { linkData: mapped.value.linkData } : {}),
        });
        expect(resolvedLink).toEqual({
            ok: true,
            value: {
                source: {
                    kind: 'claudeConfig',
                    configDir: expect.any(String),
                    projectId,
                },
                remoteSessionId,
                linkData: { projectId },
            },
        });
    });

    it('does not create or write the target settings file', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-hook-no-side-effects-'));
        roots.push(root);
        const settingsPath = join(root, 'settings.json');
        vi.stubEnv('CLAUDE_CONFIG_DIR', root);
        vi.stubEnv('HAPPIER_CLAUDE_CONFIG_DIR', '');

        await claudeExternalSessionHooksContribution.resolveInstallation(
            resolveInstallationRequest(),
        );
        await claudeExternalSessionHooksContribution.mapHookEvent(
            mapHookEventRequest({
                eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                observedAtMs: 6_000,
                nativePayload: {
                    hook_event_name: 'SessionStart',
                    session_id: 'claude-session-a',
                },
            }),
        );

        await expect(access(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('cooperatively rejects both callbacks after cancellation', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(Promise.resolve(
            claudeExternalSessionHooksContribution.resolveInstallation({
                ...resolveInstallationRequest(),
                signal: controller.signal,
            }),
        )).resolves.toMatchObject({ ok: false, code: 'cancelled' });
        await expect(Promise.resolve(
            claudeExternalSessionHooksContribution.mapHookEvent({
                ...mapHookEventRequest({
                    eventId: CLAUDE_EXTERNAL_SESSION_HOOK_SESSION_START_EVENT_ID,
                    observedAtMs: 7_000,
                    nativePayload: {
                        hook_event_name: 'SessionStart',
                        session_id: 'claude-session-a',
                    },
                }),
                signal: controller.signal,
            }),
        )).resolves.toMatchObject({ ok: false, code: 'cancelled' });
    });
});
