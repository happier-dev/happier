import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectSessionDefaultsV1 } from '@happier-dev/protocol/projects/projectSessionDefaultsV1';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { withConnectedService, withModel, withPermissionMode, withPlacement } from '@/components/settings/teams/defaults/memberDefaults';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import { useProjectSessionDefaultsSectionAdapter, type ProjectSessionDefaultsSectionInput } from './useProjectSessionDefaultsSectionAdapter';

afterEach(standardCleanup);

const agent = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
const placement = { kind: 'machine', target: { serverId: 'home-a', machineId: 'machine-a' } } as const;

describe('project defaults whole-editor adapter', () => {
    it('projects the next inherited scope through the defaults resolver', async () => {
        const input: ProjectSessionDefaultsSectionInput = { defaults: { placement }, save: async () => {}, scope: 'personal-project',
            teamName: 'Acme', source: { id: 'source-a', revision: 1, name: 'acme/web' }, projectName: 'local alias',
            context: { personalProjectDefaults: { placement },
                projectDefaults: { placement: { kind: 'machine' as const, target: { serverId: 'home-a', machineId: 'project-machine' } } },
                memberDefaults: { placement: { kind: 'machine' as const, target: { serverId: 'home-a', machineId: 'member-machine' } } } } };
        const hook = await renderHook(useProjectSessionDefaultsSectionAdapter, { initialProps: input });
        expect(hook.getCurrent()).toMatchObject({ inheritance: { placement: {
            source: 'project', value: { kind: 'machine', target: { machineId: 'project-machine' } },
            names: { teamName: 'Acme', projectName: 'acme/web' },
        } } });
        await hook.rerender({ ...input, scope: 'project' });
        expect(hook.getCurrent().inheritance.placement).toMatchObject({
            source: 'member', value: { target: { machineId: 'member-machine' } },
        });
    });

    it('keeps explicit Automatic and native service picks while clearing fields reveals their own inherited decisions', async () => {
        const key = 'agent:happier.agent.claude/claude';
        const automatic = { v: 2, updatedAt: 1, ref: { source: 'native', agentTargetKey: key, modelId: 'default' } } as const;
        const binding = { purpose: { consumer: agent.identity, purpose: 'auth' }, service: { pluginId: 'happier.agent.claude', localId: 'claude' }, target: null, teamResource: null };
        const defaults: ProjectSessionDefaultsV1 = { defaultAgentTarget: agent, placement,
            permissionModeByAgentTargetKey: { [key]: 'safe-yolo' }, modelByAgentTargetKey: { [key]: automatic },
            connectedServicesByAgentTargetKey: { [key]: [binding] } };
        const writes: (ProjectSessionDefaultsV1 | null)[] = [];
        const hook = await renderHook(() => useProjectSessionDefaultsSectionAdapter({ defaults,
            save: async next => { writes.push(next); }, scope: 'personal-project', context: {
                personalProjectDefaults: defaults,
                projectDefaults: { defaultAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
                    permissionModeByAgentTargetKey: { [key]: 'read-only' }, modelByAgentTargetKey: { [key]: automatic },
                    connectedServicesByAgentTargetKey: { [key]: [binding] } },
                policyDefaults: { locked: true, organization: 'Acme', values: { permissionModeByAgentTargetKey: { [key]: 'plan' } } },
            } }));
        const inherited = hook.getCurrent().inheritance.forAgent(agent);
        expect(inherited.model).toMatchObject({ source: 'project', value: automatic });
        expect(inherited.permissionMode).toMatchObject({ source: 'policy', value: 'plan', lock: { organization: 'Acme' } });
        expect(inherited.connectedServices).toMatchObject([{ source: 'project', value: binding }]);
        await act(async () => { hook.getCurrent().save(withModel({}, key, automatic)); });
        expect(writes.at(-1)).toEqual({ modelByAgentTargetKey: { [key]: automatic } });
        await act(async () => { hook.getCurrent().save(withModel(defaults, key, undefined)); });
        expect(writes.at(-1)).not.toHaveProperty('modelByAgentTargetKey');
        expect(writes.at(-1)).toMatchObject({ defaultAgentTarget: agent, placement,
            connectedServicesByAgentTargetKey: { [key]: [binding] } });
        await act(async () => { hook.getCurrent().save(withConnectedService({}, key, qualifiedPurposeKey(binding.purpose), binding)); });
        expect(writes.at(-1)).toEqual({ connectedServicesByAgentTargetKey: { [key]: [binding] } });
        await act(async () => { hook.getCurrent().save(withConnectedService(defaults, key, qualifiedPurposeKey(binding.purpose), null)); });
        expect(writes.at(-1)).not.toHaveProperty('connectedServicesByAgentTargetKey');
        expect(writes.at(-1)).toMatchObject({ modelByAgentTargetKey: { [key]: automatic }, defaultAgentTarget: agent });
    });

    it('commits each shared row edit while retaining the project Agent, and clears only the selected field', async () => {
        const writes: (ProjectSessionDefaultsV1 | null)[] = [];
        const defaults: ProjectSessionDefaultsV1 = { defaultAgentTarget: agent, placement };
        const save = async (next: ProjectSessionDefaultsV1 | null) => { writes.push(next); };
        const hook = await renderHook(() => useProjectSessionDefaultsSectionAdapter({ defaults, save, scope: 'project', context: undefined }));
        await act(async () => { hook.getCurrent().save(withPermissionMode(defaults, 'claude', 'read-only')); });
        expect(writes).toEqual([{ defaultAgentTarget: agent, placement, permissionModeByAgentTargetKey: { claude: 'read-only' } }]);
        await act(async () => { hook.getCurrent().save(withPlacement(defaults, undefined)); });
        expect(writes.at(-1)).toEqual({ defaultAgentTarget: agent });
        await act(async () => { hook.getCurrent().selectAgent(undefined); });
        expect(writes.at(-1)).toEqual({ placement });
    });

    it('clears an empty scope to inheritance and settles a failed pick so another deliberate pick can save', async () => {
        const writes: (ProjectSessionDefaultsV1 | null)[] = [];
        let refuse = true;
        const failure = new Error('revision_conflict');
        const save = async (next: ProjectSessionDefaultsV1 | null) => {
            if (refuse) throw failure;
            writes.push(next);
        };
        const hook = await renderHook(() => useProjectSessionDefaultsSectionAdapter({ defaults: { defaultAgentTarget: agent }, save, scope: 'project', context: undefined }));
        await act(async () => { hook.getCurrent().selectAgent(undefined); });
        expect(hook.getCurrent().error).toEqual({ cause: failure });
        refuse = false;
        await act(async () => { hook.getCurrent().selectAgent(undefined); });
        expect(writes).toEqual([null]);
        expect(hook.getCurrent().error).toBeNull();
    });
});
