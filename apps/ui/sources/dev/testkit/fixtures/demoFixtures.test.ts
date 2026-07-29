import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const fixturesDir = path.dirname(fileURLToPath(import.meta.url));

describe('UI demo fixtures', () => {
    it('provides truthful remote-launch and external-session fixture builders', async () => {
        const sessionFixturesPath = path.join(fixturesDir, 'demoSessionFixtures.ts');
        const externalSessionFixturesPath = path.join(fixturesDir, 'demoExternalSessionFixtures.ts');
        const newSessionFixturesPath = path.join(fixturesDir, 'demoNewSessionFixtures.ts');

        expect(fs.existsSync(sessionFixturesPath), 'demoSessionFixtures.ts should exist').toBe(true);
        expect(fs.existsSync(externalSessionFixturesPath), 'demoExternalSessionFixtures.ts should exist').toBe(true);
        expect(fs.existsSync(newSessionFixturesPath), 'demoNewSessionFixtures.ts should exist').toBe(true);

        const { createDemoMachineFixture, createDemoOpenCodeSessionFixture } = await import('./demoSessionFixtures');
        const { createDemoExternalSessionBrowseCandidateFixture } = await import('./demoExternalSessionFixtures');
        const { createDemoNewSessionFixture } = await import('./demoNewSessionFixtures');

        const machine = createDemoMachineFixture();
        const session = createDemoOpenCodeSessionFixture({ machineId: machine.id });
        const candidate = createDemoExternalSessionBrowseCandidateFixture({ machineId: machine.id });
        const newSession = createDemoNewSessionFixture({ machineId: machine.id });
        const machineMetadata = machine.metadata;
        const sessionMetadata = session.metadata;

        if (!machineMetadata || !sessionMetadata) {
            throw new Error('demo fixtures should include metadata');
        }

        expect(machineMetadata.displayName).toBe('MacBook Pro');
        expect(sessionMetadata.machineId).toBe(machine.id);
        expect(sessionMetadata.opencodeBackendMode).toBe('server');
        expect(sessionMetadata.opencodeServerBaseUrlExplicit).toBe(true);
        expect(sessionMetadata.runtimeDescriptorV1).toMatchObject({
            v: 1,
            agentId: 'opencode',
            agent: {
                backendMode: 'server',
                providerSessionId: sessionMetadata.opencodeSessionId,
            },
        });
        expect(candidate).toMatchObject({
            activity: 'running',
            details: {
                machineId: machine.id,
                path: sessionMetadata.path,
            },
        });
        expect(newSession).toMatchObject({
            agentType: 'opencode',
            selectedMachineId: machine.id,
            selectedPath: sessionMetadata.path,
        });
    });
});
