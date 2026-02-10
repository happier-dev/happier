import { describe, expect, it } from 'vitest';

import {
  makeAcpResumeFreshSessionImportsHistoryScenario,
  makeAcpResumeLoadSessionScenario,
} from '../../src/testkit/providers/scenarios/scenarios.acp';

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

  it('resume-load scenario does not rely on trace sentinel text and writes workspace markers', () => {
    const load = makeAcpResumeLoadSessionScenario({
      providerId: 'opencode',
      metadataKey: 'opencodeSessionId',
      phase1TraceSentinel: 'PHASE1',
      phase2TraceSentinel: 'PHASE2',
    });

    const prompt1 = load.prompt?.({ workspaceDir: '/tmp/workspace' }) ?? '';
    const prompt2 = load.resume?.prompt?.({ workspaceDir: '/tmp/workspace' }) ?? '';

    expect(load.requiredTraceSubstrings).toBeUndefined();
    expect(load.resume?.requiredTraceSubstrings).toBeUndefined();
    expect(prompt1).toContain('.happier-resume-phase1.txt');
    expect(prompt1).toContain('PHASE1');
    expect(prompt2).toContain('.happier-resume-phase2.txt');
    expect(prompt2).toContain('PHASE2');
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
