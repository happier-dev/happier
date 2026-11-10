import { describe, expect, it } from 'vitest';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../settings/actions.js';
import { administerTriageAction, readTriageActionsForSurface } from './actionsCatalog.js';
import { TriageAdministerActionInputV1Schema } from './actionsCatalogProtocol.js';
import { runTriageConfiguredHandoffV1 } from '../sessions/configuredActionRun.js';
import { TriageSessionHandoffInputV1Schema, TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';
import type { PluginUiNewSessionSeedV1 } from '@happier-dev/plugin-sdk/ui';
import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import { testkitEntryRef, testkitLocator } from '../corpus/testkit/observations.test-support.js';

// Host Actions and Account KV are genuine plugin/host persistence boundaries.
// The catalog parser, mutation policy and default-save orchestration remain real.
function fixture() {
    const kv = createTestkitAccountKv();
    const documents = new Map<string, { title: string; markdown: string }>();
    const profiles = new Map<string, Record<string, unknown>>([['shared', { v: 2, id: 'shared', name: 'Shared',
        extraEnvironmentVariables: [{ name: 'FLAVOR', value: 'retained' }], defaultPermissionModeByTargetKey: {},
        defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1 }]]);
    const invocations = new Map<string, Record<string, unknown>>();
    let serial = 0;
    const execute = async (id: string, raw: Record<string, unknown>) => {
        if (id === 'prompt_doc.create') {
            const artifactId = `doc-${++serial}`;
            documents.set(artifactId, raw as { title: string; markdown: string });
            return { ok: true, artifactId };
        }
        if (id === 'prompt_doc.get') return { ok: true, artifactId: raw.artifactId,
            ...documents.get(String(raw.artifactId)), revision: { headerVersion: 1, bodyVersion: 1 } };
        if (id === 'prompt_doc.update') { documents.set(String(raw.artifactId), raw as { title: string; markdown: string });
            return { ok: true, artifactId: raw.artifactId }; }
        if (id === 'prompts.invocation.create') {
            const invocationId = `invocation-${++serial}`;
            invocations.set(invocationId, raw);
            return { status: 'updated', invocationId, token: raw.token, revision: 1 };
        }
        if (id === 'launch_profiles.read') {
            const profile = profiles.get(String(raw.id));
            return profile ? { status: 'present', profile, revision: 1, location: { kind: 'account_row', revision: 1 } }
                : { status: 'invalid', reason: 'profile-not-found' };
        }
        if (id === 'launch_profiles.duplicate') {
            const source = profiles.get(String(raw.id));
            if (!source) return { status: 'invalid', reason: 'profile-not-found' };
            const profile = { ...source, id: raw.newProfileId, name: raw.name,
                ...(raw.placement === undefined ? {} : { placement: raw.placement }),
                ...(raw.checkout === undefined ? {} : { checkout: raw.checkout }) };
            profiles.set(String(profile.id), profile);
            return { status: 'updated', id: profile.id, revision: 1 };
        }
        if (id === 'launch_profiles.create' || id === 'launch_profiles.save') {
            const profile = raw.profile as Record<string, unknown>;
            profiles.set(String(profile.id), profile);
            return { status: 'updated', id: profile.id, revision: 1 };
        }
        throw new Error(`Unexpected host Action ${id}`);
    };
    return { documents, profiles, invocations, deps: {
        catalog: kv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1), mintActionId: () => `owned-${++serial}`,
        actions: { execute } as unknown as ActionsService,
    } };
}

