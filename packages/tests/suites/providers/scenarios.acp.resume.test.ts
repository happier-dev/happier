import { describe, expect, it } from 'vitest';

import {
  makeAcpResumeFreshSessionImportsHistoryScenario,
  makeAcpResumeLoadSessionScenario,
} from '../../src/testkit/providers/scenarios.acp';

describe('providers: ACP scenario builders (resume)', () => {
  it('resume scenarios accept execute fixture aliases (Bash/Terminal/execute)', () => {
    const load = makeAcpResumeLoadSessionScenario({
      providerId: 'kimi',
      metadataKey: 'kimiSessionId',
      phase1TraceSentinel: 'PHASE1',
      phase2TraceSentinel: 'PHASE2',
    });
    const fresh = makeAcpResumeFreshSessionImportsHistoryScenario({
      providerId: 'auggie',
      metadataKey: 'auggieSessionId',
      phase1TraceSentinel: 'PHASE1',
      phase1TextSentinel: 'PHASE1_TEXT',
      phase2TraceSentinel: 'PHASE2',
      phase2TextSentinel: 'PHASE2_TEXT',
    });

    for (const scenario of [load, fresh]) {
      expect(scenario.requiredFixtureKeys).toBeUndefined();
      expect(scenario.assertPendingDrain).toBe(false);
      const flat = (scenario.requiredAnyFixtureKeys ?? []).flat();
      expect(flat.some((key) => key.endsWith('/tool-call/Bash'))).toBe(true);
      expect(flat.some((key) => key.endsWith('/tool-call/Terminal'))).toBe(true);
      expect(flat.some((key) => key.endsWith('/tool-call/execute'))).toBe(true);
      expect(flat.some((key) => key.endsWith('/tool-result/Bash'))).toBe(true);
      expect(flat.some((key) => key.endsWith('/tool-result/Terminal'))).toBe(true);
      expect(flat.some((key) => key.endsWith('/tool-result/execute'))).toBe(true);
    }
  });

  it('kimi resume scenarios also accept unknown-shell ACP fixture aliases', () => {
    const load = makeAcpResumeLoadSessionScenario({
      providerId: 'kimi',
      metadataKey: 'kimiSessionId',
      phase1TraceSentinel: 'PHASE1',
      phase2TraceSentinel: 'PHASE2',
    });

    const flat = (load.requiredAnyFixtureKeys ?? []).flat();
    expect(flat.some((key) => key.endsWith('/tool-call/unknown'))).toBe(true);
    expect(flat.some((key) => key.endsWith('/tool-result/unknown'))).toBe(true);
  });
});
