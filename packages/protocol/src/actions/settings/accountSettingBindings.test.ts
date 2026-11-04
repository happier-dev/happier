import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { readPortableAccountSettingBindingV1, scmBackendDefaultDiffStorage, scmGitRoutingStorage } from './accountSettingBindings.js';
import { prepareDefaultProviderStateSharingChangeV1, readProviderStateSharingRiskAgentIdsV1 } from './providerStateSharingMutations.js';
import { resolveUiFeatureToggleEnabled } from './featurePreferenceMutations.js';
import { readBuiltInSettingDeclarationV1, buildBuiltInAccountSettingMutationV1, parseBuiltInAccountSettingValueV1 } from './settingsDeclarations.js';

function binding(owner: string, ...options: string[]) {
    const result = readPortableAccountSettingBindingV1({ storage: { owner, options } });
    expect(result).not.toBeNull();
    return result!;
}

describe('portable coupled Account setting mutations', () => {
    it('writes one scalar layout and rejects the retired third layout', () => {
        const settings = accountSettingsParse({ sessionListLayoutV1: 'projects' });
        const declaration = readBuiltInSettingDeclarationV1('session.list.layout');
        expect(declaration).toBeDefined();
        if (!declaration) throw new Error('The canonical layout Action declaration must be present');
        expect(parseBuiltInAccountSettingValueV1(declaration, 'active_inactive')).toEqual({ success: false });
        expect(buildBuiltInAccountSettingMutationV1(declaration, settings, 'active_inactive')).toBeNull();
        const delta = buildBuiltInAccountSettingMutationV1(declaration, settings, 'recent_activity');
        expect(delta).toEqual({ sessionListLayoutV1: 'recent_activity' });
        expect(accountSettingsParse({ ...settings, ...delta }).sessionListLayoutV1).toBe('recent_activity');
        for (const anchor of ['session.layout', 'session.ordering', 'session.folderView', 'session.activeGrouping', 'session.attentionPromotion']) {
            expect(readBuiltInSettingDeclarationV1(anchor)).toBeNull();
        }
    });
    it.each(['collapsed', 'expanded'] as const)('rebases one %s tool detail choice and clears only its named override', kind => {
        const owner = binding('toolDetailOverrideStorage', kind);
        const key = kind === 'collapsed' ? 'toolViewDetailLevelByToolName' : 'toolViewExpandedDetailLevelByToolName';
        const before = accountSettingsParse({ toolViewDetailLevelByToolName: { Bash: 'summary', Read: 'summary' },
            toolViewExpandedDetailLevelByToolName: { Bash: 'summary', Read: 'summary' } });
        expect(owner.read(before)).toEqual({ Bash: 'summary', Read: 'summary' });
        const bash = { toolName: 'Bash', detailLevel: 'full' };
        expect(owner.parse(bash)).toEqual({ success: true, value: bash });
        const first = accountSettingsParse({ ...before, ...owner.mutate(before, bash) });
        const second = accountSettingsParse({ ...first, ...owner.mutate(first, { toolName: 'Read', detailLevel: 'full' }) });
        expect(second[key]).toEqual({ Bash: 'full', Read: 'full' });
        expect(owner.mutate(second, { toolName: 'Bash', detailLevel: 'default' })).toEqual({ [key]: { Read: 'full' } });
        const external = { toolName: 'mcp__acme__inspect', detailLevel: 'full' };
        expect(owner.parse(external)).toEqual({ success: true, value: external });
        for (const invalid of [{ Bash: 'full' }, { toolName: 1, detailLevel: 'full' },
            { toolName: 'Bash', detailLevel: 'unknown' }, { toolName: 'Bash', detailLevel: true },
            { toolName: 'Bash', detailLevel: 'full', extra: true }, { toolName: 'x'.repeat(1025), detailLevel: 'default' }]) {
            expect(owner.parse(invalid)).toEqual({ success: false });
        }
        if (kind === 'expanded') expect(owner.parse({ toolName: 'Bash', detailLevel: 'title' })).toEqual({ success: false });
    });
    it('admits external SCM routing and clears its qualified selection when choosing built-in Git', () => {
        const settings = accountSettingsParse({ scmGitRepoPreferredBackend: 'sapling', scmPushRejectPolicy: 'manual' });
        const external = scmGitRoutingStorage.parse('acme.scm/stacked');
        expect(external.success).toBe(true);
        if (!external.success) throw new Error('External SCM routing must be admitted');
        const selected = accountSettingsParse({ ...settings, ...scmGitRoutingStorage.mutate(settings, external.value) });
        expect(selected.scmGitRepoPreferredBackendQualifiedId).toBe('acme.scm/stacked');
        expect(scmGitRoutingStorage.read(selected)).toBe('acme.scm/stacked');
        const builtin = accountSettingsParse({ ...selected, ...scmGitRoutingStorage.mutate(selected, 'happier.scm.backend.git/git') });
        expect(builtin).toMatchObject({ scmGitRepoPreferredBackend: 'git', scmGitRepoPreferredBackendQualifiedId: null, scmPushRejectPolicy: 'manual' });
    });
    it('preserves an open backend id that matches an Object prototype property', () => {
        const settings = accountSettingsParse({ scmDefaultDiffModeByBackend: { neighbor: 'included' } });
        expect(scmBackendDefaultDiffStorage.mutate(settings, { backendId: 'constructor', mode: 'both' }))
            .toEqual({ scmDefaultDiffModeByBackend: { neighbor: 'included', constructor: 'both' } });
    });
    it.each(['git', 'happier.scm.backend.git/git'])('writes the canonical diff preference and removes its stale alias for %s', backendId => {
        const settings = accountSettingsParse({ scmDefaultDiffModeByBackend: {
            git: 'included', 'happier.scm.backend.git/git': 'pending', neighbor: 'both',
        } });
        const intent = scmBackendDefaultDiffStorage.parse({ backendId, mode: 'both' });
        expect(intent.success).toBe(true);
        if (!intent.success) throw new Error('Expected valid diff preference');
        const delta = scmBackendDefaultDiffStorage.mutate(settings, intent.value);
        expect(accountSettingsParse({ ...settings, ...delta }).scmDefaultDiffModeByBackend).toEqual({
            'happier.scm.backend.git/git': 'both', neighbor: 'both',
        });
    });
    it('prepares sharing through the portable owner and retires its replay with the captured context', async () => {
        const settings = accountSettingsParse({});
        const selected = binding('connectedServicesAgentSignIn.sharingState');
        expect('prepare' in selected).toBe(true);
        if (!('prepare' in selected) || typeof selected.prepare !== 'function') return;
        let current = true;
        const result = await selected.prepare(settings, false, {}, { isCurrent: () => current });
        expect(result.status).toBe('prepared');
        if (result.status !== 'prepared') return;
        expect(result.mutate(settings)?.connectedServicesProviderStateSharingSettingsV1?.defaults.stateMode).toBe('isolated');
        current = false;
        expect(result.mutate(settings)).toBeNull();
    });
    it('allows isolated state and preacknowledged sharing without manufacturing new consent', async () => {
        const current = accountSettingsParse({}).connectedServicesProviderStateSharingSettingsV1;
        const isolated = await prepareDefaultProviderStateSharingChangeV1(current, false, {});
        expect(isolated.status).toBe('prepared');
        if (isolated.status === 'prepared') expect(isolated.mutate(current)?.defaults.stateMode).toBe('isolated');
        const services = { readProviderStateSharingRiskAgentIds: () => ['codex'] };
        expect(await prepareDefaultProviderStateSharingChangeV1(current, true, services)).toEqual({ status: 'confirmation_required', agentIds: ['codex'] });
        const acknowledged = { ...current, acknowledgedRisksByAgentId: { codex: { sharedStatePrivacy: true as const } } };
        const shared = await prepareDefaultProviderStateSharingChangeV1(acknowledged, true, services);
        expect(shared.status).toBe('prepared');
        if (shared.status === 'prepared') expect(shared.mutate(acknowledged)?.defaults.stateMode).toBe('shared');
    });
    it('preserves CAS siblings after named risk consent and refuses a newly unacknowledged catalog risk', async () => {
        const current = accountSettingsParse({}).connectedServicesProviderStateSharingSettingsV1;
        let agents = [{ agentId: 'codex', capability: { state: { supported: true, modes: ['shared'], sharedStatePrivacyRiskAcknowledgementRequired: true } } }];
        let consented: readonly string[] = [];
        const prepared = await prepareDefaultProviderStateSharingChangeV1(current, true, {
            readProviderStateSharingRiskAgentIds: () => readProviderStateSharingRiskAgentIdsV1(agents),
            confirmProviderStateSharingRiskAgents: async ids => { consented = ids; return true; },
        });
        expect(consented).toEqual(['codex']);
        expect(prepared.status).toBe('prepared');
        if (prepared.status !== 'prepared') return;
        const latest = { ...current, defaults: { ...current.defaults, configMode: 'copied' as const },
            acknowledgedRisksByAgentId: { claude: { sharedStatePrivacy: true as const } } };
        expect(prepared.mutate(latest)).toEqual({ ...latest, defaults: { ...latest.defaults, stateMode: 'shared' },
            acknowledgedRisksByAgentId: { ...latest.acknowledgedRisksByAgentId, codex: { sharedStatePrivacy: true } } });
        agents = [...agents, { agentId: 'new-agent', capability: { state: { supported: true, modes: ['shared'], sharedStatePrivacyRiskAcknowledgementRequired: true } } }];
        expect(prepared.mutate(latest)).toBeNull();
    });
    it('preserves per-machine routing and profile favorites when editing account choices', () => {
        const settings = accountSettingsParse({ favoriteProfiles: ['work', '', 'personal'], peerMediationPreferencesV1: {
            v: 1, flows: {}, byMachineId: { laptop: { flows: { machine_rpc: { direct: 'enabled' } } } },
        } });
        const direct = binding('account.directConnections');
        expect(settings.peerMediationPreferencesV1.byMachineId.laptop?.flows.machine_rpc?.direct).toBe('enabled');
        expect(direct.mutate(settings, false)?.peerMediationPreferencesV1?.byMachineId).toEqual(settings.peerMediationPreferencesV1.byMachineId);
        expect(direct.parse('false').success).toBe(false);
        expect(binding('profiles.defaultEnvironment.showFirst').mutate(settings, true)).toEqual({ favoriteProfiles: ['work', 'personal', ''] });
    });
    it('seeds experiment defaults and cascades feature disables without discarding unrelated preferences', () => {
        const settings = accountSettingsParse({ featureToggles: { 'voice.agent': true, 'voice.daemonInference': true, custom: true } });
        expect(binding('featureToggle', 'voice').mutate(settings, false)?.featureToggles).toMatchObject({
            voice: false, 'voice.agent': false, 'voice.daemonInference': false, custom: true,
        });
        expect(binding('features.experimentalFeatures').mutate(settings, true)?.featureToggles).toMatchObject({
            'voice.agent': true, 'voice.daemonInference': true, 'zen.navigation': true, custom: true,
        });
    });
    it('leaves autonomous exchange transport support to the Home rather than an Account experiment toggle', () => {
        const settings = accountSettingsParse({ experiments: false });
        expect(resolveUiFeatureToggleEnabled(settings, 'sessions.autonomousExchange')).toBe(true);
        expect(readPortableAccountSettingBindingV1({ storage: {
            owner: 'featureToggle', options: ['sessions.autonomousExchange'],
        } })).toBeNull();
    });
    it.each(['voice.agent', 'voice.daemonInference'] as const)('defaults %s on and preserves explicit choices across Experiments changes', featureId => {
        const initial = accountSettingsParse({});
        expect(binding('featureToggle', featureId).read(initial)).toBe(true);
        for (const enabled of [false, true]) {
            const settings = accountSettingsParse({ featureToggles: { [featureId]: enabled, custom: true } });
            for (const experiments of [false, true]) {
                const changed = accountSettingsParse({ ...settings, ...binding('features.experimentalFeatures').mutate(settings, experiments) });
                expect(changed.featureToggles[featureId]).toBe(enabled);
                expect(changed.featureToggles.custom).toBe(true);
                expect(resolveUiFeatureToggleEnabled(changed, featureId)).toBe(enabled);
            }
        }
    });
    it('preserves custom glass opacity and solid surfaces when changing intensity', () => {
        const settings = accountSettingsParse({ glassBlurEnabled: true, glassSurfaceMaterials: {
            chrome: { blur: 'light', opacity: 0.3 }, sidebar: { blur: 'off', opacity: 1 },
            content: { blur: 'regular', opacity: 0.7 }, floating: { blur: 'strong', opacity: 0.2 },
        } });
        const glass = binding('glassIntensityStorageBinding');
        const delta = glass.mutate(settings, 'strong');
        expect(delta?.glassSurfaceMaterials?.chrome).toEqual({ blur: 'strong', opacity: 0.3 });
        expect(delta?.glassSurfaceMaterials?.sidebar).toEqual({ blur: 'off', opacity: 1 });
        expect(glass.parse('opaque').success).toBe(false);
    });
    it('updates the command palette pair and preserves another command override', () => {
        const settings = accountSettingsParse({ keyboardShortcutOverridesV1: { 'composer.focus': [{ binding: 'Alt+J' }] } });
        const command = binding('commandStorage', 'commandPalette.open');
        const delta = command.mutate(settings, { enabled: false, binding: 'Mod+P' });
        expect(delta?.commandPaletteEnabled).toBe(false);
        expect(delta?.keyboardShortcutOverridesV1).toEqual({ 'composer.focus': [{ binding: 'Alt+J' }], 'commandPalette.open': [{ binding: 'Mod+P' }] });
        expect(command.parse({ enabled: true, binding: 'Mod+', unknown: true }).success).toBe(false);
        expect(command.parse({ enabled: true, binding: 'Mod+' }).success).toBe(false);
    });
    it('toggles a command without rewriting its multiple platform-qualified bindings', () => {
        const settings = accountSettingsParse({ keyboardShortcutOverridesV1: {
            'commandPalette.open': [{ binding: 'Mod+K', platforms: ['macos'], allowInEditable: true },
                { binding: 'Ctrl+P', platforms: ['windows'], blockedSurfaces: ['native'] }],
            'composer.focus': [{ binding: 'Alt+J' }],
        } });
        const command = binding('commandStorage', 'commandPalette.open');
        const intent = command.parse({ enabled: false });
        expect(intent.success).toBe(true);
        if (!intent.success) throw new Error('Command toggles must not require a binding change');
        const delta = command.mutate(settings, intent.value);
        expect(accountSettingsParse({ ...settings, ...delta })).toMatchObject({ commandPaletteEnabled: false,
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open'],
            keyboardShortcutOverridesV1: settings.keyboardShortcutOverridesV1,
        });
        expect(delta?.keyboardShortcutOverridesV1).toBeUndefined();
        const reset = command.mutate(settings, { enabled: true, binding: null });
        expect(reset?.keyboardShortcutOverridesV1).toEqual({ 'composer.focus': [{ binding: 'Alt+J' }] });
        expect(command.parse({ enabled: true, unsupported: true }).success).toBe(false);
    });
    it('resets one retention category without accepting an absolute allocation deadline', () => {
        const settings = accountSettingsParse({ machineRetentionDefaultsV1: { v: 1,
            local: { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
            unknown: { retention: { kind: 'unused', afterMs: 60000, effect: 'stop' }, wakeOnAcceptedMessage: true },
        } });
        const retention = binding('categoryBinding', 'local');
        expect(retention.mutate(settings, null)?.machineRetentionDefaultsV1).toEqual({ v: 1, unknown: settings.machineRetentionDefaultsV1.unknown });
        expect(retention.parse({ retention: { kind: 'deadline', at: 100, effect: 'stop', interrupts: true }, wakeOnAcceptedMessage: false }).success).toBe(false);
    });
    it('retains shared-state choices when editing config and never bypasses consent', () => {
        const initial = accountSettingsParse({});
        const sharing = initial.connectedServicesProviderStateSharingSettingsV1;
        const settings = { ...initial, connectedServicesProviderStateSharingSettingsV1: {
            ...sharing, defaults: { ...sharing.defaults, stateMode: 'shared' as const },
        } };
        const config = binding('connectedServicesAgentSignIn.sharingConfig');
        expect(config.mutate(settings, 'copied')?.connectedServicesProviderStateSharingSettingsV1).toEqual({
            ...settings.connectedServicesProviderStateSharingSettingsV1,
            defaults: { ...settings.connectedServicesProviderStateSharingSettingsV1.defaults, configMode: 'copied' },
        });
        expect(binding('connectedServicesAgentSignIn.sharingState').mutate(settings, true)).toBeNull();
    });
    it('writes both terminal host projections and enforces the canonical agent-id string boundary', () => {
        const settings = accountSettingsParse({ sessionTerminalHost: 'legacy', sessionUseTmux: true });
        expect(binding('terminalHostStorage').read(settings)).toBe('tmux');
        expect(binding('terminalHostStorage').mutate(settings, 'zellij')).toEqual({ sessionTerminalHost: 'zellij', sessionUseTmux: false });
        expect(binding('sourceControl.commitMessageAgent').parse('x'.repeat(257)).success).toBe(false);
    });
    it('keeps sibling prompt and recovery settings while editing their boolean controls', () => {
        const settings = accountSettingsParse({ codingPromptBehaviorV1: { responseOptions: 'agent', sessionTitleUpdates: 'initial' },
            usageLimitRecoverySettingsV1: { resumePromptMode: 'custom', customResumePrompt: 'Keep checking this job.' } });
        expect(settings.codingPromptBehaviorV1.sessionTitleUpdates).toBe('initial');
        expect(settings.usageLimitRecoverySettingsV1.customResumePrompt).toBe('Keep checking this job.');
        const response = binding('responseOptionsStorage');
        const delta = response.mutate(settings, false);
        expect(delta?.codingPromptBehaviorV1).toEqual({ ...settings.codingPromptBehaviorV1, responseOptions: 'disabled' });
        const recovery = binding('autoWaitStorage');
        expect(recovery.mutate(settings, true)?.usageLimitRecoverySettingsV1).toEqual({ ...settings.usageLimitRecoverySettingsV1, mode: 'auto_wait' });
        expect(recovery.parse('true').success).toBe(false);
    });
    it('keeps the other remote confirmation choice and rejects invalid input', () => {
        const settings = accountSettingsParse({ scmRemoteConfirmPolicy: 'push_only' });
        const pull = binding('remoteConfirmationStorage', 'pull');
        expect(pull.read(settings)).toBe(false);
        expect(pull.mutate(settings, true)).toEqual({ scmRemoteConfirmPolicy: 'always' });
        expect(pull.parse(1).success).toBe(false);
    });
    it('preserves hidden inline presentation and wizard siblings', () => {
        const settings = accountSettingsParse({ sessionThinkingInlinePresentation: 'full', newSessionWizardSectionPresentationV1: { machines: 'dropdown', models: 'list' } });
        expect(binding('thinkingDisplayStorageBinding').mutate(settings, 'hidden')).toEqual({ sessionThinkingDisplayMode: 'hidden' });
        expect(binding('presentationStorage', 'models').mutate(settings, 'auto')).toEqual({ newSessionWizardSectionPresentationV1: { machines: 'dropdown' } });
        expect(binding('thinkingDisplayStorageBinding').parse('inline').success).toBe(false);
    });
    it('replaces predecessor grouping intent and retires its mutation bindings', () => {
        const settings = accountSettingsParse({ sessionListOrderingModeV1: 'updated', sessionListInactiveGroupingV1: 'date' });
        const declaration = readBuiltInSettingDeclarationV1('session.list.layout');
        expect(declaration).not.toBeNull();
        if (!declaration) throw new Error('Missing canonical layout declaration');
        expect(buildBuiltInAccountSettingMutationV1(declaration, settings, 'projects')).toEqual({ sessionListLayoutV1: 'projects' });
        expect(readPortableAccountSettingBindingV1({ storage: { owner: 'sessionListLayoutStorageBinding' } })).toBeNull();
        expect(readPortableAccountSettingBindingV1({ storage: { owner: 'listChoiceStorage', options: ['sessionListFolderSortModeV1', 'folderSort'] } })).toBeNull();
    });
    it('normalizes gauge choice without rewriting the predecessor field', () => {
        const settings = accountSettingsParse({ sessionProviderUsageGaugeWindowMode: 'weekly' });
        const gauge = binding('gaugeWindowStorage');
        expect(gauge.read(settings)).toEqual(['weekly']);
        expect(gauge.parse(['daily', 'daily'])).toEqual({ success: true, value: ['daily'] });
        expect(gauge.mutate(settings, ['daily'])).toEqual({ sessionProviderUsageGaugeWindowModes: ['daily'] });
    });
    it('edits paired notification event leaves and keeps unrelated sounds and channels', () => {
        const initial = accountSettingsParse({});
        const push = initial.attentionDeliveryPolicyV1.channels.expo_push;
        const settings = { ...initial, attentionDeliveryPolicyV1: { ...initial.attentionDeliveryPolicyV1,
            channels: { ...initial.attentionDeliveryPolicyV1.channels, expo_push: { ...push,
                events: { ...push.events, permission_request: { ...push.events.permission_request, enabled: false } },
            } },
        } };
        const policy = settings.attentionDeliveryPolicyV1;
        const ready = binding('accountNotificationStorageBinding', 'ready');
        const edited = ready.mutate(settings, false)?.attentionDeliveryPolicyV1;
        expect(edited?.events.ready.enabled).toBe(false);
        expect(edited?.channels.expo_push.events.ready.enabled).toBe(false);
        expect(edited?.channels.expo_push.events.permission_request).toEqual(policy.channels.expo_push.events.permission_request);
        expect(edited?.sounds).toEqual(policy.sounds);
        expect(ready.parse('false').success).toBe(false);
        expect(binding('accountNotificationStorageBinding', 'quietHours').parse('custom').success).toBe(false);
    });
    it('updates only the account-wide pace target while preserving per-meter targets', () => {
        const settings = accountSettingsParse({ usagePacingTargetsV1: [
            { id: 'specific', scope: { kind: 'personal' }, meterId: 'requests', utilizationFraction: 0.8 },
            { id: 'personal', scope: { kind: 'personal' }, utilizationFraction: 0.5 },
        ] });
        const pace = binding('personalPaceTargetStorage');
        expect(pace.mutate(settings, null)?.usagePacingTargetsV1).toEqual([settings.usagePacingTargetsV1[0]]);
        expect(pace.parse(-1).success).toBe(false);
    });
});
