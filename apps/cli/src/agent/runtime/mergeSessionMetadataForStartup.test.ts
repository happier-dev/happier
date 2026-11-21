import { describe, expect, it } from 'vitest';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

import { mergeSessionMetadataForStartup } from './mergeSessionMetadataForStartup';
import { createStartupMetadataOverrides } from './createStartupMetadataOverrides';
import { createSessionOwnerMetadataV1, SessionOwnerMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionRunnerRuntimeStateV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { readCapabilityLaunchRestartFromMetadataV1, resolveCapabilityApplyTimingV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import { applyDisplayTitleSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { SessionModelSelectionV2Schema } from '@happier-dev/protocol/providers/selection/v2';
import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

describe('mergeSessionMetadataForStartup', () => {
    it.each(['native', 'account_provider_connection', 'team_resource'] as const)('starts with the exact typed %s model source', source => {
        const modelSelection = SessionModelSelectionV2Schema.parse({ v: 2, updatedAt: 100, ref: {
            source, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'selected-model',
            ...(source === 'account_provider_connection' ? { providerConnectionId: 'pc_work' } : {}),
            ...(source === 'team_resource' ? { resourceId: 'resource-1', teamId: 'team-1', expectedResourceRevision: 4,
                deliveryMode: 'brokered' } : {}),
        } });
        const overrides = createStartupMetadataOverrides({ modelSelection });
        const merged = mergeSessionMetadataForStartup({ current: createTestMetadata({ flavor: 'codex' }),
            next: createTestMetadata({ flavor: 'codex' }), mode: 'start', nowMs: 110, ...overrides });
        expect(merged.modelSelectionIntentV2).toEqual(modelSelection);
        expect(merged.modelSelectionIntentV1).toBeUndefined();
    });
    it.each([undefined, { seed: 'saved-face' }] as const)('retains the existing face choice on attach (%j)', botFace => {
        const current = createTestMetadata({ bot: { kind: 'bot' }, ...(botFace ? { botFace } : {}) });
        const merged = mergeSessionMetadataForStartup({ current,
            next: createTestMetadata({ botFace: { seed: 'fresh-process-default' } }),
            mode: 'attach', nowMs: 2, attachMetadataIdentityPolicy: 'replace_with_runtime_identity' });
        expect(merged.botFace).toEqual(botFace);
    });
    it('preserves born authoring provenance across startup metadata and title updates', () => {
        const authoringOriginV1 = { kind: 'project' as const, accountId: 'original-account',
            workspace: { serverId: 'original-home', workspaceId: 'original-workspace', machineId: 'original-machine', rootPath: '/original/repo' }, page: 'scripts' as const };
        let current = createTestMetadata({ work: { authoringOriginV1 }, summary: { text: 'Initial title', updatedAt: 1 } });
        for (const nowMs of [2, 3, 4]) {
            current = applyDisplayTitleSessionMetadata(current, { title: `Native title ${nowMs}`, staleBehavior: 'bump-if-value-changed' });
            current = mergeSessionMetadataForStartup({ current,
                next: createTestMetadata({ work: { memoryEnabled: false, authoringOriginV1: { ...authoringOriginV1, page: 'code' } },
                    summary: { text: `Native title ${nowMs}`, updatedAt: nowMs } }),
                mode: 'attach', nowMs,
            });
            const owner = createSessionOwnerMetadataV1({ metadata: current });
            if (!owner.ok) throw new Error(owner.unsupportedFields.join(','));
            expect(SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata).work?.authoringOriginV1).toEqual(authoringOriginV1);
            expect(current.summary?.text).toBe(`Native title ${nowMs}`);
        }
    });
    it('keeps the committed Copy once origin when the attaching runner has its earlier launch recipe', () => {
        const launch = buildSessionCreationCorrespondence({
            identity: { callerCreationNamespace: 'session-birth', creationKey: 'copy-once' },
            recipe: { execution: { machineId: 'controller', directory: { kind: 'path', path: '/original/project' } },
                organization: { folderId: null, tagIds: [] },
                agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                projectFiles: { kind: 'copy_once' } },
        });
        const projectFilesOrigin = {
            sourceWorkspace: { serverId: 'home', workspaceId: 'source', machineId: 'controller', rootPath: '/original/project' },
            targetWorkspace: { v: 2 as const, kind: 'managed' as const, serverId: 'home', workspaceId: 'target',
                managedId: 'guest', controller: { machineId: 'controller', installationId: 'installation' }, rootPath: '/guest/project' },
        };
        const committed = { ...launch, recipe: { ...launch.recipe, projectFilesOrigin } };
        const merged = mergeSessionMetadataForStartup({
            current: createTestMetadata({ sessionCreationCorrespondenceV1: committed }),
            next: createTestMetadata({ sessionCreationCorrespondenceV1: launch }),
            nowMs: 100, mode: 'attach', attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        });
        const owner = createSessionOwnerMetadataV1({ metadata: merged });
        if (!owner.ok) throw new Error(owner.unsupportedFields.join(','));
        expect(SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata).system?.sessionCreationCorrespondenceV1?.recipe.projectFilesOrigin)
            .toEqual(projectFilesOrigin);
    });
    it('retires old plain-runner absence evidence when a new runner starts without a terminal', () => {
        const merged = mergeSessionMetadataForStartup({ mode: 'attach', nowMs: 2,
            current: createTestMetadata({ lifecycleStateReason: 'machine_access_withdrawn', hostPid: 1, terminal: { mode: 'plain', controlServiceabilityV1: {
                v: 1, state: 'unknown', observedAt: 1, retired: true, reason: 'attachment_retired',
            } } }), next: createTestMetadata({ hostPid: 2 }),
        });
        expect(merged.terminal).toBeUndefined();
        expect(merged.lifecycleStateReason).toBeUndefined();
    });
    it.each(['same-runner', 'hosted-attachment'] as const)('preserves %s terminal evidence during startup merge', kind => {
        const terminal = { mode: 'plain' as const, controlServiceabilityV1: { v: 1 as const, state: 'unknown' as const,
            observedAt: 1, retired: true, ...(kind === 'hosted-attachment' ? { attachmentId: 'retained-host' } : {}) } };
        const merged = mergeSessionMetadataForStartup({ mode: 'attach', nowMs: 2,
            current: createTestMetadata({ hostPid: 1, terminal }),
            next: createTestMetadata({ hostPid: kind === 'same-runner' ? 1 : 2 }),
        });
        expect(merged.terminal).toEqual(terminal);
    });
    it('uses the current terminal launch instead of retained daemon eligibility on manual attach', () => {
        const sessionRunnerRuntimeV1 = SessionRunnerRuntimeStateV1Schema.parse({
            v: 1, sessionId: 'session', observedAtMs: 1,
            runner: { entrypointSource: 'process_command', startedBy: 'daemon', startingMode: 'remote' },
            daemon: { currentEntrypointSource: 'launch_spec' }, versionState: 'current', statusSource: 'daemon_tracking',
            plannedRestart: { supported: true, eligible: true, disabledReason: null },
        });
        const merged = mergeSessionMetadataForStartup({
            current: createTestMetadata({ startedBy: 'daemon', sessionRunnerRuntimeV1 }),
            next: createTestMetadata({ startedBy: 'terminal' }), mode: 'attach', nowMs: 2,
        });
        expect(merged.startedBy).toBe('terminal');
        expect(merged.sessionRunnerRuntimeV1).toBe(sessionRunnerRuntimeV1);
        expect(resolveCapabilityApplyTimingV1({ kind: 'mcp_server', sessionRunning: true,
            agent: { vendorResume: 'supported', skillsLiveReload: 'unsupported' },
            launchRestart: readCapabilityLaunchRestartFromMetadataV1(merged),
        })).toEqual({ t: 'restart_to_apply', restartBy: 'terminal' });
        expect(readCapabilityLaunchRestartFromMetadataV1({ sessionRunnerRuntimeV1 })).toBe('automatic');
    });
    it('migrates Session skill context and disabled inherited entries without overriding explicit exclusions', () => {
        const entry = (id: string, artifactId: string) => ({ id, ref: { kind: 'bundle' as const, artifactId }, enabled: true,
            placement: 'system_append' as const });
        const current = createTestMetadata({ work: { promptStack: [entry('skill', 'skill-a'), entry('generic', 'generic-a')],
            disabledInheritedEntryIds: ['inherited-skill', 'inherited-doc'] },
            skillSelectionV1: { v: 1, forceIncludeSkillIds: ['existing'], forceExcludeSkillIds: ['skill-a'], excludeNativeSkillNames: ['native'] } });
        const args = { current, next: createTestMetadata(), nowMs: 100, mode: 'attach' as const,
            stackSkillMigration: { skillIds: new Set(['skill-a', 'inherited-a']),
                disabledInheritedEntries: [entry('inherited-skill', 'inherited-a')] } };
        const merged = mergeSessionMetadataForStartup(args);
        expect(merged.work?.promptStack).toEqual(current.work?.promptStack?.map(entry => entry.id === 'skill'
            ? { ...entry, skillMigrationV1: true } : entry));
        expect(merged.work?.disabledInheritedEntryIds).toEqual(['inherited-skill', 'inherited-doc']);
        expect(merged.skillSelectionV1).toEqual({ v: 1, forceIncludeSkillIds: ['existing'],
            forceExcludeSkillIds: ['skill-a', 'inherited-a'], excludeNativeSkillNames: ['native'] });
        const owner = createSessionOwnerMetadataV1({ metadata: merged });
        expect(owner.ok).toBe(true);
        if (!owner.ok) throw new Error(owner.unsupportedFields.join(','));
        const consumed = SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata);
        expect(consumed.runtime?.skillSelectionV1).toEqual(merged.skillSelectionV1);
        expect(consumed.work?.promptStack).toEqual(merged.work?.promptStack);
        expect(mergeSessionMetadataForStartup({ ...args, current: merged, nowMs: 101 }).work).toEqual(merged.work);
        expect(mergeSessionMetadataForStartup({ ...args, current: merged }).skillSelectionV1).toEqual(merged.skillSelectionV1);
        expect(mergeSessionMetadataForStartup({ ...args, stackSkillMigration: undefined }).work).toBe(current.work);
        const malformed = { ...current, skillSelectionV1: { v: 1, forceIncludeSkillIds: 'unreadable' } } as unknown as typeof current;
        expect(mergeSessionMetadataForStartup({ ...args, current: malformed }).work).toBe(current.work);
        expect(merged.skillSelectionRestartRequiredV1).toBeDefined();
        expect(mergeSessionMetadataForStartup({ ...args, appliedCapabilitySelection: { skills: merged.skillSelectionV1 } }))
            .not.toHaveProperty('skillSelectionRestartRequiredV1');
    });
    it('does not re-include a migrated Session skill after removal without an exclusion', () => {
        const current = createTestMetadata({ work: { promptStack: [{ id: 'legacy-skill', enabled: true,
            placement: 'skill_instructions', ref: { kind: 'bundle', artifactId: 'skill-a' } }] } });
        const args = { current, next: createTestMetadata(), nowMs: 100, mode: 'attach' as const,
            stackSkillMigration: { skillIds: new Set(['skill-a']) } };
        const migrated = mergeSessionMetadataForStartup(args);
        expect(migrated.skillSelectionV1?.forceIncludeSkillIds).toEqual(['skill-a']);
        let removed: typeof migrated = { ...migrated, skillSelectionV1: { v: 1 as const, forceIncludeSkillIds: [],
            forceExcludeSkillIds: [], excludeNativeSkillNames: [] } };
        for (let pass = 0; pass < 2; pass++) {
            removed = mergeSessionMetadataForStartup({ ...args, current: removed });
            expect(removed.skillSelectionV1?.forceIncludeSkillIds).toEqual([]);
            expect(removed.skillSelectionV1?.forceExcludeSkillIds).toEqual([]);
            const owner = createSessionOwnerMetadataV1({ metadata: removed });
            if (!owner.ok) throw new Error(owner.unsupportedFields.join(','));
            expect(SessionOwnerMetadataV1Schema.parse(owner.ownerMetadata).work?.promptStack)
                .toEqual(removed.work?.promptStack);
        }
    });
    it.each([
        { work: { memoryEnabled: true }, bot: { kind: 'bot' as const }, createdAsBot: true as const },
        { work: { memoryEnabled: false }, bot: undefined, createdAsBot: true as const },
        { work: undefined, bot: undefined, createdAsBot: undefined },
    ])('preserves retained owner-work and birth identity instead of fresh process defaults on attach (%j)', (facts) => {
        const current = createTestMetadata({ path: '/repo', host: 'original',
            ...(facts.work ? { work: facts.work } : {}),
            ...(facts.bot ? { bot: facts.bot } : {}),
            ...(facts.createdAsBot ? { createdAsBot: facts.createdAsBot } : {}),
        });
        const next = createTestMetadata({ path: '/runtime', host: 'runtime',
            bot: { kind: 'bot' }, createdAsBot: true, work: { memoryEnabled: false },
        });
        const merged = mergeSessionMetadataForStartup({ current, next, mode: 'attach', nowMs: 100,
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity' });
        for (const field of ['work', 'bot', 'createdAsBot'] as const) {
            expect(merged[field]).toBe(current[field]);
            if (current[field] === undefined) expect(merged).not.toHaveProperty(field);
        }
        expect(merged.host).toBe('runtime');
    });
    it.each([
        { intent: 'personal rename', summary: { text: 'My investigation', updatedAt: 7 } },
        { intent: 'empty personal title', summary: { text: '', updatedAt: 8 } },
        { intent: 'cleared or absent title', summary: undefined },
    ])('preserves $intent when attaching with a birth title', ({ summary }) => {
        const current = createTestMetadata({ path: '/repo', host: 'original', ...(summary ? { summary } : {}) });
        const next = createTestMetadata({
            path: '/runtime', host: 'runtime', summary: { text: '3 · Implement', updatedAt: 100 },
        });
        const merged = mergeSessionMetadataForStartup({
            current, next, nowMs: 100, mode: 'attach',
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        });

        expect(merged.summary).toBe(current.summary);
        if (!summary) expect(merged).not.toHaveProperty('summary');
        expect(merged.host).toBe('runtime');
        expect(next.summary?.text).toBe('3 · Implement');
    });

    it('keeps the birth title when starting a fresh session', () => {
        const current = createTestMetadata({ path: '/repo', host: 'host' });
        const next = createTestMetadata({ ...current, summary: { text: '3 · Implement', updatedAt: 100 } });
        const merged = mergeSessionMetadataForStartup({ current, next, nowMs: 100, mode: 'start' });

        expect(merged.summary).toBe(next.summary);
    });

    it('does not seed legacy messageQueueV1 metadata', () => {
        const nowMs = 123;
        const merged = mergeSessionMetadataForStartup({
            current: { lifecycleState: 'archived' } as any,
            next: { hostPid: 1 } as any,
            nowMs,
        });

        expect((merged as any).messageQueueV1).toBeUndefined();
        expect(merged.lifecycleState).toBe('running');
        expect(merged.lifecycleStateSince).toBe(nowMs);
    });

    it('preserves existing provider resume ids when next does not define them', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: { geminiSessionId: 'g1', codexSessionId: 'c1' } as any,
            next: { hostPid: 2 } as any,
            nowMs,
        });

        expect((merged as any).geminiSessionId).toBe('g1');
        expect((merged as any).codexSessionId).toBe('c1');
        expect(merged.hostPid).toBe(2);
    });

    it('preserves path from current metadata when attaching to an existing session', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: { path: '/workspace/real' } as any,
            next: { path: '/workspace/wrong', hostPid: 2 } as any,
            nowMs,
            mode: 'attach',
        });

        expect(merged.path).toBe('/workspace/real');
        expect(merged.hostPid).toBe(2);
    });

    it('uses runtime machine identity fields when attaching with runtime identity replacement', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: {
                path: '/workspace/source',
                host: 'source-host',
                homeDir: '/Users/source',
                happyHomeDir: '/Users/source/.happier',
                machineId: 'machine-source',
            } as any,
            next: {
                path: '/workspace/target',
                host: 'target-host',
                homeDir: '/Users/target',
                happyHomeDir: '/Users/target/.happier',
                machineId: 'machine-target',
                hostPid: 2,
            } as any,
            nowMs,
            mode: 'attach',
            attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
        });

        expect(merged.path).toBe('/workspace/target');
        expect(merged.host).toBe('target-host');
        expect(merged.homeDir).toBe('/Users/target');
        expect(merged.happyHomeDir).toBe('/Users/target/.happier');
        expect(merged.machineId).toBe('machine-target');
        expect(merged.hostPid).toBe(2);
    });

    it.each([undefined, 'replace_with_runtime_identity'] as const)('preserves accepted project and workspace identity at the same checkout (%s)', attachMetadataIdentityPolicy => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: {
                path: '/workspace/accepted', machineId: 'machine-accepted',
                workspaceId: 'ws_authoritative',
                projectId: 'project_authoritative',
                workspaceLocationId: 'loc_authoritative',
                workspaceCheckoutId: 'checkout_authoritative',
            } as any,
            next: {
                path: '/workspace/accepted', machineId: 'machine-accepted',
                workspaceId: 'ws_wrong',
                projectId: 'project_wrong',
                workspaceLocationId: 'loc_wrong',
                workspaceCheckoutId: 'checkout_wrong',
                hostPid: 2,
            } as any,
            nowMs,
            mode: 'attach',
            attachMetadataIdentityPolicy,
        });

        expect((merged as Record<string, unknown>).workspaceId).toBe('ws_authoritative');
        expect((merged as Record<string, unknown>).projectId).toBe('project_authoritative');
        expect((merged as Record<string, unknown>).workspaceLocationId).toBeUndefined();
        expect((merged as Record<string, unknown>).workspaceCheckoutId).toBeUndefined();
        expect(merged.hostPid).toBe(2);
    });

    it('does not seed workspace identity from next metadata when attaching', () => {
        const nowMs = 1;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: {
                workspaceId: 'ws_wrong',
                workspaceLocationId: 'loc_wrong',
                workspaceCheckoutId: 'checkout_wrong',
            } as any,
            nowMs,
            mode: 'attach',
        });

        expect((merged as Record<string, unknown>).workspaceId).toBeUndefined();
        expect((merged as Record<string, unknown>).workspaceLocationId).toBeUndefined();
        expect((merged as Record<string, unknown>).workspaceCheckoutId).toBeUndefined();
    });

    it('does not seed permissionMode from next metadata when attaching', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 123 } as any,
            nowMs,
            mode: 'attach',
        });

        expect((merged as any).permissionMode).toBeUndefined();
        expect((merged as any).permissionModeUpdatedAt).toBeUndefined();
    });

    it('does not stamp permissionModeUpdatedAt when attaching and it is missing', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'safe-yolo' } as any,
            next: { hostPid: 1 } as any,
            nowMs,
            mode: 'attach',
        });

        expect(merged.permissionMode).toBe('safe-yolo');
        expect((merged as any).permissionModeUpdatedAt).toBeUndefined();
    });

    it('preserves permissionMode intent when no override is provided', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 10 } as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 20 } as any,
            nowMs,
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(10);
    });

    it('applies explicit permissionMode override when it is newer than existing metadata', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { permissionMode: 'ask', permissionModeUpdatedAt: 10 } as any,
            next: { permissionMode: 'default', permissionModeUpdatedAt: 20 } as any,
            nowMs,
            permissionModeOverride: { mode: 'default', updatedAt: 25 },
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(25);
    });

    it('applies explicit permissionMode override even when there is no baseline mode', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: {} as any,
            nowMs,
            permissionModeOverride: { mode: 'default', updatedAt: 25 },
        });

        expect(merged.permissionMode).toBe('default');
        expect(merged.permissionModeUpdatedAt).toBe(25);
    });

    it.each(['start', 'attach'] as const)('preserves newer person permission intent over a stale runtime override on %s', mode => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: createTestMetadata({ permissionMode: 'read-only', permissionModeUpdatedAt: 100 }),
            next: createTestMetadata(),
            nowMs,
            mode,
            ...createStartupMetadataOverrides({ permissionMode: 'default', permissionModeUpdatedAt: 1 }),
        });

        expect(merged.permissionMode).toBe('read-only');
        expect(merged.permissionModeUpdatedAt).toBe(100);
    });

    it('does not seed canonical session-mode override metadata from next metadata when attaching', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: { sessionModeOverrideV1: { v: 1, updatedAt: 123, modeId: 'plan' } } as any,
            nowMs,
            mode: 'attach',
        });

        expect((merged as any).sessionModeOverrideV1).toBeUndefined();
        expect((merged as any).acpSessionModeOverrideV1).toBeUndefined();
    });

    it('preserves legacy-only session-mode override metadata when attaching', () => {
        const merged = mergeSessionMetadataForStartup({
            current: { acpSessionModeOverrideV1: { v: 1, updatedAt: 77, modeId: 'plan' } } as any,
            next: { hostPid: 2 } as any,
            nowMs: 50,
            mode: 'attach',
        });

        expect((merged as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 77, modeId: 'plan' });
        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 77, modeId: 'plan' });
    });

    it('uses the newest session-mode override alias during startup merge', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionModeOverrideV1: { v: 1, updatedAt: 100, modeId: 'build' },
                acpSessionModeOverrideV1: { v: 1, updatedAt: 200, modeId: 'plan' },
            } as any,
            next: {} as any,
            nowMs: 50,
        });

        expect((merged as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 200, modeId: 'plan' });
        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 200, modeId: 'plan' });
    });

    it('applies an explicit canonical session mode override with a monotonic updatedAt', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { sessionModeOverrideV1: { v: 1, updatedAt: 100, modeId: 'build' } } as any,
            next: {} as any,
            nowMs,
            // This will be plumbed as an explicit override from CLI/UI on startup.
            sessionModeOverride: { modeId: 'plan', updatedAt: 1 },
        });

        expect((merged as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 101, modeId: 'plan' });
        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 101, modeId: 'plan' });
    });

    it('preserves a newer session-mode clear tombstone instead of resurrecting next metadata', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionModeOverrideV1: { v: 1, updatedAt: 200, modeId: null },
            } as any,
            next: {
                sessionModeOverrideV1: { v: 1, updatedAt: 100, modeId: 'plan' },
            } as any,
            nowMs: 50,
        });

        expect((merged as any).sessionModeOverrideV1).toEqual({ v: 1, updatedAt: 200, modeId: null });
        expect((merged as any).acpSessionModeOverrideV1).toEqual({ v: 1, updatedAt: 200, modeId: null });
    });

    it('does not seed model selection from next metadata when attaching', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: { flavor: 'codex', modelOverrideV1: { v: 1, updatedAt: 123, modelId: 'gpt-5-codex-high' } } as any,
            nowMs,
            mode: 'attach',
        } as any);

        expect((merged as any).modelOverrideV1).toBeUndefined();
        expect((merged as any).modelSelectionIntentV1).toBeUndefined();
    });

    it('applies an explicit provider-bound model selection with a monotonic updatedAt', () => {
        const nowMs = 50;
        const merged = mergeSessionMetadataForStartup({
            current: { flavor: 'codex', modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'gpt-5-codex-low' } } as any,
            next: { flavor: 'codex' } as any,
            nowMs,
            modelOverride: {
                v: 1,
                updatedAt: 1,
                selection: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    providerConnectionId: 'pc_work',
                    modelId: 'gpt-5-codex-high',
                },
            } as any,
        } as any);

        expect((merged as any).modelSelectionIntentV1).toEqual({
            v: 1,
            updatedAt: 101,
            selection: {
                agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: 'pc_work',
                modelId: 'gpt-5-codex-high',
            },
        });
        expect((merged as any).modelOverrideV1).toBeUndefined();
    });

    it('preserves a newer model clear tombstone instead of resurrecting next metadata', () => {
        const merged = mergeSessionMetadataForStartup({
            current: { flavor: 'codex', modelOverrideV1: { v: 1, updatedAt: 200, modelId: null } } as any,
            next: { flavor: 'codex', modelOverrideV1: { v: 1, updatedAt: 100, modelId: 'gpt-5-codex-high' } } as any,
            nowMs: 50,
        });

        expect((merged as any).modelSelectionIntentV1).toEqual({ v: 1, updatedAt: 200, selection: null });
        expect((merged as any).modelOverrideV1).toEqual({ v: 1, updatedAt: 200, modelId: 'default' });
    });

    it.each([99, 100])('does not turn a captured model choice at %s into a newer intent', updatedAt => {
        const selection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'retained' } as const;
        const modelSelectionIntentV1 = { v: 1 as const, updatedAt: 100, selection };
        const merged = mergeSessionMetadataForStartup({
            current: createTestMetadata({ modelSelectionIntentV1 }), next: createTestMetadata(), nowMs: 200, mode: 'attach',
            modelOverride: { v: 1, updatedAt, selection },
        });
        expect(merged.modelSelectionIntentV1).toEqual(modelSelectionIntentV1);
    });

    it('merges ACP config option overrides per entry through the session-state timestamp policy', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 100,
                    overrides: {
                        telemetry: { updatedAt: 100, value: true },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 100,
                    overrides: {
                        telemetry: { updatedAt: 100, value: true },
                    },
                },
            } as any,
            next: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        telemetry: { updatedAt: 10, value: false },
                        reasoning: { updatedAt: 20, value: 'high' },
                    },
                },
            } as any,
            nowMs: 50,
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 100,
            overrides: {
                telemetry: { updatedAt: 100, value: true },
                reasoning: { updatedAt: 20, value: 'high' },
            },
        });
        expect((merged as any).acpConfigOptionOverridesV1).toEqual((merged as any).sessionConfigOptionOverridesV1);
    });

    it('uses the newest ACP config option override entry across canonical and legacy aliases', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 10,
                    overrides: {
                        effort: { updatedAt: 10, value: 'medium' },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 30,
                    overrides: {
                        effort: { updatedAt: 30, value: 'high' },
                    },
                },
            } as any,
            next: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        effort: { updatedAt: 20, value: 'low' },
                        speed: { updatedAt: 20, value: 'fast' },
                    },
                },
            } as any,
            nowMs: 50,
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 30,
            overrides: {
                effort: { updatedAt: 30, value: 'high' },
                speed: { updatedAt: 20, value: 'fast' },
            },
        });
        expect((merged as any).acpConfigOptionOverridesV1).toEqual((merged as any).sessionConfigOptionOverridesV1);
    });

    it('preserves config option entries that exist only in one alias root during startup merge', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 10,
                    overrides: {
                        effort: { updatedAt: 10, value: 'medium' },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        speed: { updatedAt: 20, value: 'fast' },
                    },
                },
            } as any,
            next: {} as any,
            nowMs: 50,
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 20,
            overrides: {
                effort: { updatedAt: 10, value: 'medium' },
                speed: { updatedAt: 20, value: 'fast' },
            },
        });
        expect((merged as any).acpConfigOptionOverridesV1).toEqual((merged as any).sessionConfigOptionOverridesV1);
    });

    it('keeps canonical config option entries when aliases tie during startup merge', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        effort: { updatedAt: 20, value: 'canonical' },
                    },
                },
                acpConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        effort: { updatedAt: 20, value: 'legacy' },
                    },
                },
            } as any,
            next: {} as any,
            nowMs: 50,
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toEqual({
            v: 1,
            updatedAt: 20,
            overrides: {
                effort: { updatedAt: 20, value: 'canonical' },
            },
        });
        expect((merged as any).acpConfigOptionOverridesV1).toEqual((merged as any).sessionConfigOptionOverridesV1);
    });

    it('does not seed ACP config option overrides from next metadata when attaching', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: {
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 20,
                    overrides: {
                        telemetry: { updatedAt: 20, value: true },
                    },
                },
            } as any,
            nowMs: 50,
            mode: 'attach',
        } as any);

        expect((merged as any).sessionConfigOptionOverridesV1).toBeUndefined();
        expect((merged as any).acpConfigOptionOverridesV1).toBeUndefined();
    });

    it('does not seed mcpSelectionV1 from next metadata when attaching', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {} as any,
            next: {
                mcpSelectionV1: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-a'],
                    forceExcludeServerIds: [],
                },
            } as any,
            nowMs: 50,
            mode: 'attach',
        } as any);

        expect((merged as any).mcpSelectionV1).toBeUndefined();
    });

    it('preserves existing mcpSelectionV1 when attaching', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                mcpSelectionV1: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-a'],
                    forceExcludeServerIds: ['server-b'],
                },
            } as any,
            next: {
                mcpSelectionV1: {
                    v: 1,
                    managedServersEnabled: true,
                    forceIncludeServerIds: [],
                    forceExcludeServerIds: [],
                },
            } as any,
            nowMs: 50,
            mode: 'attach',
        } as any);

        expect((merged as any).mcpSelectionV1).toEqual({
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['server-a'],
            forceExcludeServerIds: ['server-b'],
        });
        expect((merged as any).mcpSelectionRestartRequiredV1).toBeUndefined();
    });

    it('clears the MCP restart marker when startup applies the desired selection', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                mcpSelectionV1: {
                    v: 1,
                    managedServersEnabled: true,
                    forceIncludeServerIds: ['server-new'],
                    forceExcludeServerIds: [],
                },
                mcpSelectionRestartRequiredV1: {
                    v: 1,
                    appliedSelection: {
                        v: 1,
                        managedServersEnabled: true,
                        forceIncludeServerIds: [],
                        forceExcludeServerIds: [],
                    },
                },
            } as any,
            next: {} as any,
            nowMs: 50,
        } as any);

        expect((merged as any).mcpSelectionRestartRequiredV1).toBeUndefined();
    });

    it('can remove specific attach-only metadata keys during startup merge', () => {
        const merged = mergeSessionMetadataForStartup({
            current: {
                acpSessionModesV1: { v: 1, provider: 'codex' },
                acpSessionModelsV1: { v: 1, provider: 'codex' },
                acpConfigOptionsV1: { v: 1, provider: 'codex' },
                permissionMode: 'read-only',
            } as any,
            next: { hostPid: 42 } as any,
            nowMs: 50,
            mode: 'attach',
            metadataKeysToUnsetOnAttach: ['acpSessionModesV1', 'acpSessionModelsV1', 'acpConfigOptionsV1'],
        } as any);

        expect((merged as any).acpSessionModesV1).toBeUndefined();
        expect((merged as any).acpSessionModelsV1).toBeUndefined();
        expect((merged as any).acpConfigOptionsV1).toBeUndefined();
        expect(merged.permissionMode).toBe('read-only');
        expect((merged as any).hostPid).toBe(42);
    });
});
