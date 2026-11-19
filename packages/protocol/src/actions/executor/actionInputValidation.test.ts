import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { actionInputValidationFailure } from './actionInputValidation.js';
import { BotFaceSetInputSchema } from '../../sessions/identity/sessionBotFaceV1.js';
import { createActionExecutor } from '../actionExecutor.js';

describe('Action input validation diagnostics', () => {
  it('returns all root repair messages when Environment creation input fails its refinements', async () => {
    const failure = await createActionExecutor({}).execute('deployments.environments.create', {
      serverId: 'home', requestKey: 'create-preview', protection: 'nonProduction', purpose: 'preview',
      deployerMode: 'managers', name: 'private-preview-title',
    }, { surface: 'agent', authority: 'account_automation', serverId: 'home' });
    expect(failure).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: [
      { code: 'custom', path: [], message: 'Select an existing or reviewed new Project.' },
      { code: 'custom', path: [], message: 'A preview or its named companion derives from one template and existing Source.' },
      { code: 'custom', path: [], message: 'Create selects an authored definition or an exact source copy.' },
    ] } });
    expect(JSON.stringify(failure)).not.toContain('private-preview-title');
  });

  it.each(['link', 'missing'])('refuses %s invitation input with token guidance before any Home call', async kind => {
    const token = 'a'.repeat(43);
    const input = kind === 'link' ? { v: 1, token: `https://app.example/join/${token}?target=opaque&targetBinding=binding` } : { v: 1 };
    const failure = await createActionExecutor({}).execute('teams.invitations.accept', input,
      { surface: 'cli', authority: 'account_automation', serverId: 'home' });
    expect(failure).toMatchObject({ ok: false, errorCode: 'invitation_token_expected', error: expect.stringContaining('open the link in the app') });
    expect(JSON.stringify(failure)).not.toContain(token);
  });

  it.each([false, true])('reports repair messages for an incomplete Doc passage through the real executor (interception: %s)', async intercepted => {
    // Incident-shaped rather than recorded payload: omit anchor facts and retry identity so both authoring forms report their issues.
    const executor = createActionExecutor(intercepted ? {
      interceptActionExecution: async ({ input }) => ({ status: 'continue', input }),
    } : {});
    const failure = await executor.execute('doc.edit.propose', {
      target: { ref: { kind: 'doc', artifactId: 'doc', serverId: 'home' }, quote: 'Read this' },
      discussionRef: { serverId: 'home', discussionId: 'thread' },
      baseRevision: { headerVersion: 2, bodyVersion: 3 }, before: 'Read this', after: 'Read that', reason: 'Clarify',
    }, { surface: 'agent', authority: 'account_automation', serverId: 'home' });
    expect(failure).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_type', path: ['target', 'revision'], expected: 'object', message: expect.any(String) }),
        expect.objectContaining({ code: 'invalid_type', path: ['target', 'range'], expected: 'object', message: expect.any(String) }),
      ]),
    } });
  });

  it.each([false, true])('returns repair messages without a Saved Secret value or an input-bearing unknown key (invalid secret shape: %s)', async invalidSecretShape => {
    const secret = 'private-token-never-echo';
    const failure = await createActionExecutor({}).execute('secrets.create', {
      name: 'Token', value: invalidSecretShape ? { token: secret } : secret, kind: secret, [secret]: secret,
    }, { surface: 'agent', authority: 'account_automation', serverId: 'home' });
    expect(failure).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_value', path: ['kind'], message: expect.any(String) }),
        expect.objectContaining({ code: 'unrecognized_keys', path: [], message: expect.any(String) }),
      ]),
    } });
    if (invalidSecretShape) expect(failure).toMatchObject({ details: { issues: expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_type', path: ['value'], message: 'Expected string' }),
    ]) } });
    expect(JSON.stringify(failure)).not.toContain(secret);
  });

  it('reports fixed shape repair facts, then admits a corrected mug without exposing its rejected outline', () => {
    const input = { sessionId: 'mug-bot', face: { shape: { v: 1, origin: 'custom',
      fill: ['M40 40 L42 40 L42 42 L40 42 Z'], mouth: [41, 75, 0.8] } } };
    const rejected = BotFaceSetInputSchema.safeParse(input);
    if (rejected.success) throw new Error('The small body and displaced mouth must fail geometric admission');
    const failure = actionInputValidationFailure(rejected.error);
    expect(failure).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: { issues: expect.arrayContaining([
      { code: 'custom', path: ['face', 'shape'], message: 'Invalid input', constraint: { rule: 'body_coverage', minimumRatio: 0.08 } },
      { code: 'custom', path: ['face', 'shape'], message: 'Invalid input', constraint: { rule: 'mouth_containment', mood: 'quiet', maximumSignedDistance: 0 } },
      { code: 'custom', path: ['face', 'shape'], message: 'Invalid input', constraint: { rule: 'mouth_containment', mood: 'needsYou', maximumSignedDistance: 0 } },
    ]) } });
    expect(JSON.stringify(failure)).not.toContain(input.face.shape.fill[0]);
    const repaired = BotFaceSetInputSchema.safeParse({ ...input, face: { shape: { ...input.face.shape,
      fill: ['M10 10 L70 10 L70 70 L10 70 Z'],
      stroke: [['M70 20 C100 20 100 60 70 60', 8]], mouth: [40, 45, 0.8],
    } } });
    expect(repaired.success).toBe(true);
  });

  it('drops unrecognised or input-bearing constraint metadata as well as custom prose', () => {
    const schema = z.string().check(z.superRefine((value, ctx) => {
      ctx.addIssue({ code: 'custom', message: value,
        params: { constraint: { rule: 'body_coverage', minimumRatio: 0.08, rejected: value } } });
      ctx.addIssue({ code: 'custom', message: value,
        params: { constraint: { rule: 'mouth_containment', mood: value, maximumSignedDistance: 0 } } });
    }));
    const parsed = schema.safeParse('private-outline');
    if (parsed.success) throw new Error('Fixture must fail');
    expect(actionInputValidationFailure(parsed.error)).toEqual({
      ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
      details: { issues: [{ code: 'custom', path: [], message: 'Invalid input' }, { code: 'custom', path: [], message: 'Invalid input' }] },
    });
  });

  it('keeps full field and array paths through nested union branches without exposing input', () => {
    const schema = z.strictObject({
      items: z.array(z.union([
        z.strictObject({ choice: z.union([z.literal('auto'), z.number()]) }),
        z.boolean(),
      ])),
    });
    const parsed = schema.safeParse({ items: [{ choice: 'private-input', 'private-key': 'private-value' }] });
    if (parsed.success) throw new Error('Fixture must violate the real input schema');

    expect(actionInputValidationFailure(parsed.error)).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
      details: {
        issues: [
          { code: 'invalid_union', path: ['items', 0], message: 'Invalid input' },
          { code: 'invalid_union', path: ['items', 0, 'choice'], message: 'Invalid input' },
          { code: 'invalid_value', path: ['items', 0, 'choice'], message: 'Invalid input: expected "auto"', acceptedValues: ['auto'] },
          { code: 'invalid_type', path: ['items', 0, 'choice'], message: 'Expected number', expected: 'number' },
          { code: 'unrecognized_keys', path: ['items', 0], message: 'Unrecognized input fields' },
          { code: 'invalid_type', path: ['items', 0], message: 'Expected boolean', expected: 'boolean' },
        ],
      },
    });
  });

  it('keeps repair facts without rejected values, unknown-key lists or input-bearing custom prose', () => {
    const baseSchema = z.strictObject({ title: z.string() });
    const schema = baseSchema.check(z.superRefine((value, ctx) => {
      ctx.addIssue({ code: 'custom', path: ['title'], message: `Rejected private title: ${value.title}` });
    }));
    const custom = schema.safeParse({ title: 'private-input' });
    const unknown = baseSchema.safeParse({ title: 'private-input', 'private-unknown-key': 'private-value' });
    if (custom.success || unknown.success) throw new Error('Fixture must violate the real input schemas');
    expect(actionInputValidationFailure(custom.error)).toEqual({
      ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
      details: { issues: [{ code: 'custom', path: ['title'], message: 'Invalid input' }] },
    });
    expect(actionInputValidationFailure(unknown.error)).toEqual({
      ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters',
      details: { issues: [{ code: 'unrecognized_keys', path: [], message: 'Unrecognized input fields' }] },
    });
  });
});
