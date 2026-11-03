import { expect, it } from 'vitest';
import { CHECKLIST_IDS } from './checklistIds';
import { createCapabilitiesService, type Capability } from './service';

it('preserves effective checklist overrides and cache bypass across the requester service while keeping parent facts local', async () => {
    const capabilities: Capability[] = [{
        descriptor: { id: 'cli.fixture', kind: 'cli' }, effects: { detect: ['private_read', 'process'] },
        detect: async ({ request }) => ({ refreshed: request.params?.bypassCache === true,
            versionChecked: request.params?.verifyVersion === true }),
    }, {
        descriptor: { id: 'tool.parent', kind: 'tool' }, effects: { detect: [] },
        detect: async ({ request }) => ({ available: request.params?.enabled === true }),
    }];
    const options = { capabilities, buildContext: async () => ({ cliSnapshot: null }),
        checklists: { [CHECKLIST_IDS.NEW_SESSION]: [{ id: 'cli.fixture', params: { verifyVersion: false } }, { id: 'tool.parent' }],
            [CHECKLIST_IDS.MACHINE_DETAILS]: [] } } satisfies Parameters<typeof createCapabilitiesService>[0];
    const parent = createCapabilitiesService(options);
    const worker = createCapabilitiesService(options);
    const result = await parent.detect({ checklistId: CHECKLIST_IDS.NEW_SESSION, bypassCache: true,
        overrides: { 'cli.fixture': { params: { verifyVersion: true, bypassCache: false } },
            'tool.parent': { params: { enabled: true } } } }, {
        // The requester transport is the boundary. Both service instances use
        // the real normalization and execution path on their side of it.
        executeEffects: async (_effects, execute, projected) =>
            await worker.detect(projected!) as Awaited<ReturnType<typeof execute>>,
    });
    expect(result).toMatchObject({ results: {
        'cli.fixture': { ok: true, data: { refreshed: true, versionChecked: true } },
        'tool.parent': { ok: true, data: { available: true } },
    } });
});