describe('Save as this action’s default', () => {
    it('copies shared defaults once and reuses action-owned prompt/profile on the next save and launch', async () => {
        const f = fixture();
        const catalog = await readTriageActionsForSurface({ v: 1 }, f.deps);
        const source = catalog.actions.find(action => action.actionId === 'fix')!;
        f.documents.set('shared-prompt', { title: 'Shared instructions', markdown: 'Keep this shared prompt.' });
        f.invocations.set('shared-invocation', { target: { kind: 'doc', artifactId: 'shared-prompt' } });
        expect(await administerTriageAction({ v: 1, kind: 'update', expectedRevision: catalog.revision,
            actionId: source.actionId, label: source.label, enabled: source.enabled,
            appliesTo: source.appliesTo, profileId: source.profileId,
            workspaceMode: 'reference_only', target: { ...source.target, promptInvocationId: 'shared-invocation' } }, f.deps))
            .toMatchObject({ status: 'applied' });
        const input = TriageAdministerActionInputV1Schema.parse({ v: 1, kind: 'saveDefaults', actionId: 'fix',
            label: 'Repair carefully', promptText: 'Fix this with a regression test.', profileId: 'shared',
            placement: { fixed: { serverId: 'home', machineId: 'machine' }, directory: '/work' },
            checkout: 'create_worktree', launchMode: 'start' });
        if (input.kind !== 'saveDefaults') throw new Error('Expected composer defaults input');
        expect(await administerTriageAction(input, f.deps)).toMatchObject({ status: 'applied' });
        const first = (await readTriageActionsForSurface({ v: 1 }, f.deps)).actions.find(a => a.actionId === 'fix')!;
        expect(first).toMatchObject({ label: 'Repair carefully', target: { kind: 'agent', delivery: 'send' } });
        expect(first.profileId).not.toBe('shared');
        expect(f.profiles.get(first.profileId!)).toMatchObject({ placement: input.placement, checkout: 'create_worktree',
            extraEnvironmentVariables: [{ name: 'FLAVOR', value: 'retained' }] });
        expect(f.profiles.get('shared')).not.toHaveProperty('placement');
        expect([...f.documents.entries()].find(([id]) => id !== 'shared-prompt')?.[1].markdown).toBe(input.promptText);
        expect(f.documents.get('shared-prompt')?.markdown).toBe('Keep this shared prompt.');
        expect(f.invocations.has(first.target.promptInvocationId!)).toBe(true);
        expect(first.target.promptInvocationId).not.toBe('shared-invocation');

        expect(await administerTriageAction({ ...input, promptText: 'Explain the repair.', profileId: first.profileId,
            placement: { fixed: { serverId: 'home', machineId: 'machine' }, directoryIntent: { kind: 'managed' } },
            checkout: 'reuse_workspace', launchMode: 'review' }, f.deps)).toMatchObject({ status: 'applied' });
        const next = (await readTriageActionsForSurface({ v: 1 }, f.deps)).actions.find(a => a.actionId === 'fix')!;
        expect(next.profileId).toBe(first.profileId);
        expect(next.target).toMatchObject({ promptInvocationId: first.target.promptInvocationId, delivery: 'compose' });
        expect(f.documents.size).toBe(2);
        expect(f.invocations.size).toBe(2);
        expect([...f.documents.entries()].find(([id]) => id !== 'shared-prompt')?.[1].markdown).toBe('Explain the repair.');
        expect(f.documents.get('shared-prompt')?.markdown).toBe('Keep this shared prompt.');
        expect(f.profiles.get(first.profileId!)).toMatchObject({ checkout: 'reuse_workspace',
            placement: { fixed: { serverId: 'home', machineId: 'machine' }, directoryIntent: { kind: 'managed' } } });

        const seeds: PluginUiNewSessionSeedV1[] = [];
        const host = {
            version: () => ({ methods: ['openNewSession'] }),
            context: async () => ({ accountScope: { serverId: 'home', accountId: 'account-a' } }),
            openNewSession: async (seed: PluginUiNewSessionSeedV1) => { seeds.push(seed); },
            executeAction: async (id: string | PluginContributionRef, raw: JsonValue) => {
                if (typeof id !== 'string' && id.pluginId === TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1.pluginId
                    && id.localId === TRIAGE_READ_SESSION_HANDOFF_CHOICES_ACTION_REF_V1.localId) {
                    return readTriageActionsForSurface({ v: 1 }, f.deps);
                }
                if (id === 'sessions.spawn.profiles.list') return { items: [...f.profiles.values()] };
                if (id === 'prompts.invocation.resolve') {
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Expected invocation input');
                    const invocation = f.invocations.get(String(raw.invocationId));
                    const target = invocation?.target;
                    if (!target || typeof target !== 'object' || !('artifactId' in target)) return { status: 'unknownInvocation' };
                    return { status: 'resolved', text: f.documents.get(String(target.artifactId))?.markdown };
                }
                if (id === 'localServices.launcher.snapshot') return { v: 1, machineId: 'machine', updatedAt: 1, targets: [] };
                if (id === 'projects.list') return { items: [], truncated: false };
                throw new Error(`Unexpected next-launch Action ${JSON.stringify(id)}`);
            },
        };
        const entry = { key: 'saved-default-entry', entryRef: testkitEntryRef(),
            display: { locator: testkitLocator(), scopeLabel: 'example/repository' },
            sourceInstance: { source: testkitEntryRef().source, sourceInstanceId: '11111111-1111-4111-8111-111111111111' },
            presentation: { label: 'Repair the issue' }, workflowSubject: 'issue' as const };
        const selected = { entryRef: entry.entryRef, sourceInstanceId: entry.sourceInstance.sourceInstanceId };
        const handoff = TriageSessionHandoffInputV1Schema.parse({ task: 'fix', configuredActionId: 'fix',
            context: { kind: 'entry', entry: selected }, evidence: [{ kind: 'entry', entry: selected }],
            sessionChoice: { kind: 'new' }, agentChoice: { kind: 'configured' }, delivery: 'configured' });
        const launched = await runTriageConfiguredHandoffV1(host as unknown as Parameters<typeof runTriageConfiguredHandoffV1>[0],
            handoff, { entries: [entry], signal: new AbortController().signal });
        expect(launched.handoff).toEqual({ kind: 'composed', destination: { kind: 'newSessionDraft' } });
        expect(seeds).toEqual([expect.objectContaining({ prompt: 'Explain the repair.', profileId: first.profileId,
            directoryIntent: { kind: 'managed' },
            actionDefault: { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, configuredActionId: 'fix', label: 'Repair carefully', launchMode: 'review' } })]);
    });

    it('does not report a successful catalog save when a host default write fails', async () => {
        const f = fixture();
        const input = TriageAdministerActionInputV1Schema.parse({ v: 1, kind: 'saveDefaults', actionId: 'fix',
            label: 'Repair', promptText: 'Fix it.', profileId: null, placement: 'ask', checkout: 'ask', launchMode: 'review' });
        if (input.kind !== 'saveDefaults') throw new Error('Expected composer defaults input');
        f.deps.actions = { execute: async () => { throw new Error('storage_disconnected'); } } as unknown as ActionsService;
        await expect(administerTriageAction(input, f.deps)).rejects.toThrow('storage_disconnected');
        expect((await readTriageActionsForSurface({ v: 1 }, f.deps)).availability).toBe('absent');
    });

    it.each(['repository', 'pull_request'] as const)('rejects managed no-folder defaults that conflict with %s preparation before changing host records', async workspaceMode => {
        const f = fixture();
        const catalog = await readTriageActionsForSurface({ v: 1 }, f.deps);
        const source = catalog.actions.find(action => action.actionId === 'fix')!;
        expect(await administerTriageAction({ v: 1, kind: 'update', expectedRevision: catalog.revision,
            actionId: source.actionId, label: source.label, enabled: source.enabled,
            appliesTo: source.appliesTo, profileId: source.profileId, workspaceMode, target: source.target }, f.deps))
            .toMatchObject({ status: 'applied' });
        const input = TriageAdministerActionInputV1Schema.parse({ v: 1, kind: 'saveDefaults', actionId: 'fix',
            label: 'Repair', promptText: 'Fix it.', profileId: 'shared',
            placement: { fixed: { serverId: 'home', machineId: 'machine' }, directoryIntent: { kind: 'managed' } },
            checkout: 'reuse_workspace', launchMode: 'review' });
        expect(await administerTriageAction(input, f.deps)).toMatchObject({ status: 'rejected', reason: 'workspaceMode' });
        expect(f.documents.size).toBe(0);
        expect(f.invocations.size).toBe(0);
        expect([...f.profiles.keys()]).toEqual(['shared']);
        expect((await readTriageActionsForSurface({ v: 1 }, f.deps)).actions.find(action => action.actionId === 'fix'))
            .toMatchObject({ label: source.label, workspaceMode, profileId: source.profileId });
    });
});
