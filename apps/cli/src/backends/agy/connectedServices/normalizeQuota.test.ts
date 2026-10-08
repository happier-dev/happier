import { describe, expect, it } from 'vitest';
import { normalizeAgyQuota } from './normalizeQuota';

const bucket = (modelId: string, remainingFraction = .8) => ({ modelId, remainingFraction, resetTime: '2026-10-08T18:00:00Z' });

describe('Antigravity shared quota presentation', () => {
  it('shows the four provider-reported pool windows instead of model duplicates and internal entries', () => {
    const meters = normalizeAgyQuota({
      live: { buckets: ['gemini-2.5-pro', 'gemini-pro-agent', 'gemini-3.7-flash-high', 'claude-opus-4-6-thinking', 'claude-sonnet-4-6', 'gpt-oss-120b-medium', 'tab_flash_lite_preview', 'chat_23310'].map((id) => bucket(id)) },
      catalog: { models: {} },
      summary: { groups: [{ displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: .7 },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: .8 },
      ] }, { displayName: 'Claude and GPT models', buckets: [
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: .96 },
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1 },
      ] }] },
    });
    expect(meters.map((m) => [m.meterId, m.label, m.remainingPct, m.windowDurationMs])).toEqual([
      ['shared:gemini-5h', 'Gemini · 5 hours', 80, 18_000_000],
      ['shared:gemini-weekly', 'Gemini · Weekly', 70, 604_800_000],
      ['shared:3p-5h', 'Claude / GPT · 5 hours', 100, 18_000_000],
      ['shared:3p-weekly', 'Claude / GPT · Weekly', 96, 604_800_000],
    ]);
  });

  it('falls back to one row per model family when the summary is unsupported, preserving independent Pro versions', () => {
    const meters = normalizeAgyQuota({ live: { buckets: [
      bucket('gemini-3.7-flash-high'), bucket('gemini-3.8-flash-low', .4), bucket('gemini-2.5-flash'),
      bucket('gemini-2.5-pro'), bucket('gemini-pro-agent', .6), bucket('gemini-3.1-pro-low', .6),
      bucket('claude-opus-4-6-thinking'), bucket('claude-opus-4-5', .3),
      bucket('claude-sonnet-4-6'), bucket('tab_jump_flash_lite_preview'), bucket('chat_20706'), bucket('new-model'),
    ] }, catalog: { models: { 'new-model': { displayName: 'New Model' } } }, summary: null });
    expect(meters.map((m) => [m.meterId, m.label, m.remainingPct])).toEqual([
      ['family:gemini-flash', 'Gemini Flash', 40],
      ['family:gemini-pro-2.5', 'Gemini 2.5 Pro', 80],
      ['family:gemini-pro-3.1', 'Gemini 3.1 Pro', 60],
      ['family:claude-opus', 'Claude Opus', 30],
      ['family:claude-sonnet', 'Claude Sonnet', 80],
      ['model:new-model', 'New Model', 80],
    ]);
  });

  it('does not hide a missing model allowance behind another variant or an unknown summary window', () => {
    const meters = normalizeAgyQuota({ live: { buckets: [bucket('gemini-3.7-flash-high'), { modelId: 'gemini-3.8-flash-low' }] },
      catalog: { models: {} }, summary: { groups: [{ buckets: [{ bucketId: 'gemini-new', window: 'other', remainingFraction: 1 }] }] } });
    expect(meters.find((m) => m.meterId === 'family:gemini-flash')).toMatchObject({ remainingPct: null, status: 'unavailable' });
    expect(meters).toHaveLength(2);
  });
});
