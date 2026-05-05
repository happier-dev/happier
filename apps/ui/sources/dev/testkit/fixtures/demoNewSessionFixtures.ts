import type { NewSessionDraft } from '@/sync/domains/state/persistence';

const DEMO_MACHINE_ID = 'm-macbook-pro';
const DEMO_PROJECT_PATH = '/Users/demo/code/happier';

type DemoNewSessionDraftFields = Pick<
    NewSessionDraft,
    | 'input'
    | 'selectedMachineId'
    | 'selectedPath'
    | 'agentType'
    | 'permissionMode'
    | 'modelMode'
    | 'selectedProfileId'
    | 'selectedSecretId'
>;

export type DemoNewSessionFixture = Readonly<DemoNewSessionDraftFields & {
    selectedMachineId: string;
    selectedPath: string;
}>;

export type CreateDemoNewSessionFixtureOptions = Partial<DemoNewSessionFixture> & Readonly<{
    machineId?: string;
    path?: string;
}>;

export function createDemoNewSessionFixture(options: CreateDemoNewSessionFixtureOptions = {}): DemoNewSessionFixture {
    const {
        machineId = DEMO_MACHINE_ID,
        path = DEMO_PROJECT_PATH,
        selectedMachineId: selectedMachineIdOverride,
        selectedPath: selectedPathOverride,
        ...fixtureOverrides
    } = options;

    return {
        input: 'Implement the dashboard auth skeleton and open a PR.',
        selectedMachineId: selectedMachineIdOverride ?? machineId,
        selectedPath: selectedPathOverride ?? path,
        agentType: 'opencode',
        permissionMode: 'default',
        modelMode: 'default',
        selectedProfileId: null,
        selectedSecretId: null,
        ...fixtureOverrides,
    };
}
