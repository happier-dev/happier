import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key) => key,
  }),
);

const { describeProjectAgentGuidance } =
  await import('./ProjectAgentGuidanceDisclosure');
type Guidance = Parameters<typeof describeProjectAgentGuidance>[0];

function guidance(adHoc: 'resolved' | 'refused'): Guidance {
  // Only the facts the disclosure reads; the reader's other advisory facts are irrelevant here.
  return {
    scripts: [
      { name: 'test', execution: 'portable' },
      { name: 'typecheck', execution: 'portable' },
      { name: 'lint', execution: 'primary' },
    ],
    adHoc: {
      resolution:
        adHoc === 'resolved'
          ? {
              status: 'resolved',
              choice: { kind: 'primary' },
              provenance: 'workspace',
            }
          : { status: 'refused', reason: 'ad_hoc_disabled' },
    },
  } as unknown as Guidance;
}

describe('describeProjectAgentGuidance', () => {
  it('lists which scripts may leave the checkout and which stay, from the declarations', () => {
    const text = describeProjectAgentGuidance(guidance('refused'), 'happier');
    const lines = text.split('\n');
    expect(
      lines.find((line) => line.includes('projectWorkers.guideWorker')),
    ).toContain('test, typecheck');
    expect(
      lines.find((line) => line.includes('projectWorkers.guidePrimary')),
    ).toContain('lint');
    expect(
      lines.find((line) => line.includes('projectWorkers.guideWorker')),
    ).not.toContain('lint');
  });

  it('says whether explicit ad-hoc commands are allowed from the resolved checkout preference', () => {
    expect(
      describeProjectAgentGuidance(guidance('refused'), 'happier'),
    ).toContain('projectWorkers.guideAdHocOff');
    expect(
      describeProjectAgentGuidance(guidance('resolved'), 'happier'),
    ).toContain('projectWorkers.guideAdHocOn');
  });
});
