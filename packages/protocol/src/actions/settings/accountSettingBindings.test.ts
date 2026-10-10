import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { readPortableAccountSettingBindingV1 } from './accountSettingBindings.js';
import { prepareDefaultProviderStateSharingChangeV1, readProviderStateSharingRiskAgentIdsV1 } from './providerStateSharingMutations.js';

function binding(owner: string, ...options: string[]) {
    const result = readPortableAccountSettingBindingV1({ storage: { owner, options } });
    expect(result).not.toBeNull();
    return result!;
}

describe('portable coupled Account setting mutations', () => {
    it('prepares sharing through the portable owner and retires its replay with the captured context', async () => {
        const settings = accountSettingsParse({});
        const selected = binding('connectedServicesAgentSignIn.sharingState');
        expect('prepare' in selected).toBe(true);
        if (!('prepare' in selected) || typeof selected.prepare !== 'function') return;
        let current = true;
        const result = await selected.prepare(settings, false, {}, { isCurrent: () => current });
        expect(result.status).toBe('prepared');
        if (result.status !== 'prepared') return;
        expect(result.mutate(settings)?.connectedServicesProviderStateSharingSettingsV1.defaults.stateMode).toBe('isolated');
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
            'voice.agent': false, 'zen.navigation': true, custom: true,
        });
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
    it('preserves the inactive grouping and rejects a mixed folder sort in date ordering', () => {
        const settings = accountSettingsParse({ sessionListOrderingModeV1: 'updated', sessionListInactiveGroupingV1: 'date' });
        expect(binding('sessionListLayoutStorageBinding').mutate(settings, 'projects')).toEqual({ sessionListSectionModeV1: 'single', sessionListActiveGroupingV1: 'project' });
        expect(binding('listChoiceStorage', 'sessionListFolderSortModeV1', 'folderSort').mutate(settings, 'mixed')).toBeNull();
        expect(binding('listChoiceStorage', 'sessionListOrderingModeV1', 'ordering').parse('unknown').success).toBe(false);
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
