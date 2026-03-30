import { describe, expect, it, vi } from 'vitest';
import { CHECKLIST_IDS } from './checklistIds';
import { createCapabilitiesService, type Capability } from './service';
import type { CapabilitiesDetectContextBuilder } from './service';
import type { CapabilityDetectRequest, ChecklistId } from './types';

describe('createCapabilitiesService', () => {
  it('applies top-level bypassCache to checklist requests before building context', async () => {
    const buildContext = vi.fn<CapabilitiesDetectContextBuilder>(async () => ({ cliSnapshot: null }));
    const detect = vi.fn(async () => ({ available: true }));

    const capabilities: Capability[] = [
      {
        descriptor: { id: 'cli.claude', kind: 'cli' },
        detect,
      },
      {
        descriptor: { id: 'tool.executionRuns', kind: 'tool' },
        detect,
      },
    ];

    const service = createCapabilitiesService({
      capabilities,
      checklists: {
        [CHECKLIST_IDS.NEW_SESSION]: [
          { id: 'cli.claude' },
          { id: 'tool.executionRuns' },
        ] as CapabilityDetectRequest[],
      } as Record<ChecklistId, CapabilityDetectRequest[]>,
      buildContext,
    });

    await service.detect({
      checklistId: CHECKLIST_IDS.NEW_SESSION,
      bypassCache: true,
    });

    expect(buildContext).toHaveBeenCalledWith([
      { id: 'cli.claude', params: { bypassCache: true } },
      { id: 'tool.executionRuns', params: { bypassCache: true } },
    ]);
  });
});
