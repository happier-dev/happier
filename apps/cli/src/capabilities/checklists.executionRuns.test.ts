import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';

import { CHECKLIST_IDS } from './checklistIds';
import { resumeChecklistId } from './checklistIds';
import { checklists } from './checklists';

describe('capabilities checklists', () => {
  afterEach(() => {
    vi.doUnmock('@/backends/catalog');
    vi.resetModules();
  });

  it('includes tool.executionRuns in MACHINE_DETAILS checklist', () => {
    const entries = checklists[CHECKLIST_IDS.MACHINE_DETAILS] ?? [];
    expect(entries.some((e) => e.id === 'tool.executionRuns')).toBe(true);
  });

  it('does not request ACP capabilities in normal checklists', () => {
    const entries = Object.values(checklists).flat();
    expect(entries.some((e) => (e as any)?.params?.includeAcpCapabilities === true)).toBe(false);
  });

  it('does not emphasize Codex ACP installables for the default resume checklist', () => {
    const entries = checklists[resumeChecklistId('codex')] ?? [];
    expect(entries.some((entry) => entry.id === CODEX_ACP_DEP_ID)).toBe(false);
  });

  it('does not read AGENTS during module initialization', async () => {
    let initialized = false;

    vi.doMock('@/backends/catalog', () => ({
      get AGENTS() {
        if (!initialized) {
          throw new ReferenceError("Cannot access 'AGENTS' before initialization");
        }
        return {
          claude: { id: 'claude' },
        };
      },
    }));

    const moduleExports = await import('./checklists');
    initialized = true;

    expect(moduleExports.checklists[CHECKLIST_IDS.NEW_SESSION]).toEqual(
      expect.arrayContaining([{ id: 'cli.claude' }]),
    );
  });
});
