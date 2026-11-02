import { describe, expect, it } from 'vitest';
import { BotFaceSetInputSchema, SessionBotFaceV1Schema, readSessionBotFaceV1, areSessionBotFacesEqual } from './sessionBotFaceV1.js';
import { createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1, projectSessionSharedMetadataV1 } from '../metadata/sessionMetadataSchemasV1.js';
import { projectSessionDisplayV1 } from '../metadata/sessionDisplayProjectionV1.js';
import { EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES } from '../../actions/externalActionLimits.js';

describe('shared Bot face', () => {
  it('admits the hand-drawn cat as a roster body (R8, the 35th)', () => {
    expect(SessionBotFaceV1Schema.parse({ body: 'cat' })).toEqual({ body: 'cat' });
  });

  const shape = () => ({ v: 1 as const, fill: ['M20 0 L100 0 L100 80 L20 80 Z'], mouth: [60, 46, 0.8] as [number, number, number], origin: 'custom' as const });

  it('carries an outline through shared metadata and compares its content rather than its object identity', () => {
    const face = { body: 'bag' as const, shape: shape() };
    expect(SessionBotFaceV1Schema.parse(face)).toEqual(face);
    expect(projectSessionSharedMetadataV1({ metadata: { botFace: face } })).toMatchObject({ botFace: face });
    expect(areSessionBotFacesEqual(face, { ...face, shape: shape() })).toBe(true);
    expect(areSessionBotFacesEqual(face, { ...face, shape: { ...shape(), mouth: [60, 45, 0.8] } })).toBe(false);
    expect(areSessionBotFacesEqual(face, { body: 'bag' })).toBe(false);
  });

  it('normalises an authored outline once at the Action boundary while stored reads retain its coordinates', () => {
    const raw = shape();
    const input = BotFaceSetInputSchema.parse({ sessionId: 'bot-shapes', face: { body: 'bag', shape: raw } });
    expect(input.face?.shape?.mouth).toEqual([45, 46, 0.8]);
    expect(readSessionBotFaceV1({ shape: raw })?.shape?.mouth).toEqual(raw.mouth);
    expect(BotFaceSetInputSchema.parse(input)).toEqual(input);
  });

  it('reuses the complete Action request payload bound without a shorter shape or path limit', () => {
    const input = { sessionId: 'bot-shapes', face: { shape: shape() } };
    const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
    input.face.shape.fill[0] += ' '.repeat(EXTERNAL_ACTION_HTTP_BODY_LIMIT_BYTES - bytes);
    expect(BotFaceSetInputSchema.safeParse(input).success).toBe(true);
    input.face.shape.fill[0] += ' ';
    expect(BotFaceSetInputSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    { fill: [] },
    { fill: ['M0 0 H90 V90 Z'] },
    { fill: ['M0 0 S10 10 20 20 Z'] },
    { fill: ['M0 0 T20 20 Z'] },
    { fill: ['M0 0 LNaN 80 Z'] },
    { fill: ['M0 0 L80 0 L80 80'] },
    { fill: ['M0 0 L200 0 L200 80 L0 80 Z'] },
    { fill: ['M40 40 L42 40 L42 42 L40 42 Z'] },
    { stroke: [['M20 20 L40 40', 25]] },
    { stroke: [['M20 20 L40 40', 0]] },
    { mouth: [60, 120, 0.8] },
    { mouth: [60, 46, 0.49] },
    { mouth: [60, 46, 1.21] },
  ])('rejects invalid authored geometry before publishing a face: %j', invalid => {
    expect(BotFaceSetInputSchema.safeParse({ sessionId: 'bot-shapes', face: { shape: { ...shape(), ...invalid } } }).success).toBe(false);
  });
  it('admits deliberate cosmetic choices and exposes the same face to recipients without owner data', () => {
    const face = { style: 'dither', body: 'spider', palette: 'lagoon', seed: 'picked-once' } as const;
    expect(SessionBotFaceV1Schema.parse(face)).toEqual(face);
    const shared = projectSessionSharedMetadataV1({ metadata: { bot: { kind: 'bot' }, botFace: face,
      path: '/private', work: { statusReason: 'private' } } });
    expect(shared).toEqual({ v: 1, bot: { kind: 'bot' }, botFace: face });
    expect(projectSessionDisplayV1({ sharedMetadata: shared })).toEqual({ shared: { v: 1, bot: { kind: 'bot' }, botFace: face } });
    const owner = createSessionOwnerMetadataV1({ metadata: { path: '/private', host: 'host', bot: { kind: 'bot' }, botFace: face } });
    expect(owner).toMatchObject({ ok: true });
    if (!owner.ok) throw new Error(owner.unsupportedFields.join(','));
    expect(owner.ownerMetadata.work).not.toHaveProperty('botFace');
    expect(projectSessionOwnerCompatibilityViewV1({ sharedMetadata: shared, ownerMetadata: owner.ownerMetadata }))
      .toMatchObject({ botFace: face, path: '/private' });
  });

  it('tolerates unknown stored cosmetics, rejects unknown Action input and accepts absent overrides', () => {
    expect(readSessionBotFaceV1(undefined)).toBeNull();
    expect(readSessionBotFaceV1({ seed: 'same', future: true })).toEqual({ seed: 'same' });
    expect(SessionBotFaceV1Schema.safeParse({ seed: 'same', future: true }).success).toBe(false);
    expect(readSessionBotFaceV1({ style: 'digits' })).toBeNull();
    expect(SessionBotFaceV1Schema.parse({})).toEqual({});
  });

  it.each([
    'crab', 'squid', 'octopus', 'ufo', 'specter', 'ghost',
    'beetle', 'spider', 'jelly', 'hopper', 'pup', 'drone',
    'robot', 'walker', 'rocket', 'feet', 'tail', 'drip',
    'bracelegs', 'tagclaws', 'cursortail', 'termbody', 'antlers', 'semi', 'brackets', 'cursor',
    'bean', 'squat', 'bag', 'loaf', 'puddle', 'tower', 'stilts', 'tall',
  ])('admits the shipped R6 body %s without losing its colour or seed', body => {
    const face = { body, palette: 'orchid', seed: 'saved-choice' };
    expect(SessionBotFaceV1Schema.parse(face)).toEqual(face);
    expect(readSessionBotFaceV1(face)).toEqual(face);
  });

  it.each(['colour', 'mono', 'matte', 'ceramic', 'gloss', 'glass', 'clay', 'lit'])
    ('rejects the retired finish %s on authoring while retaining stored face choices', finish => {
      const face = { body: 'crab', palette: 'lagoon', seed: 'same' };
      expect(SessionBotFaceV1Schema.safeParse({ ...face, finish }).success).toBe(false);
      expect(readSessionBotFaceV1({ ...face, finish })).toEqual(face);
    });
});
