import { settingsDefaults } from '@/sync/domains/settings/settings';
import { describe, expect, it } from 'vitest';
import { buildManagedSessionDefaultsContext } from '@happier-dev/protocol/teams/managedDefaults';
import { createUiPrepareSessionSpawnNewInput } from './prepareSessionSpawnNewInput';

const projectAgent = { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } as const;
const authoredAgent = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
const executionTarget = { serverId: 'home', machineId: 'selected' };
const projectTarget = { serverId: 'home', machineId: 'project-machine' };

describe('UI Session authoring preparation', () => {
    it.each([false, true])('preserves typed optional defaults notes without refusing authored creation, captured=%s', async captured => {
        const failure = { ok: false as const, errorCode: 'defaults_unavailable', error: 'defaults_unavailable', effectAttempted: false };
        const unexpectedRead = async (): Promise<never> => { throw new Error('captured defaults must not reread'); };
        const prepare = createUiPrepareSessionSpawnNewInput({ readSettings: captured ? unexpectedRead : async () => settingsDefaults,
            createLoader: () => ({ readSource: unexpectedRead, readHome: async () => { throw new Error('Home unavailable'); } }) });
        const prepared = await prepare({ executionTarget, agentTarget: authoredAgent, directory: { kind: 'path', path: '/repo' } }, {
            surface: 'ui', ...(captured ? { sessionCreationDefaults: { context: buildManagedSessionDefaultsContext({}),
                unavailableDefaults: [failure], authoredChoices: { executionTarget, agentTarget: authoredAgent } } } : {}),
        });
        expect(prepared.input.executionTarget).toEqual(executionTarget);
        expect(prepared.input.agentTarget).toEqual(authoredAgent);
        expect(prepared.defaults.unavailableDefaults).toEqual([failure]);
    });

    it('uses native Account Agent preference for a Preset without querying its hidden controller inventory', async () => {
        const unexpectedRead = async (): Promise<never> => { throw new Error('captured defaults must not reread'); };
        const queriedTargets: unknown[] = [];
        const prepare = createUiPrepareSessionSpawnNewInput({ readSettings: unexpectedRead,
            createLoader: () => ({ readPersonalDefaults: unexpectedRead, readSource: unexpectedRead, readTeam: unexpectedRead, readHome: unexpectedRead }),
            bindPreset: async () => ({ input: { selection: { kind: 'preset', homeId: 'home', id: 'shared', revision: 1 },
                controller: { machineId: 'hidden-controller', installationId: 'installed' } } }),
            resolveDefaultAgentTarget: async target => {
                queriedTargets.push(target);
                if (target) throw new Error('controller inventory is not admitted by a Preset');
                return projectAgent;
            },
        });
        const prepared = await prepare({ directory: { kind: 'path', path: '/project' } }, {
            surface: 'ui', sessionCreationDefaults: {
                context: buildManagedSessionDefaultsContext({ personalDefaultsRow: { placement: { kind: 'preset', homeId: 'home', presetId: 'shared' } } }),
                authoredChoices: {},
            },
        });
        expect(prepared.input.agentTarget).toEqual(projectAgent);
        expect(prepared.input.executionTarget).toEqual({ serverId: 'home', machineId: 'hidden-controller' });
        expect(queriedTargets).toEqual([null]);
    });
    it('uses the native inventory default on the effective Project Machine only when Agent is unset', async () => {
        const unexpectedRead = async (): Promise<never> => { throw new Error('captured defaults must not reread'); };
        const inventoryTargets: unknown[] = [];
        const prepare = createUiPrepareSessionSpawnNewInput({ readSettings: unexpectedRead,
            createLoader: () => ({ readPersonalDefaults: unexpectedRead, readSource: unexpectedRead, readTeam: unexpectedRead, readHome: unexpectedRead }),
            resolveDefaultAgentTarget: async target => { inventoryTargets.push(target); return projectAgent; },
        });
        const prepared = await prepare({ executionTarget, directory: { kind: 'path', path: '/project' } }, {
            surface: 'ui', sessionCreationDefaults: {
                context: buildManagedSessionDefaultsContext({ personalDefaultsRow: { placement: { kind: 'machine', target: projectTarget } } }),
                authoredChoices: {},
            },
        });
        expect(prepared.input.agentTarget).toEqual(projectAgent);
        expect(prepared.input.executionTarget).toEqual(projectTarget);
        expect(inventoryTargets).toEqual([projectTarget]);
    });
    it('preserves explicit Machine sandbox and Project file intent through preparation', async () => {
        const unexpectedRead = async (): Promise<never> => { throw new Error('captured defaults must not reread'); };
        const prepare = createUiPrepareSessionSpawnNewInput({ readSettings: unexpectedRead,
            createLoader: () => ({ readPersonalDefaults: unexpectedRead, readSource: unexpectedRead, readTeam: unexpectedRead, readHome: unexpectedRead }),
            resolveDefaultAgentTarget: unexpectedRead });
        const sessionPlacement = { kind: 'machine', target: executionTarget, projectFiles: { kind: 'copy_once' },
            configuredSandbox: { kind: 'sandbox', configuredSandboxId: 'development', lifecycle: 'fresh',
                provisioner: { pluginId: 'example.sandbox', localId: 'local' }, presetId: 'development' } } as const;
        const prepared = await prepare({ executionTarget, agentTarget: authoredAgent,
            directory: { kind: 'path', path: '/project' }, sessionPlacement }, {
            surface: 'ui', sessionCreationDefaults: {
                context: buildManagedSessionDefaultsContext({ personalDefaultsRow: { placement: { kind: 'machine', target: projectTarget } } }),
                authoredChoices: { executionTarget, sessionPlacement, agentTarget: authoredAgent },
            },
        });
        expect(prepared.input.sessionPlacement).toEqual(sessionPlacement);
    });
    it.each([false, true])('keeps the already acquired managed target with optional placement carrier=%s', async withPlacement => {
        const unexpectedRead = async (): Promise<never> => { throw new Error('captured defaults must not reread'); };
        const prepare = createUiPrepareSessionSpawnNewInput({ readSettings: unexpectedRead,
            createLoader: () => ({ readPersonalDefaults: unexpectedRead, readSource: unexpectedRead, readTeam: unexpectedRead, readHome: unexpectedRead }),
            resolveDefaultAgentTarget: unexpectedRead });
        const sessionPlacement = { kind: 'managed', projectFiles: { kind: 'copy_once' } } as const;
        const prepared = await prepare({ executionTarget, agentTarget: authoredAgent,
            directory: { kind: 'path', path: '/project' }, ...(withPlacement ? { sessionPlacement } : {}),
            managedCreation: { homeId: 'home', managedId: 'acquired' } }, {
            surface: 'ui', sessionCreationDefaults: {
                context: buildManagedSessionDefaultsContext({ personalDefaultsRow: { placement: { kind: 'machine', target: projectTarget } } }),
                authoredChoices: { agentTarget: authoredAgent,
                    sessionPlacement: { kind: 'preset', homeId: 'home', presetId: 'previously-selected' } },
            },
        });
        expect(prepared.input.executionTarget).toEqual(executionTarget);
        expect(prepared.input.sessionPlacement).toEqual(withPlacement ? sessionPlacement : { kind: 'machine', target: executionTarget });
        expect(prepared.input.managedCreation).toEqual({ homeId: 'home', managedId: 'acquired' });
        expect(prepared.defaults.managedPresetAcquisition).toBeUndefined();
    });
    it.each([false, true])('uses the captured Project context and preserves authored Agent choice=%s before native admission', async explicit => {
        // The capture already admitted the selected records. These I/O ports
        // must remain unused while the real builder/resolver and native admission run.
        const unexpectedRead = async (): Promise<never> => { throw new Error('captured defaults must not reread'); };
        const prepare = createUiPrepareSessionSpawnNewInput({ readSettings: unexpectedRead,
            createLoader: () => ({ readPersonalDefaults: unexpectedRead, readSource: unexpectedRead, readTeam: unexpectedRead, readHome: unexpectedRead }),
            resolveDefaultAgentTarget: unexpectedRead,
        });
        const prepared = await prepare({ executionTarget, directory: { kind: 'path', path: '/project' },
            ...(explicit ? { agentTarget: authoredAgent } : {}) }, {
            surface: 'ui', sessionCreationDefaults: {
                context: buildManagedSessionDefaultsContext({ personalDefaultsRow: { defaultAgentTarget: projectAgent,
                    placement: { kind: 'machine', target: projectTarget } } }),
                authoredChoices: explicit ? { agentTarget: authoredAgent, executionTarget } : {},
            },
        });
        expect(prepared.input.agentTarget).toEqual(explicit ? authoredAgent : projectAgent);
        expect(prepared.input.executionTarget).toEqual(explicit ? executionTarget : projectTarget);
        expect(prepared.defaults.authoredChoices).toEqual(explicit ? { agentTarget: authoredAgent, executionTarget } : {});
    });
});
