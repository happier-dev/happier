import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';

describe('providers: resume scenario permission auto-approve policy', () => {
  const kimiProvider = {
    id: 'kimi',
    protocol: 'acp',
  } as any;

  it('enables permission auto-approve in yolo for resume load-session scenario', () => {
    const scenario = scenarioCatalog.acp_resume_load_session(kimiProvider);
    expect(scenario.yolo).toBe(true);
    expect(scenario.allowPermissionAutoApproveInYolo).toBe(true);
  });

  it('enables permission auto-approve in yolo for resume fresh-session scenario', () => {
    const scenario = scenarioCatalog.acp_resume_fresh_session_imports_history(kimiProvider);
    expect(scenario.yolo).toBe(true);
    expect(scenario.allowPermissionAutoApproveInYolo).toBe(true);
  });
});
