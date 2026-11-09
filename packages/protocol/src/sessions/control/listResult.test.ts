import { describe, expect, it } from 'vitest';
import { SessionSharedMetadataV1Schema } from '../metadata/sessionMetadataSchemasV1.js';
import { projectSessionSummaryV1, SessionSummarySchema } from './listResult.js';

const row = { id: 'bot-session', createdAt: 1, updatedAt: 2, active: false, activeAt: 2 };

describe('Session summary identity projection', () => {
  it('carries the shared Bot marker and face without exposing private work', () => {
    const shared = SessionSharedMetadataV1Schema.parse({ v: 1, bot: { kind: 'bot' },
      botFace: { style: 'planet', body: 'crab', palette: 'ink', seed: 'chosen-face' } });
    const summary = SessionSummarySchema.parse(projectSessionSummaryV1({ row,
      metadata: { ...shared, work: { createdAsBot: true, instructions: 'private instructions' } }, encryption: null }));
    expect(summary).toMatchObject({ bot: shared.bot, botFace: shared.botFace });
    expect(summary).not.toHaveProperty('work');
    expect(summary).not.toHaveProperty('createdAsBot');
    expect(summary).not.toHaveProperty('instructions');
  });

  it('retains a demoted Session face and omits unavailable or malformed identity', () => {
    const botFace = { style: 'dither' as const, seed: 'retained-face' };
    expect(projectSessionSummaryV1({ row, metadata: { botFace }, encryption: null })).toMatchObject({ botFace });
    for (const metadata of [null, {}, { bot: { kind: 'other' }, botFace: { style: 'digits' } }]) {
      const summary = projectSessionSummaryV1({ row, metadata, encryption: null });
      expect(summary).not.toHaveProperty('bot');
      expect(summary).not.toHaveProperty('botFace');
    }
  });
});
