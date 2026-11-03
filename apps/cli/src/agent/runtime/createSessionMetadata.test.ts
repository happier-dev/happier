import { mergeSessionMetadataForStartup } from './mergeSessionMetadataForStartup';
import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import {
    applyInitialSessionCreationFactsToMetadata,
    buildCommittedLaunchMetadata,
    captureSessionLaunchControlMetadata,
    createSessionMetadata,
} from './createSessionMetadata';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from './sessionConnectedServicesBindingsEnv';
import { createDeferredStartupMetadataPlan } from './startup/createDeferredStartupMetadataPlan';
import { buildSessionCreationCorrespondence } from '@/session/shared/sessionCreationCorrespondence';
import { createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

const HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY =
    'HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_V1_JSON';

function createMetadata(
    options: Omit<Parameters<typeof createSessionMetadata>[0], 'launchControlMetadata'> &
        Partial<Pick<Parameters<typeof createSessionMetadata>[0], 'launchControlMetadata'>>,
) {
    return createSessionMetadata({
        ...options,
        launchControlMetadata:
            options.launchControlMetadata ?? captureSessionLaunchControlMetadata(),
    });
}

describe('createSessionMetadata', () => {
    it('uses only admitted face birth facts and never inherits a replay source face', () => {
        const source = createTestMetadata({ bot: { kind: 'bot' }, botFace: { seed: 'source-face' }, createdAsBot: true });
        expect(applyInitialSessionCreationFactsToMetadata(source, {})).not.toHaveProperty('botFace');
        const identity = { bot: { kind: 'bot' as const }, botFace: { body: 'crab' as const, seed: 'draft-preview' }, createdAsBot: true as const };
        const born = applyInitialSessionCreationFactsToMetadata(source, { identity, memoryEnabled: false });
        expect(born).toMatchObject({ ...identity, work: { memoryEnabled: false } });
        expect(projectSessionSharedMetadataV1({ metadata: born })).toMatchObject({ bot: identity.bot, botFace: identity.botFace });
    });
    it('keeps the selected approval profile in private owner runtime metadata at birth', () => {
        for (const approvalProfileId of ['builtin:apply-safe', null]) {
            const metadata = buildCommittedLaunchMetadata({ options: { directory: '/repo', approvalProfileId }, directory: '/repo' });
            const owner = createSessionOwnerMetadataV1({ metadata });
            if (!owner.ok) throw new Error(owner.unsupportedFields.join(','));
            expect(owner.ownerMetadata.runtime).toMatchObject({ approvalProfileId });
            expect(projectSessionSharedMetadataV1({ metadata })).not.toHaveProperty('approvalProfileId');
            expect(applyInitialSessionCreationFactsToMetadata({ approvalProfileId: 'parent-profile' }, { approvalProfileId }))
                .toMatchObject({ approvalProfileId });
        }
    });
    it('commits private authoring origin at birth beside resolved worker context', () => {
        const authoringOrigin = { kind: 'project' as const, accountId: 'original-account',
            workspace: { serverId: 'original-home', workspaceId: 'original-workspace', machineId: 'original-machine', rootPath: '/private/original' }, page: 'scripts' as const };
        const initialSessionRolesV1 = { roleId: 'builder', overrides: {}, sessionRoles: {}, notes: '' };
        const options = { directory: '/execution/repo', authoringOrigin, initialSessionRolesV1 };
        const metadata = buildCommittedLaunchMetadata({ options, directory: options.directory });
        const owner = createSessionOwnerMetadataV1({ metadata });
        if (!owner.ok) throw new Error(owner.unsupportedFields.join(','));
        expect(owner.ownerMetadata.work).toMatchObject({ authoringOriginV1: authoringOrigin, sessionRolesV1: initialSessionRolesV1 });
        expect(JSON.stringify(projectSessionSharedMetadataV1({ metadata }))).not.toContain('/private/original');
        expect(applyInitialSessionCreationFactsToMetadata(createTestMetadata({ work: { memoryEnabled: true } }), options).work)
            .toMatchObject({ authoringOriginV1: authoringOrigin });
    });
    it('keeps actual checkout branch private at birth and preserves detached observations on attach', () => {
        for (const branchName of ['feature/actual', null]) {
            const correspondence = buildSessionCreationCorrespondence({
                identity: { callerCreationNamespace: 'test', creationKey: 'branch-birth' },
                recipe: { execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/checkout' } },
                    organization: { folderId: null, tagIds: [] },
                    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                    checkout: { kind: 'git_worktree', finalDirectory: '/checkout', baseRef: 'main', branchMode: 'new', branchName } },
            });
            const metadata = buildCommittedLaunchMetadata({ options: { directory: '/checkout', sessionCreationCorrespondence: correspondence }, directory: '/checkout' });
            expect(metadata.machineId).toBe('machine-1');
            expect(metadata).toHaveProperty('branch', branchName);
            const owner = createSessionOwnerMetadataV1({ metadata });
            expect(owner.ok).toBe(true);
            if (!owner.ok) throw new Error(owner.unsupportedFields.join(', '));
            expect(owner.ownerMetadata.workspace).toHaveProperty('branch', branchName);
            const shared = projectSessionSharedMetadataV1({ metadata });
            expect(shared).not.toHaveProperty('branch');
            const opened = projectSessionOwnerCompatibilityViewV1({ sharedMetadata: shared, ownerMetadata: owner.ownerMetadata });
            expect(opened).toHaveProperty('branch', branchName);
            // Runtime Metadata carries the reopened checkout placement and branch observation.
            const openedRuntime = { path: opened.path, branch: opened.branch,
                ...(typeof opened.machineId === 'string' ? { machineId: opened.machineId } : {}) };
            expect(mergeSessionMetadataForStartup({ current: { ...createTestMetadata(), ...openedRuntime },
                next: { ...createTestMetadata(), branch: 'process-default' }, mode: 'attach', nowMs: 1 })).toHaveProperty('branch', branchName);
            expect(mergeSessionMetadataForStartup({ current: { ...createTestMetadata(), ...openedRuntime },
                next: { ...createTestMetadata(), ...openedRuntime, branch: 'process-default' }, mode: 'attach', nowMs: 1,
                attachMetadataIdentityPolicy: 'replace_with_runtime_identity' })).toHaveProperty('branch', branchName);
            expect(mergeSessionMetadataForStartup({ current: { ...createTestMetadata(), ...openedRuntime },
                next: { ...createTestMetadata(), path: '/replacement-checkout' }, mode: 'attach', nowMs: 1,
                attachMetadataIdentityPolicy: 'replace_with_runtime_identity' })).not.toHaveProperty('branch');
        }
        expect(buildCommittedLaunchMetadata({ options: { directory: '/ordinary' }, directory: '/ordinary' })).not.toHaveProperty('branch');
    });
    it('preserves the observation through equivalent Windows and sandbox paths, not another physical checkout', () => {
        const current = createTestMetadata({ machineId: 'machine-1', path: '~\\repo', homeDir: 'C:\\Users\\Alice', branch: 'feature/actual' });
        expect(mergeSessionMetadataForStartup({ current,
            next: { ...current, path: 'c:/users/alice/repo/', branch: 'process-default' }, mode: 'attach', nowMs: 1,
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity' })).toHaveProperty('branch', 'feature/actual');
        const sandbox = { ...current, path: '/container/source', sessionWorkspaceLocationV1: {
            v: 1 as const, machineId: 'machine-1', agentPath: '/container/source', machinePath: 'C:\\Repo',
        } };
        const next = { ...sandbox, path: '/container/target', sessionWorkspaceLocationV1: {
            v: 1 as const, machineId: 'machine-1', agentPath: '/container/target', machinePath: 'c:/repo',
        } };
        expect(mergeSessionMetadataForStartup({ current: sandbox, next, mode: 'attach', nowMs: 1,
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity' })).toHaveProperty('branch', 'feature/actual');
        expect(mergeSessionMetadataForStartup({ current: sandbox,
            next: { ...next, sessionWorkspaceLocationV1: { ...next.sessionWorkspaceLocationV1, machinePath: 'C:/Repo2' } },
            mode: 'attach', nowMs: 1, attachMetadataIdentityPolicy: 'replace_with_runtime_identity' })).not.toHaveProperty('branch');
    });
    it('publishes the initialized Machine on attach when a retained birth has no placement and the launch environment is empty', () => {
        const plan = createDeferredStartupMetadataPlan({
            flavor: 'test-agent', initialMachineId: '', directory: '/project',
            initialPermissionMode: 'default',
            launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }),
        });
        expect(plan.initialMetadata).not.toHaveProperty('machineId');
        expect(plan.initialMetadata).not.toHaveProperty('sessionWorkspaceLocationV1');
        const current = createTestMetadata({ path: '/project', host: 'retained-host' });
        const next = plan.createInitializedSessionMetadata('registered-machine').metadata;
        expect(mergeSessionMetadataForStartup({ current, next, mode: 'attach', nowMs: 1 }))
            .toMatchObject({ machineId: 'registered-machine', path: '/project', host: 'retained-host',
                sessionWorkspaceLocationV1: { machineId: 'registered-machine', agentPath: '/project', machinePath: '/project' } });
    });
    it('refuses malformed captured tool policy rather than starting with default ask behavior', () => {
        for (const raw of ['not-json', 'null', '{"allowedTools":"Read"}', '{"unlistedTools":"allow"}']) {
            expect(() => captureSessionLaunchControlMetadata({
                processEnvironment: { HAPPIER_SESSION_TOOL_POLICY_JSON: raw },
            })).toThrow();
        }
    });
    it('sets attestation only at birth, removes inherited assertions and keeps the persisted facts on attach', () => {
        const attestedContext = { externalPrincipalId: 'sales@batiplus.ch', sourceMessageId: '<lead@example.test>' };
        const source = createTestMetadata({ path: '/project', host: 'machine', attestedContext });
        expect(applyInitialSessionCreationFactsToMetadata(source, {})).not.toHaveProperty('attestedContext');
        const current = applyInitialSessionCreationFactsToMetadata(source, { attestedContext });
        expect(current).toMatchObject({ attestedContext });
        const next = createMetadata({ flavor: 'test-agent', machineId: 'machine-1' }).metadata;
        expect(mergeSessionMetadataForStartup({ current, next, mode: 'attach', nowMs: 1 })).toMatchObject({ attestedContext });
    });
    it('seeds the authored tool policy at birth and preserves it when a runner attaches', () => {
        const policy = { allowedTools: ['mcp__wilson-intake__*'], unlistedTools: 'deny' as const, workspaceWrites: 'deny' as const };
        const current = applyInitialSessionCreationFactsToMetadata(createTestMetadata({ path: '/project', host: 'machine' }), policy);
        expect(current).toMatchObject(policy);
        const next = { ...createMetadata({ flavor: 'test-agent', machineId: 'machine-1' }).metadata, workspaceWrites: 'allow' as const };
        expect(mergeSessionMetadataForStartup({ current, next, mode: 'attach', nowMs: 1 })).toMatchObject(policy);
    });
    it('clears a previous runner generation when the replacement process cannot read its generation', () => {
        const next = createMetadata({ flavor: 'test-agent', machineId: 'machine-1' }).metadata;
        const current = { ...next, hostProcessStartTimeMs: 123456 };
        expect(mergeSessionMetadataForStartup({ current, next, mode: 'attach', nowMs: 1 }).hostProcessStartTimeMs)
            .toBeUndefined();
    });

    it('publishes the runner process generation before the session is created', () => {
        expect(createMetadata({
            flavor: 'test-agent', machineId: 'machine-1', hostProcessStartTimeMs: 123456,
        }).metadata).toMatchObject({ hostPid: process.pid, hostProcessStartTimeMs: 123456 });
    });

    it('publishes selected qualified Instructions with the other birth facts before Agent preparation', () => {
        const promptStack = [{
            id: 'session.instructions',
            ref: { kind: 'doc', serverId: 'instructions-home', artifactId: 'caretaker-instructions' },
            enabled: true,
            required: true,
            placement: 'system_append',
        }] as const;
        expect(applyInitialSessionCreationFactsToMetadata({ path: '/project', host: 'machine' }, {
            identity: { bot: { kind: 'bot' }, createdAsBot: true }, promptStack,
        })).toMatchObject({ bot: { kind: 'bot' }, work: { promptStack } });
        const { metadata } = createMetadata({
            flavor: 'test-agent', machineId: 'machine-1',
            identity: { bot: { kind: 'bot' }, createdAsBot: true }, promptStack,
            augmentMetadata: (current) => {
                expect(current.work?.promptStack).toEqual(promptStack);
                return current;
            },
        });
        expect(metadata.work?.promptStack).toEqual(promptStack);
        expect(metadata).not.toHaveProperty('work.instructions');
        expect(metadata).not.toHaveProperty('work.sessionInstructions');
    });

    it('uses the admitted Account default only at creation and gives an explicit choice precedence', () => {
        const source = { path: '/project', host: 'machine', work: { memoryEnabled: true } };
        expect(applyInitialSessionCreationFactsToMetadata(source, {
            accountSettings: { memoryUseInNewSessions: true, memoryUseInNewBots: false },
        })).toHaveProperty('work.memoryEnabled', true);
        expect(applyInitialSessionCreationFactsToMetadata(source, {
            identity: { bot: { kind: 'bot' }, createdAsBot: true },
            accountSettings: { memoryUseInNewSessions: true, memoryUseInNewBots: false },
        })).toHaveProperty('work.memoryEnabled', false);
        expect(applyInitialSessionCreationFactsToMetadata(source, {
            identity: { bot: { kind: 'bot' } },
            accountSettings: { memoryUseInNewSessions: true, memoryUseInNewBots: false },
        })).toHaveProperty('work.memoryEnabled', false);
        expect(applyInitialSessionCreationFactsToMetadata(source, {
            identity: { createdAsBot: true },
            accountSettings: { memoryUseInNewSessions: true, memoryUseInNewBots: false },
        })).toHaveProperty('work.memoryEnabled', true);
        expect(applyInitialSessionCreationFactsToMetadata(source, {
            memoryEnabled: false, accountSettings: { memoryUseInNewSessions: true },
        })).toHaveProperty('work.memoryEnabled', false);
    });
    it('starts a fresh replay child from admitted birth facts, not its source Bot marker or memory preference', () => {
        const source = { path: '/project', host: 'machine', bot: { kind: 'bot' as const },
            createdAsBot: true as const, work: { memoryEnabled: true } };
        const ordinary = applyInitialSessionCreationFactsToMetadata(source, {});
        expect(ordinary).not.toHaveProperty('bot');
        expect(ordinary).not.toHaveProperty('createdAsBot');
        expect(ordinary).toHaveProperty('work.memoryEnabled', false);
        expect(applyInitialSessionCreationFactsToMetadata(source, {
            identity: { bot: { kind: 'bot' }, createdAsBot: true }, memoryEnabled: false,
        })).toMatchObject({ bot: { kind: 'bot' }, createdAsBot: true, work: { memoryEnabled: false } });
    });
    it.each([
        [undefined, undefined, false],
        [{ bot: { kind: 'bot' } }, undefined, true],
        [{ createdAsBot: true }, undefined, false],
        [{ bot: { kind: 'bot' }, createdAsBot: true }, undefined, true],
        [{ bot: { kind: 'bot' }, createdAsBot: true }, false, false],
        [undefined, true, true],
    ])('initializes memory from the admitted kind and explicit creation choice (%j, %s)', (identity, memoryEnabled, expected) => {
        const launchControlMetadata = captureSessionLaunchControlMetadata({ processEnvironment: {
            ...(identity ? { HAPPIER_SESSION_INITIAL_IDENTITY_JSON: JSON.stringify(identity) } : {}),
            ...(memoryEnabled !== undefined ? { HAPPIER_SESSION_INITIAL_MEMORY_ENABLED: JSON.stringify(memoryEnabled) } : {}),
        } });
        const { metadata } = createMetadata({ flavor: 'test-agent', machineId: 'machine-1', launchControlMetadata });
        expect(metadata).toHaveProperty('work.memoryEnabled', expected);
        expect(metadata.createdAsBot).toBe(launchControlMetadata.identity?.createdAsBot);
        expect(metadata).not.toHaveProperty('work.memoryDocRef');
    });
    it('publishes admitted Bot birth facts before Agent metadata augmentation and consumes the launch carrier once', () => {
        const identity = { bot: { kind: 'bot' }, createdAsBot: true };
        const processEnvironment: NodeJS.ProcessEnv = {
            HAPPIER_SESSION_INITIAL_IDENTITY_JSON: JSON.stringify(identity),
        };
        const launchControlMetadata = captureSessionLaunchControlMetadata({ processEnvironment });
        const { metadata } = createMetadata({
            flavor: 'test-agent', machineId: 'machine-1', launchControlMetadata,
            augmentMetadata: (current) => {
                expect(current).toMatchObject(identity);
                return current;
            },
        });
        expect(metadata).toMatchObject(identity);
        expect(metadata).not.toHaveProperty('work.sessionInstructions');
        expect(processEnvironment.HAPPIER_SESSION_INITIAL_IDENTITY_JSON).toBeUndefined();
        expect(createMetadata({
            flavor: 'test-agent', machineId: 'machine-2',
            launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment }),
        }).metadata).not.toHaveProperty('bot');
    });

    it('refuses malformed identity rather than creating an ordinary Session after a requested Bot launch', () => {
        expect(() => captureSessionLaunchControlMetadata({ processEnvironment: {
            HAPPIER_SESSION_INITIAL_IDENTITY_JSON: JSON.stringify({ bot: { kind: 'bot', avatarId: 'override' } }),
        } })).toThrow();
    });
    it.each([undefined, 'path', 'Managed', ' managed ', 'invalid'])('does not classify an invalid directory marker %s as managed', (value) => {
        const processEnvironment: NodeJS.ProcessEnv = { HAPPIER_SESSION_DIRECTORY_KIND: value };
        const launchControlMetadata = captureSessionLaunchControlMetadata({ processEnvironment });
        const { metadata } = createMetadata({
            flavor: 'test-agent',
            machineId: 'machine-1',
            directory: '/tmp/path-session',
            launchControlMetadata,
        });
        expect(launchControlMetadata).toMatchObject({ sessionDirectoryKind: 'path' });
        expect(metadata).not.toHaveProperty('sessionDirectoryV1');
        expect(processEnvironment.HAPPIER_SESSION_DIRECTORY_KIND).toBeUndefined();
    });

    it('captures the directory kind once before the environment changes', () => {
        const processEnvironment: NodeJS.ProcessEnv = { HAPPIER_SESSION_DIRECTORY_KIND: 'path' };
        const launchControlMetadata = captureSessionLaunchControlMetadata({
            explicitEnvironment: { HAPPIER_SESSION_DIRECTORY_KIND: 'managed' },
            processEnvironment,
        });
        processEnvironment.HAPPIER_SESSION_DIRECTORY_KIND = 'path';
        const { metadata } = createMetadata({
            flavor: 'test-agent',
            machineId: 'machine-1',
            directory: '/tmp/managed-session',
            launchControlMetadata,
        });
        expect(launchControlMetadata).toMatchObject({ sessionDirectoryKind: 'managed' });
        expect(metadata).toHaveProperty('sessionDirectoryV1', { v: 1, kind: 'managed' });
    });

    it('uses an explicit non-secret launch-control snapshot instead of conflicting ambient state', () => {
        const previousProfileId = process.env.HAPPIER_SESSION_PROFILE_ID;
        const previousMcpSelection = process.env.HAPPIER_SESSION_MCP_SELECTION_JSON;
        process.env.HAPPIER_SESSION_PROFILE_ID = 'ambient-profile';
        process.env.HAPPIER_SESSION_MCP_SELECTION_JSON = JSON.stringify({
            v: 1,
            managedServersEnabled: true,
            forceIncludeServerIds: [],
            forceExcludeServerIds: [],
        });

        try {
            const launchControlMetadata = captureSessionLaunchControlMetadata({
                explicitEnvironment: {
                    HAPPIER_SESSION_PROFILE_ID: 'work',
                    HAPPIER_SESSION_MCP_SELECTION_JSON: JSON.stringify({
                        v: 1,
                        managedServersEnabled: false,
                        forceIncludeServerIds: ['server-a'],
                        forceExcludeServerIds: [],
                    }),
                    OPENAI_API_KEY: 'must-never-enter-metadata',
                },
                processEnvironment: process.env,
            });
            const { metadata } = createMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'terminal',
                launchControlMetadata,
            });

            expect(metadata.profileId).toBe('work');
            expect(metadata).not.toHaveProperty('mcpSelectionV1');
            expect(JSON.stringify(launchControlMetadata)).not.toContain('must-never-enter-metadata');
        } finally {
            if (previousProfileId === undefined) delete process.env.HAPPIER_SESSION_PROFILE_ID;
            else process.env.HAPPIER_SESSION_PROFILE_ID = previousProfileId;
            if (previousMcpSelection === undefined) delete process.env.HAPPIER_SESSION_MCP_SELECTION_JSON;
            else process.env.HAPPIER_SESSION_MCP_SELECTION_JSON = previousMcpSelection;
        }
    });

    it('does not seed legacy messageQueueV1 metadata', () => {
        const { metadata } = createMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        });

        expect((metadata as any).messageQueueV1).toBeUndefined();
    });

    it('seeds session mode override aliases when sessionModeId is provided', () => {
        const { metadata } = createMetadata({
            flavor: 'opencode',
            machineId: 'machine-1',
            startedBy: 'terminal',
            sessionModeId: 'plan',
            sessionModeUpdatedAt: 123,
        } as any);

        expect((metadata as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
        expect((metadata as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 123, modeId: 'plan' });
    });

    it('seeds canonical Provider model intent without an unrepresentable legacy projection', () => {
        const { metadata } = createMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            modelSelectionIntent: {
                v: 1,
                updatedAt: 123,
                selection: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: 'pc_work',
                    modelId: 'gpt-5-codex-high',
                },
            },
        } as any);

        expect((metadata as any).modelSelectionIntentV1).toEqual({
            v: 1,
            updatedAt: 123,
            selection: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_work',
                modelId: 'gpt-5-codex-high',
            },
        });
        expect((metadata as any).modelOverrideV1).toBeUndefined();
    });

    it('seeds sessionConfigOptionOverridesV1 from the daemon-provided environment override', () => {
        const previous = process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
        process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify({
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
            },
        });

        try {
            const { metadata } = createMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect((metadata as any).sessionConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect((metadata as any).acpConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 123,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                },
            });
            expect(process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
            } else {
                process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = previous;
            }
        }
    });

    it('preserves typed config option values when seeding daemon-provided overrides', () => {
        const previous = process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
        process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = JSON.stringify({
            v: 1,
            updatedAt: 123,
            overrides: {
                speed: { updatedAt: 123, value: 'fast' },
                telemetry: { updatedAt: 124, value: true },
            },
        });

        try {
            const { metadata } = createMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect((metadata as any).sessionConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 124,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                    telemetry: { updatedAt: 124, value: true },
                },
            });
            expect((metadata as any).acpConfigOptionOverridesV1).toEqual({
                v: 1,
                updatedAt: 124,
                overrides: {
                    speed: { updatedAt: 123, value: 'fast' },
                    telemetry: { updatedAt: 124, value: true },
                },
            });
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON;
            } else {
                process.env.HAPPIER_SESSION_CONFIG_OPTION_OVERRIDES_JSON = previous;
            }
        }
    });

    it('seeds sessionLogPath for developer log discovery', () => {
        const { metadata } = createMetadata({
            flavor: 'claude',
            machineId: 'machine-1',
            startedBy: 'terminal',
        } as any);

        expect(typeof (metadata as any).sessionLogPath).toBe('string');
        expect((metadata as any).sessionLogPath).toContain('/logs/');
        expect((metadata as any).sessionLogPath).toContain('.log');
    });

    it('does not let a child environment create a second selection metadata writer', () => {
        const previous = process.env.HAPPIER_SESSION_MCP_SELECTION_JSON;
        process.env.HAPPIER_SESSION_MCP_SELECTION_JSON = JSON.stringify({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-a'],
            forceExcludeServerIds: ['server-b'],
        });

        try {
            const { metadata } = createMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect(metadata).not.toHaveProperty('mcpSelectionV1');
            expect(metadata).not.toHaveProperty('skillSelectionV1');
        } finally {
            if (previous === undefined) {
                delete process.env.HAPPIER_SESSION_MCP_SELECTION_JSON;
            } else {
                process.env.HAPPIER_SESSION_MCP_SELECTION_JSON = previous;
            }
        }
    });

    it('commits both kinds of desired selection through the daemon birth owner', () => {
        const mcp = { v: 1 as const, managedServersEnabled: false, forceIncludeServerIds: ['server-a'], forceExcludeServerIds: ['server-b'] };
        const skills = { v: 1 as const, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: ['review'], excludeNativeSkillNames: ['native'] };
        const metadata = buildCommittedLaunchMetadata({
            directory: '/project', options: { directory: '/project', machineId: 'machine-1', capabilitySelection: { mcp, skills } },
        });
        expect(metadata).toMatchObject({ machineId: 'machine-1', mcpSelectionV1: mcp, skillSelectionV1: skills });
        expect(metadata).not.toHaveProperty('mcpSelectionRestartRequiredV1');
        expect(metadata).not.toHaveProperty('skillSelectionRestartRequiredV1');
    });

    it('preserves the exact accepted native Team witness through committed birth and runner attach', () => {
        const nativeDelivery = { managedId: 'managed', controllerInstallationId: 'controller-installation',
            guestInstallationId: 'guest-installation', bindingKey: 'binding', placeholderRef: 'placeholder',
            sourceRevision: 'source-1', providerTicket: 't'.repeat(43) };
        const current = createTestMetadata(buildCommittedLaunchMetadata({ directory: '/project', options: {
            directory: '/project', modelSelection: { v: 1, updatedAt: 123,
                ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' } },
            teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource', teamId: 'team',
                expectedResourceRevision: 1, deliveryMode: 'vendor-native', nativeDelivery }],
        } }));
        expect(current).toMatchObject({ modelSelectionIntentV2: { ref: { source: 'team_resource', nativeDelivery } } });
        const next = createMetadata({ flavor: 'codex', machineId: 'machine-1' }).metadata;
        expect(mergeSessionMetadataForStartup({ current, next, mode: 'attach', nowMs: 124 }))
            .toMatchObject({ modelSelectionIntentV2: { ref: { source: 'team_resource', nativeDelivery } } });
        const pending = createTestMetadata(buildCommittedLaunchMetadata({ directory: '/project', options: {
            directory: '/project', modelSelection: { v: 1, updatedAt: 123,
                ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' } },
            teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource', teamId: 'team',
                expectedResourceRevision: 1, deliveryMode: 'vendor-native' }],
        } }));
        const accepted = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'resource', teamId: 'team',
            expectedResourceRevision: 1, deliveryMode: 'vendor-native' as const, nativeDelivery,
            providerModelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-6-luna',
                nativeSource: { sourceRevision: nativeDelivery.sourceRevision, providerTicket: nativeDelivery.providerTicket } } };
        expect(mergeSessionMetadataForStartup({ current: pending, next, mode: 'attach', nowMs: 124,
            acceptedTeamCredentialBinding: accepted }))
            .toMatchObject({ modelSelectionIntentV2: { updatedAt: 123, ref: { nativeDelivery } } });
        expect(mergeSessionMetadataForStartup({ current: pending, next, mode: 'attach', nowMs: 124,
            acceptedTeamCredentialBinding: { ...accepted, providerModelSelection: { ...accepted.providerModelSelection, modelId: 'another-model' } } }))
            .not.toHaveProperty('modelSelectionIntentV2.ref.nativeDelivery');
    });

    it('preserves brokered connected-service selection through committed birth and runner attach', () => {
        const connectedServices = { v: 2 as const, bindingsByServiceId: {
            'happier.agent.claude/claude-subscription': {
                source: 'team_resource' as const, resourceId: 'claude-ai1', deliveryMode: 'brokered' as const,
            },
        } };
        const current = createTestMetadata(buildCommittedLaunchMetadata({ directory: '/project', options: {
            directory: '/project', connectedServices, connectedServicesUpdatedAt: 123,
        } }));
        expect(current).toMatchObject({ connectedServices, connectedServicesUpdatedAt: 123 });
        const next = createMetadata({ flavor: 'claude', machineId: 'machine-1' }).metadata;
        expect(mergeSessionMetadataForStartup({ current, next, mode: 'attach', nowMs: 124 }))
            .toMatchObject({ connectedServices, connectedServicesUpdatedAt: 123 });
    });

    it('seeds connected service bindings from the daemon-provided environment override', () => {
        const previous = process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
        process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = JSON.stringify({
            v: 2,
            bindingsByServiceId: {
                'happier.agent.codex/openai-codex': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'happier',
                },
            },
        });

        try {
            const { metadata } = createMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            });

            expect((metadata as Record<string, unknown>).connectedServices).toEqual({
                v: 2,
                bindingsByServiceId: {
                    'happier.agent.codex/openai-codex': {
                        source: 'connected',
                        selection: 'profile',
                        profileId: 'happier',
                    },
                },
            });
            expect(process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
            } else {
                process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = previous;
            }
        }
    });

    it('seeds connected-service materialization identity from the daemon-provided environment override', () => {
        const previous = process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY];
        const identity = {
            v: 1,
            id: 'csm_first_spawn',
            createdAt: 123,
        };
        process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY] = JSON.stringify(identity);

        try {
            const { metadata } = createMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            });

            expect((metadata as Record<string, unknown>).connectedServiceMaterializationIdentityV1).toEqual(identity);
            expect(process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY];
            } else {
                process.env[HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY] = previous;
            }
        }
    });

    it('ignores invalid connected service bindings from the daemon-provided environment override', () => {
        const previous = process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
        process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = JSON.stringify({
            v: 1,
            bindingsByServiceId: {
                'not-a-service': {
                    source: 'connected',
                    selection: 'profile',
                    profileId: 'happier',
                },
            },
        });

        try {
            const { metadata } = createMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            });

            expect((metadata as Record<string, unknown>).connectedServices).toBeUndefined();
            expect(process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]).toBeUndefined();
        } finally {
            if (previous === undefined) {
                delete process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY];
            } else {
                process.env[HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY] = previous;
            }
        }
    });

    it('does not seed acpTransportV1 from the shared metadata factory defaults', () => {
        const { metadata } = createMetadata({
            flavor: 'opencode',
            machineId: 'machine-1',
            startedBy: 'terminal',
        } as any);

        expect((metadata as any).acpTransportV1).toBeUndefined();
    });

    it('applies provider-owned metadata augmentation after building neutral shared metadata', () => {
        const { metadata } = createMetadata({
            flavor: 'opencode',
            machineId: 'machine-1',
            startedBy: 'terminal',
            augmentMetadata: (current: Metadata) => ({
                ...current,
                acpTransportV1: {
                    v: 1,
                    agentId: 'opencode',
                },
            }),
        } as any);

        expect((metadata as any).acpTransportV1).toEqual({
            v: 1,
            agentId: 'opencode',
        });
    });

    it('preserves arbitrary configured ACP flavor ids', () => {
        const { metadata } = createMetadata({
            flavor: 'acp:custom-kiro',
            machineId: 'machine-1',
            startedBy: 'terminal',
        } as any);

        expect(metadata.flavor).toBe('acp:custom-kiro');
    });

    it('uses the explicit directory for the session path when provided', () => {
        const { metadata } = createMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'terminal',
            directory: '/tmp/happier-explicit-directory',
        } as any);

        expect(metadata.path).toBe('/tmp/happier-explicit-directory');
    });

    it('publishes the agent and machine workspace roots captured at daemon launch', () => {
        const processEnvironment: NodeJS.ProcessEnv = {
            HAPPIER_SESSION_MACHINE_WORKSPACE_PATH: '/Users/alice/project',
        };
        const launchControlMetadata = captureSessionLaunchControlMetadata({
            explicitEnvironment: processEnvironment as Record<string, string>,
            processEnvironment,
        });

        const { metadata } = createMetadata({
            flavor: 'codex',
            machineId: 'machine-1',
            startedBy: 'daemon',
            directory: '/home/coder/project',
            launchControlMetadata,
        });

        expect(metadata.path).toBe('/home/coder/project');
        expect(metadata.sessionWorkspaceLocationV1).toEqual({
            v: 1,
            machineId: 'machine-1',
            agentPath: '/home/coder/project',
            machinePath: '/Users/alice/project',
        });
        expect(processEnvironment.HAPPIER_SESSION_MACHINE_WORKSPACE_PATH).toBeUndefined();
    });

    it('prefers the daemon-seeded requested directory over a canonicalized cwd', () => {
        const previousRequestedDirectory = process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY;
        const previousPwd = process.env.PWD;
        process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY = '/tmp/happier-requested-directory';
        process.env.PWD = '/private/tmp/happier-requested-directory';

        try {
            const { metadata } = createMetadata({
                flavor: 'codex',
                machineId: 'machine-1',
                startedBy: 'daemon',
            } as any);

            expect(metadata.path).toBe('/tmp/happier-requested-directory');
            expect(process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY).toBeUndefined();
        } finally {
            if (previousRequestedDirectory === undefined) {
                delete process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY;
            } else {
                process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY = previousRequestedDirectory;
            }

            if (previousPwd === undefined) {
                delete process.env.PWD;
            } else {
                process.env.PWD = previousPwd;
            }
        }
    });
});
