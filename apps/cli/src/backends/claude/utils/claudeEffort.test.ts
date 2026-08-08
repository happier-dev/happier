import { describe, expect, it } from 'vitest';

import {
  buildClaudeEffortCliArgs,
  resolveClaudeDefaultEffortForModel,
  resolveClaudeUltracodeForModel,
} from './claudeEffort';

describe('buildClaudeEffortCliArgs', () => {
  it('treats Fable 5 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats Opus 4.8 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-8', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-8', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats Opus 5 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-5', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats the generic opus alias as the current flagship Claude model for default effort resolution', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'opus', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'opus', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('keeps Opus 4.7 behavior where high still requires an explicit override', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-7', effort: 'high' })).toEqual(['--effort', 'high']);
  });

  it('resolves effort for [1m]-suffixed model ids the same as the bare id', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5[1m]', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5[1m]', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-sonnet-4-6[1m]', effort: 'low' })).toEqual(['--effort', 'low']);
  });

  it('forwards effort for a discovered model only against its reported tiers', () => {
    // `reasoningEffort` is session-scoped and is not cleared when the model changes, so an
    // unknown model id alone is not evidence that the carried level is supported. Forward only
    // when the caller supplies the tiers the Models API actually reported, clamped to them.
    expect(buildClaudeEffortCliArgs({
      modelId: 'claude-opus-9',
      effort: 'xhigh',
      supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    })).toEqual(['--effort', 'xhigh']);

    // Carried level exceeds what the model reports: clamp down rather than pass it through.
    expect(buildClaudeEffortCliArgs({
      modelId: 'claude-opus-9',
      effort: 'max',
      supportedLevels: ['low', 'medium'],
    })).toEqual(['--effort', 'medium']);

    // No reported tiers means no evidence — never send a stale session effort.
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-9', effort: 'max' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'glm-4.6', effort: 'max' })).toEqual([]);
  });

  it('prefers a discovered model reported tiers over a substring alias match', () => {
    // `claude-opus-5-preview` contains the curated `opus-5` alias but is a different model; its own
    // reported tiers must win so the picker and the spawned flag agree.
    expect(buildClaudeEffortCliArgs({
      modelId: 'claude-opus-5-preview',
      effort: 'max',
      supportedLevels: ['low', 'medium'],
    })).toEqual(['--effort', 'medium']);
    // A curated id keeps its static table even when tiers are supplied.
    expect(buildClaudeEffortCliArgs({
      modelId: 'claude-haiku-4-5',
      effort: 'high',
      supportedLevels: ['low', 'medium', 'high'],
    })).toEqual([]);
  });

  it('never sends --effort when no model is selected', () => {
    expect(buildClaudeEffortCliArgs({ modelId: undefined, effort: 'max' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: '', effort: 'max' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: '   ', effort: 'max' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'default', effort: 'max' })).toEqual([]);
  });

  it('never sends --effort for known models that do not support it', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-haiku-4-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-sonnet-4-5', effort: 'high' })).toEqual([]);
  });
});

describe('resolveClaudeUltracodeForModel', () => {
  it('enables ultracode only when requested AND the model is xhigh-capable', () => {
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-fable-5', ultracode: true })).toBe(true);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-opus-5', ultracode: true })).toBe(true);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-opus-4-8', ultracode: true })).toBe(true);
    expect(resolveClaudeUltracodeForModel({ modelId: 'opus', ultracode: true })).toBe(true);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-fable-5[1m]', ultracode: true })).toBe(true);
  });

  it('never enables ultracode for non-xhigh models or when not requested', () => {
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-sonnet-4-6', ultracode: true })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-opus-4-6', ultracode: true })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-haiku-4-5', ultracode: true })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-fable-5', ultracode: false })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-fable-5', ultracode: undefined })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: undefined, ultracode: true })).toBe(false);
    expect(resolveClaudeUltracodeForModel({ modelId: 'default', ultracode: true })).toBe(false);
  });

  it('honors ultracode for a discovered model only against its reported tiers', () => {
    expect(resolveClaudeUltracodeForModel({
      modelId: 'claude-opus-9',
      ultracode: true,
      supportedLevels: ['low', 'high', 'xhigh'],
    })).toBe(true);
    expect(resolveClaudeUltracodeForModel({
      modelId: 'claude-opus-9',
      ultracode: true,
      supportedLevels: ['low', 'medium', 'high'],
    })).toBe(false);
    // Same rule as effort: a stale session `ultracode` override is not evidence of support.
    expect(resolveClaudeUltracodeForModel({ modelId: 'claude-opus-9', ultracode: true })).toBe(false);
  });
});

describe('resolveClaudeDefaultEffortForModel', () => {
  it('resolves the model default effort with alias and [1m] tolerance', () => {
    expect(resolveClaudeDefaultEffortForModel('claude-fable-5')).toBe('high');
    expect(resolveClaudeDefaultEffortForModel('opus')).toBe('high');
    expect(resolveClaudeDefaultEffortForModel('claude-opus-4-7[1m]')).toBe('xhigh');
    expect(resolveClaudeDefaultEffortForModel('claude-haiku-4-5')).toBeNull();
  });
});
