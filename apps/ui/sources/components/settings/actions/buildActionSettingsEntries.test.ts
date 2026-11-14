import { describe, expect, it } from 'vitest';

import { ActionsSettingsV1Schema} from '@happier-dev/protocol/actions/actionSettings';
import { DEFAULT_ACTIONS_SETTINGS_V1} from '@happier-dev/protocol/account/settings/accountSettings';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { PLUGIN_MANIFEST as githubManifest } from '../../../../../../packages/plugins/scm-github/src/manifest';
import { buildActionSettingsContributedActions, buildActionSettingsEntries } from './buildActionSettingsEntries';

describe('buildActionSettingsEntries', () => {
    it('preserves declared confirmation defaults from daemon projection through settings, including explicit Ask', async () => {
        const { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        const { getActionTargetApprovalPolicy } = await import('./actionSettingsTargetApproval');
        const declaration = githubManifest.contributes.actions?.find(action => action.confirmationWhen?.presentUserUi === false);
        if (!declaration) throw new Error('Missing GitHub present-user Action');
        const { hostAccess, connectedAccountPurposeBindings, inputSchema, resultSchema, ...projectedDeclaration } = declaration;
        const pluginId = githubManifest.id;
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'GitHub', enabled: true,
                source: { kind: 'bundled', locator: '@happier-dev/plugin-scm-github' } } },
            actionsById: { [`${pluginId}/${declaration.id}`]: { ...projectedDeclaration, pluginId, occurrenceId: 'github-occurrence' } },
        });
        const contributedActions = buildActionSettingsContributedActions(
            adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection).pluginProjectionById,
        );
        const actionId = `${pluginId}/actions/${declaration.id}` as const;
        const entries = buildActionSettingsEntries({ query: '', settings: DEFAULT_ACTIONS_SETTINGS_V1, contributedActions,
            availability: { executionRunsEnabled: true, memorySearchEnabled: true, voiceEnabled: true,
                sessionHandoffEnabled: true, voiceShareDeviceInventory: true } });
        const entry = entries.find(candidate => candidate.actionId === actionId);
        if (!entry) throw new Error('Missing projected GitHub settings entry');
        for (const targetId of ['contextual_ui', 'agent', 'mcp'] as const) {
            const target = entry.targets.find(candidate => candidate.id === targetId);
            if (!target) throw new Error(`Missing ${targetId} target`);
            expect(getActionTargetApprovalPolicy({ settings: DEFAULT_ACTIONS_SETTINGS_V1, actionId,
                targetId, target: target.definition }).approvalRequiredByPolicy, targetId).toBe(targetId !== 'contextual_ui');
            const settings = ActionsSettingsV1Schema.parse({ v: 1,
                actions: { [actionId]: { approvalRequiredSurfaces: ['ui', 'agent', 'mcp'] } } });
            expect(getActionTargetApprovalPolicy({ settings, actionId, targetId,
                target: target.definition }).approvalRequiredByPolicy, `${targetId} explicit Ask`).toBe(true);
        }
    });
    it('exposes the foreign Session HTML policy beside the existing per-Action surface choices', () => {
        const entries = buildActionSettingsEntries({ query: '', settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: { executionRunsEnabled: true, memorySearchEnabled: true, voiceEnabled: true,
                sessionHandoffEnabled: true, voiceShareDeviceInventory: true },
        });
        for (const actionId of ['session.message.send', 'session.stop']) {
            expect(entries.find(entry => entry.actionId === actionId)?.targets.find(target =>
                String(target.id) === 'foreign_session_html')).toMatchObject({ selected: false, state: 'off' });
        }
    });
    it('lists Resource permissions in the same selected plugin policy view without executable Action targets', async () => {
        const { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
            installedPackagesById: { 'acme.preview': { id: 'acme.preview', displayName: 'Preview', enabled: true,
                source: { kind: 'localPath', locator: 'acme.preview' } } },
            resourcesById: { 'acme.preview/status': { id: 'status', pluginId: 'acme.preview', resourceKind: 'config',
                path: 'status.json', scope: 'global', digest: `sha256:${'a'.repeat(64)}`, contentType: 'application/json' } },
        });
        const contributedActions = buildActionSettingsContributedActions(
            adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection).pluginProjectionById,
        );
        const entries = buildActionSettingsEntries({ query: '', settings: DEFAULT_ACTIONS_SETTINGS_V1, contributedActions,
            availability: { executionRunsEnabled: true, memorySearchEnabled: true, voiceEnabled: true,
                sessionHandoffEnabled: true, voiceShareDeviceInventory: true },
        });
        const resource = entries.find(entry => entry.actionId === 'acme.preview/resources/status');
        expect(resource?.targets.map(target => target.id)).toEqual(['foreign_session_html']);
        expect(resource?.targets[0]).toMatchObject({ state: 'off', selected: false });
    });
    it('lists the Files and Editor program Actions with their declared audience approval defaults', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');
        const { resolveActionSettingsEntryStatusSummary } = await import('./resolveActionSettingsEntryStatusSummary');
        const settings = DEFAULT_ACTIONS_SETTINGS_V1;
        const entries = buildActionSettingsEntries({
            query: '', settings,
            availability: {
                executionRunsEnabled: true, memorySearchEnabled: true, voiceEnabled: true,
                sessionHandoffEnabled: true, voiceShareDeviceInventory: true,
            },
        });
        // Custody (`approval.result`) is not confirmation. Commit 02102e614e1 and
        // docs/actions.md separate own-UI automation approval from native confirmation.
        // Discard's HEAD/mixed native review remains covered by actionApprovalPolicy.test.ts;
        // Settings reports the automation default, which stays Ask for Agent/MCP.
        const defaults = [
            ['workspace.tabs.open', false, false],
            ['file.view.get', false, false],
            ['file.view.set', false, false],
            ['workspace.files.link.get', false, false],
            ['file.editor.save', false, true],
            ['file.editor.resolve', false, true],
            ['daemon.filesystem.writeFile', false, true],
            ['daemon.filesystem.rename', false, true],
            ['daemon.filesystem.readFile', false, false],
            ['scm.change.discard', false, true],
            ['scm.diffSummary.reviewed.mark', false, false],
            ['scm.diffSummary.reviewed.unmark', false, false],
            ['scm.file.read', false, false],
            ['shell.column.get', false, false],
            ['shell.column.set', false, false],
            ['code.definition.get', false, false],
            ['code.references.list', false, false],
            ['code.hover.get', false, false],
            ['code.symbols.list', false, false],
            ['code.diagnostics.list', false, false],
            ['code.restart', false, false],
            ['code.completion.list', false, false],
            ['code.signature.get', false, false],
            ['code.typeDefinition.get', false, false],
            ['code.implementation.get', false, false],
            ['code.symbols.workspace', false, false],
            ['code.callHierarchy.get', false, false],
            ['code.format.apply', false, true],
            ['code.imports.organize', false, true],
            ['workspace.files.replace.preview', false, false],
            ['workspace.files.replace', false, true],
            ['scm.blame.get', false, false],
        ] as const;
        for (const [id, uiApproval, automationApproval] of defaults) {
            const entry = entries.find((candidate) => candidate.actionId === id);
            expect.soft(entry?.kind, id).toBe('host');
            if (!entry) continue;
            const actionId = ActionIdSchema.parse(id);
            const audienceTargets = (['contextual_ui', 'agent', 'mcp'] as const).map((targetId) => {
                const target = entry.targets.find((candidate) => candidate.id === targetId);
                expect(target?.state, `${id}/${targetId}`).toBe('on');
                if (!target) throw new Error(`Missing ${id}/${targetId} audience`);
                return target;
            });
            for (const surface of ['ui', 'agent', 'mcp'] as const) {
                expect.soft(isApprovalRequiredByActionsSettings(actionId, settings, {
                    surface, authority: surface === 'ui' ? 'present_user' : 'account_automation',
                    ...(surface === 'ui' ? { actionCaller: { kind: 'host' as const } } : {}),
                }), `${id}/${surface}`).toBe(surface === 'ui' ? uiApproval : automationApproval);
            }
            expect.soft(resolveActionSettingsEntryStatusSummary({ settings, actionId, targets: audienceTargets }).audiences, id).toEqual([
                { audience: 'human', allowedCount: uiApproval ? 0 : 1, askFirstCount: uiApproval ? 1 : 0, offCount: 0 },
                { audience: 'agent', allowedCount: automationApproval ? 0 : 1, askFirstCount: automationApproval ? 1 : 0, offCount: 0 },
                { audience: 'integration', allowedCount: automationApproval ? 0 : 1, askFirstCount: automationApproval ? 1 : 0, offCount: 0 },
            ]);
        }
    });

    it('preserves GitHub mutation approval defaults through projection, waiver and reset', async () => {
        const { adaptDaemonContributionRegistryProjectionToMergedProjectionInputs } = await import('@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters');
        const { buildActionSettingsContributedActions, buildActionSettingsEntries } = await import('./buildActionSettingsEntries');
        const { resolveActionSettingsEntryStatusSummary } = await import('./resolveActionSettingsEntryStatusSummary');
        const { applyActionSettingsTargetControlState, resolveActionSettingsTargetControlState } = await import('./actionSettingsTargets');
        const pluginId = githubManifest.id;
        for (const localId of [
            'github/pull-request/merge',
            'github/pull-request/close',
            'github/pull-request/mark-ready',
        ] as const) {
            const declaration = githubManifest.contributes.actions?.find((action) => action.id === localId);
            if (!declaration) throw new Error(`GitHub Action ${localId} is not declared`);
            const dangerLevel = declaration.dangerLevel;
            // The daemon's strict Action projection omits execution-only grants and schemas.
            const { hostAccess, connectedAccountPurposeBindings, inputSchema, resultSchema, ...projectedDeclaration } = declaration;
            const projection = PluginProjectionV2Schema.parse({
                v: 2, generation: 1,
                installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'GitHub', enabled: true,
                    source: { kind: 'bundled', locator: '@happier-dev/plugin-scm-github' } } },
                actionsById: { [`${pluginId}/${localId}`]: {
                    ...projectedDeclaration, pluginId, occurrenceId: 'github-occurrence',
                } },
            });
            const inputs = adaptDaemonContributionRegistryProjectionToMergedProjectionInputs(projection);
            const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
            const actionId = `${pluginId}/actions/${localId}` as const;
            const entries = buildActionSettingsEntries({ query: '', settings, contributedActions:
                buildActionSettingsContributedActions(inputs.pluginProjectionById), availability: {
                    executionRunsEnabled: true, memorySearchEnabled: true, voiceEnabled: true,
                    sessionHandoffEnabled: true, voiceShareDeviceInventory: true,
                } });
            const entry = entries.find((candidate) => candidate.actionId === actionId);
            if (!entry) throw new Error('GitHub Action was not projected');
            expect(resolveActionSettingsEntryStatusSummary({ settings, actionId, targets: entry.targets })).toEqual({
                allowedCount: 1, askFirstCount: 5, offCount: 1, unavailableCount: 0,
                danger: dangerLevel === 'destructive' ? 'destructive' : 'external',
                audiences: [
                    { audience: 'human', allowedCount: 0, askFirstCount: 1, offCount: 0 },
                    { audience: 'agent', allowedCount: 0, askFirstCount: 1, offCount: 0 },
                    { audience: 'integration', allowedCount: 1, askFirstCount: 3, offCount: 1 },
                ],
            });
            for (const target of entry.targets) {
                const input = { actionId, targetId: target.id, target: target.definition };
                const required = target.id !== 'plugin';
                const foreign = target.id === 'foreign_session_html';
                expect(resolveActionSettingsTargetControlState({ ...input, settings })).toMatchObject({
                    kind: 'approval', value: foreign ? 'off' : 'default', approvalRequiredByPolicy: required,
                });
                const waived = applyActionSettingsTargetControlState({ ...input, settings, value: 'allowed' });
                expect(resolveActionSettingsTargetControlState({ ...input, settings: waived })).toMatchObject({
                    // Choosing the inherited answer restores Default rather than storing a redundant override.
                    value: required ? 'allowed' : 'default', approvalRequiredByPolicy: false,
                });
                const reset = applyActionSettingsTargetControlState({ ...input, settings: waived, value: 'default' });
                expect(resolveActionSettingsTargetControlState({ ...input, settings: reset })).toMatchObject({
                    value: foreign ? 'off' : 'default', approvalRequiredByPolicy: required,
                });
            }
        }
    });

    it('describes a built-in Action in the words its form shows people, not its agent instructions', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');
        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });
        const byId = new Map(entries.map((entry) => [entry.actionId, entry]));

        const createSession = byId.get('session.spawn_new');
        expect(createSession?.description).toBeTruthy();
        expect(createSession?.description).not.toContain('{kind:');
        for (const spec of listActionSpecs()) {
            const personFacing = spec.inputHints?.description;
            if (personFacing && byId.has(spec.id)) expect(byId.get(spec.id)?.description).toBe(personFacing);
        }
    });

    it('consumes one normalized settings document without reparsing it for every target', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');
        const normalized = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
        let versionReads = 0;
        const settings = new Proxy(normalized, {
            get(target, property, receiver) {
                if (property === 'v') versionReads += 1;
                return Reflect.get(target, property, receiver);
            },
        });

        const entries = buildActionSettingsEntries({
            query: '',
            settings,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        expect(entries.length).toBeGreaterThan(0);
        expect(versionReads).toBe(0);
    });

    it('marks inventory voice surfaces unavailable when device inventory sharing is disabled', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: false,
            },
        });

        expect(entries.some((entry) => entry.actionId === 'paths.list_recent')).toBe(true);

        const paths = entries.find((entry) => entry.actionId === 'paths.list_recent');
        expect(paths).toBeTruthy();

        const voicePanel = paths!.targets.find((target) => target.id === 'voice_panel');
        const voiceTool = paths!.targets.find((target) => target.id === 'voice');

        expect(voicePanel?.state).toBe('unavailable');
        expect(voicePanel?.reasonKey).toBe('settingsActions.reasons.voiceInventoryPrivacy');
        expect(voiceTool?.state).toBe('unavailable');
    });

    it('treats agent input chips as opt-in and MCP as off when explicitly disabled', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: ActionsSettingsV1Schema.parse({
                v: 1,
                actions: {
                    'review.start': {
                        enabledPlacements: ['agent_input_chips'],
                        disabledSurfaces: ['mcp'],
                        disabledPlacements: [],
                    },
                },
            }),
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const review = entries.find((entry) => entry.actionId === 'review.start');
        expect(review).toBeTruthy();

        const chips = review!.targets.find((target) => target.id === 'agent_input_chips');
        const mcp = review!.targets.find((target) => target.id === 'mcp');

        expect(chips?.state).toBe('on');
        expect(mcp?.state).toBe('off');
    });

    it('presents the direct-cut API and trusted-plugin surfaces for configurable host actions', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const review = entries.find((entry) => entry.actionId === 'review.start');
        expect(review?.targets.find((target) => target.id === 'api')).toMatchObject({ state: 'on' });
        expect(review?.targets.find((target) => target.id === 'plugin')).toMatchObject({ state: 'on' });
    });

    it('keeps present-user operations discoverable without pretending automation can execute them', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const approvalDecision = entries.find((entry) => entry.actionId === 'approval.request.decide');
        expect(approvalDecision).toBeTruthy();
        expect(approvalDecision?.targets.find((target) => target.id === 'api')).toMatchObject({ state: 'on' });
        expect(approvalDecision?.targets.find((target) => target.id === 'plugin')).toMatchObject({
                state: 'unavailable',
                reasonKey: 'settingsActions.reasons.presentUserRequired',
        });
        expect(approvalDecision?.targets.find((target) => target.id === 'contextual_ui')).toMatchObject({
            state: 'on',
        });
    });

    it('keeps an Inspector-shaped contributed action visible with API and trusted-plugin controls', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
            contributedActions: [{
                pluginId: 'happier.inspector',
                localId: 'self-check',
                title: 'Run Inspector self-check',
                description: 'Checks the Inspector plugin.',
                icon: 'sparkle',
                // `toolbar` is not an Action UI placement. The settings catalog must retain
                // the contributed row through its canonical broad-surface targets instead of
                // treating the unknown presentation binding as a reason to hide it.
                surfaces: ['ui'],
                placementBindings: ['toolbar'],
            }],
        });

        const contributed = entries.find((entry) => entry.actionId === 'happier.inspector/actions/self-check');
        expect(contributed).toMatchObject({
            kind: 'contributed',
            title: 'Run Inspector self-check',
            description: 'Checks the Inspector plugin.',
        });
        expect(contributed?.targets.find((target) => target.id === 'api')).toMatchObject({ state: 'on' });
        expect(contributed?.targets.find((target) => target.id === 'plugin')).toMatchObject({ state: 'on' });
        expect(contributed?.targets.find((target) => target.id === 'contextual_ui')).toMatchObject({ state: 'on' });
    });

    it('retains removed qualified actions while preserving current long contributed labels', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');
        const longTitle = 'Review action with a deliberately long, provider-authored presentation label that must not be truncated by the catalog owner';

        const entries = buildActionSettingsEntries({
            query: '',
            settings: ActionsSettingsV1Schema.parse({
                v: 1,
                actions: {
                    'com.acme.removed/actions/no-longer-installed': {
                        enabled: false,
                    },
                },
            }),
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
            contributedActions: [{
                pluginId: 'com.acme.review',
                localId: 'review/start',
                title: longTitle,
                description: null,
                icon: null,
                surfaces: [],
            }],
        });

        const current = entries.find((entry) => entry.actionId === 'com.acme.review/actions/review/start');
        expect(current).toMatchObject({
            kind: 'contributed',
            title: longTitle,
        });
        expect(current?.targets.find((target) => target.id === 'api')).toMatchObject({ state: 'on' });
        expect(current?.targets.find((target) => target.id === 'plugin')).toMatchObject({ state: 'on' });
        expect(entries.find((entry) => entry.actionId === 'com.acme.removed/actions/no-longer-installed')).toMatchObject({
            kind: 'retained',
            enabled: false,
            targets: [],
        });
    });

    it('exposes contextual ui for ui-button actions and supports tokenized translated target search', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const approvalEntries = buildActionSettingsEntries({
            query: 'approval',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const approval = approvalEntries.find((entry) => entry.actionId === 'approval.request.decide');
        expect(approval).toBeTruthy();
        expect(approval!.targets.some((target) => target.id === 'contextual_ui')).toBe(true);
        expect(approvalEntries.some((entry) => entry.actionId === 'review.start')).toBe(false);

        const sessionMenuEntries = buildActionSettingsEntries({
            query: 'palette global',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
            translate: (key) => {
                if (key === 'settingsActions.targets.command_palette.title') return 'Command palette';
                if (key === 'settingsActions.targets.command_palette.subtitle') return 'Visible in the global command palette.';
                return key;
            },
        });

        expect(sessionMenuEntries.length).toBeGreaterThan(0);
        expect(sessionMenuEntries.some((entry) => entry.targets.some((target) => target.id === 'command_palette'))).toBe(true);
    });

    it('exposes terminal composer clear through the pending-message placement', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const terminalComposerClear = entries.find((entry) => entry.actionId === 'session.terminalComposer.clear');
        expect(terminalComposerClear).toBeTruthy();
        expect(terminalComposerClear!.targets.some((target) => target.id === 'contextual_ui')).toBe(false);
        expect(terminalComposerClear!.targets.find((target) => target.id === 'pending_messages')).toMatchObject({
            id: 'pending_messages',
            state: 'on',
        });
    });

    it('surfaces the browser recording family once its real executor is enabled on ui/agent', async () => {
        // FINALIZATION-PLAN §3.2/§3.3 + BA-5: the whole browser recording family now routes through a
        // real executor (`RUNTIME_ACTION_REAL_EXECUTOR_*`) and is surfaced on `ui` + `agent`,
        // so each leaf becomes a configurable settings entry with a `agent` target. The
        // dangerous lifecycle leaves (`browser.recording.start`, classified `safety:'danger'`) keep an
        // approval-floored `agent` target per the consent floor.
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: 'browser recording',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const attachRecording = entries.find((entry) => entry.actionId === 'browser.recording.attachToComposer');
        expect(attachRecording).toBeTruthy();
        expect(attachRecording!.targets.some((target) => target.id === 'agent')).toBe(true);

        // `browser.recording.start` is now executor-backed and surfaced on `ui`/`agent`. As a
        // danger lifecycle leaf it carries a `agent` target governed by the agent approval
        // floor (it is not silently hidden anymore).
        const startRecording = entries.find((entry) => entry.actionId === 'browser.recording.start');
        expect(startRecording).toBeTruthy();
        expect(startRecording!.targets.some((target) => target.id === 'agent')).toBe(true);
    });

    it('marks run placements unavailable when this client does not surface them yet', async () => {
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const runListAction = entries.find((entry) => entry.actionId === 'execution.run.list');
        expect(runListAction).toBeTruthy();
        expect(runListAction!.targets.find((target) => target.id === 'run_list')).toMatchObject({
            id: 'run_list',
            state: 'unavailable',
            reasonKey: 'settingsActions.reasons.notAvailableInThisApp',
        });

        const runCardAction = entries.find((entry) => entry.actionId === 'execution.run.stop');
        expect(runCardAction).toBeTruthy();
        expect(runCardAction!.targets.find((target) => target.id === 'run_card')).toMatchObject({
            id: 'run_card',
            state: 'unavailable',
            reasonKey: 'settingsActions.reasons.notAvailableInThisApp',
        });
    });

    it('surfaces real-executor runtime families while hiding no-executor fail-closed contracts', async () => {
        // FINALIZATION-PLAN §3.2/§3.3: families with a real executor are surfaced on `ui`/
        // `agent` and become configurable; families with no executor stay fail-closed on
        // every surface and therefore have no settings target (hidden).
        const { buildActionSettingsEntries } = await import('./buildActionSettingsEntries');

        const entries = buildActionSettingsEntries({
            query: '',
            settings: DEFAULT_ACTIONS_SETTINGS_V1,
            availability: {
                executionRunsEnabled: true,
                memorySearchEnabled: true,
                voiceEnabled: true,
                sessionHandoffEnabled: true,
                voiceShareDeviceInventory: true,
            },
        });

        const isConfigurable = (actionId: string): boolean =>
            entries.some((entry) => entry.actionId === actionId);

        // Real executors → now configurable (with a agent target gated by the approval floor).
        expect(isConfigurable('browser.navigate')).toBe(true);
        expect(isConfigurable('localServices.publicPreview.create')).toBe(true);
        expect(isConfigurable('devices.simulator.input.tap')).toBe(true);
        for (const actionId of ['browser.navigate', 'localServices.publicPreview.create', 'devices.simulator.input.tap']) {
            const entry = entries.find((candidate) => candidate.actionId === actionId)!;
            expect(entry.targets.some((target) => target.id === 'agent')).toBe(true);
        }

        // browser.diagnostics.eval is now executor-backed (live sidecar CDP interaction transport,
        // DIAG-INTERACTION) → surfaced + configurable; its agent target stays approval-floored
        // (danger) per the consent floor. (browser.recording.start is likewise surfaced by its lane.)
        expect(isConfigurable('browser.diagnostics.eval')).toBe(true);
        expect(
            entries.find((candidate) => candidate.actionId === 'browser.diagnostics.eval')!.targets
                .some((target) => target.id === 'agent'),
        ).toBe(true);

        // No producer → still hidden (statically-unbacked / UNSURFACED on every surface).
        expect(isConfigurable('devices.simulator.input.orientation')).toBe(false);

        // No surfaced entry should ever have zero targets.
        expect(entries.some((entry) => entry.targets.length === 0)).toBe(false);
    });
});
