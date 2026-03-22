import { describe, expect, it } from 'vitest';

import {
  buildPromptPlanDiagnosticsV1,
  buildPromptPlanV1,
  renderPromptPlanV1,
} from './promptPlanV1.js';

describe('promptPlanV1', () => {
  it('filters empty blocks and deduplicates repeated ids', () => {
    const plan = buildPromptPlanV1({
      modality: 'coding',
      blocks: [
        { id: 'base', scope: 'session', text: 'BASE' },
        { id: 'empty', scope: 'session', text: '   ' },
        { id: 'dup', scope: 'user_prompt', text: 'FIRST' },
        { id: 'dup', scope: 'user_prompt', text: 'SECOND' },
      ],
    });

    expect(plan.blocks).toEqual([
      { id: 'base', scope: 'session', text: 'BASE' },
      { id: 'dup', scope: 'user_prompt', text: 'FIRST' },
    ]);
  });

  it('renders blocks in plan order and exposes diagnostics', () => {
    const plan = buildPromptPlanV1({
      modality: 'voice',
      blocks: [
        { id: 'voice.base', scope: 'session', text: 'BASE' },
        { id: 'voice.bootstrap', scope: 'bootstrap', text: 'READY' },
      ],
    });

    expect(renderPromptPlanV1(plan)).toBe('BASE\n\nREADY');
    expect(buildPromptPlanDiagnosticsV1(plan)).toEqual({
      modality: 'voice',
      blockIds: ['voice.base', 'voice.bootstrap'],
      scopes: ['session', 'bootstrap'],
    });
  });
});
