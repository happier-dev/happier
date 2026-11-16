import { describe, expect, it } from 'vitest';
import { formatInlineReferenceTokenV1 } from '../runtime/input/inlineReferenceTokenV1.js';
import { MENTION_KIND_V1 } from '../runtime/input/mentionRefV1.js';
import {
  normalizeWorkflowActionTextBindingV1,
  readWorkflowActionFieldTextEncodingV1,
  renderWorkflowActionTextV1,
  type WorkflowActionTextDocumentV1,
} from './workflowActionTextV1.js';
import { WorkflowActionLeafV1Schema } from './workflowLeafV1.js';
import { validateWorkflowDefinition } from './workflowValidationV1.js';
import type { WorkflowActionFieldBindingV1 } from './workflowLeafV1.js';

function token(label: string, index: number | string) {
  const reference = {
    kind: MENTION_KIND_V1.workflowInput,
    ref: `workflowInput:${index}`,
    label,
  };
  return { ...reference, token: formatInlineReferenceTokenV1(reference) };
}

function documentOf(
  parts: readonly (string | ReturnType<typeof token>)[],
): WorkflowActionTextDocumentV1 {
  const references = parts.filter(
    (part): part is ReturnType<typeof token> => typeof part !== 'string',
  );
  return {
    text: parts
      .map((part) => (typeof part === 'string' ? part : part.token))
      .join(''),
    references,
  };
}

const run = token('Run', 0);
const branch = token('Branch', 1);

describe('workflow Action text substitution', () => {
  it('renders an absent value as empty text while preserving a present null', () => {
    const document = documentOf(['Event: ', run, '; null: ', branch]);
    for (const encoding of ['plain', 'url'] as const) {
      expect(renderWorkflowActionTextV1(document, encoding, index => index === 0 ? undefined : null))
        .toEqual({ ok: true, value: 'Event: ; null: null' });
    }
  });

  it('substitutes bound tokens as plain text and leaves unbound token text literal', () => {
    const unbound = formatInlineReferenceTokenV1({
      label: 'Nobody',
      ref: 'workflowInput:5',
    });
    const document = {
      ...documentOf(['Build ', run, ' on ', branch, ' failed']),
      text: `${documentOf(['Build ', run, ' on ', branch, ' failed']).text} ${unbound}`,
    };
    const values = ['#42', { name: 'main' }];
    expect(
      renderWorkflowActionTextV1(document, 'plain', (index) => values[index]!),
    ).toEqual({
      ok: true,
      value: `Build #42 on {"name":"main"} failed ${unbound}`,
    });
  });

  it('percent-encodes values only in fields that declare a URL', () => {
    const document = documentOf(['https://example.test/search?q=', run]);
    expect(
      renderWorkflowActionTextV1(document, 'url', () => 'a b&c=/d'),
    ).toEqual({
      ok: true,
      value: 'https://example.test/search?q=a%20b%26c%3D%2Fd',
    });
    expect(
      renderWorkflowActionTextV1(document, 'plain', () => 'a b&c=/d'),
    ).toEqual({ ok: true, value: 'https://example.test/search?q=a b&c=/d' });
  });

  it('reads a JSON field as JSON source with each value JSON-encoded, and reports a source that does not parse', () => {
    expect(
      renderWorkflowActionTextV1(
        documentOf(['{"text":', run, ',"count":', branch, '}']),
        'json',
        (index) => ['say "hi"\n', 3][index]!,
      ),
    ).toEqual({ ok: true, value: { text: 'say "hi"\n', count: 3 } });
    expect(
      renderWorkflowActionTextV1(
        documentOf(['{"text": "', run, '"}']),
        'json',
        () => 'x',
      ),
    ).toEqual({ ok: false });
  });

  it('decides the encoding once from the field declared type', () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        url: { type: 'string', format: 'uri' },
        link: { type: 'string', format: 'url' },
        body: {},
        payload: { type: 'object' },
        count: { type: 'integer' },
        tags: { type: 'array' },
      },
    };
    expect(
      [
        'title',
        'url',
        'link',
        'body',
        'payload',
        'count',
        'tags',
        'missing',
      ].map((field) => readWorkflowActionFieldTextEncodingV1(schema, field)),
    ).toEqual([
      'plain',
      'url',
      'url',
      'plain',
      'json',
      'json',
      'json',
      'plain',
    ]);
    expect(readWorkflowActionFieldTextEncodingV1(null, 'title')).toBe('plain');
    // Frozen Action contracts share subschemas by local pointer; keywords beside the pointer still apply.
    const frozen = { type: 'object', definitions: { text: { type: 'string' }, list: { type: 'array' } }, properties: {
      title: { $ref: '#/definitions/text' }, link: { $ref: '#/definitions/text', format: 'uri' }, tags: { $ref: '#/definitions/list' },
      loop: { $ref: '#/definitions/missing' },
    } };
    expect(['title', 'link', 'tags', 'loop'].map(field => readWorkflowActionFieldTextEncodingV1(frozen, field)))
      .toEqual(['plain', 'url', 'json', 'plain']);
  });

  it('normalizes an edited field to the narrowest binding and renumbers only the values its text uses', () => {
    const unused = { kind: 'literal' as const, value: 'unused' };
    const runValue = { kind: 'input' as const, name: 'run' };
    const branchValue = { kind: 'input' as const, name: 'branch' };
    expect(
      normalizeWorkflowActionTextBindingV1({
        kind: 'text',
        document: { text: 'plain words', references: [] },
        input: [runValue],
      }),
    ).toEqual({ kind: 'literal', value: 'plain words' });
    expect(
      normalizeWorkflowActionTextBindingV1({
        kind: 'text',
        document: documentOf([branch]),
        input: [unused, branchValue],
      }),
    ).toEqual(branchValue);
    const normalized = normalizeWorkflowActionTextBindingV1({
      kind: 'text',
      document: documentOf([branch, ' then ', branch]),
      input: [unused, branchValue],
    });
    expect(normalized).toEqual({
      kind: 'text',
      input: [branchValue],
      // One record binds every copy of the same token.
      document: { text: `${token('Branch', 0).token} then ${token('Branch', 0).token}`, references: [token('Branch', 0)] },
    });
    // A token that addresses no binding is an invalid draft; validation names it, normalization keeps it.
    const invalid: WorkflowActionFieldBindingV1 = {
      kind: 'text',
      document: documentOf(['x ', token('Gone', 3)]),
      input: [runValue],
    };
    expect(normalizeWorkflowActionTextBindingV1(invalid)).toBe(invalid);
  });

  it('keeps authored command text literal and accepts substitution in an ordinary string field', () => {
    const text: WorkflowActionFieldBindingV1 = {
      kind: 'text',
      document: documentOf(['echo ', run]),
      input: [{ kind: 'input', name: 'run' }],
    };
    expect(
      WorkflowActionLeafV1Schema.safeParse({
        kind: 'action',
        id: 'cmd',
        actionId: 'machines.command.run',
        input: { command: text },
      }).success,
    ).toBe(false);
    expect(
      WorkflowActionLeafV1Schema.safeParse({
        kind: 'action',
        id: 'hook',
        actionId: 'webhooks.call',
        input: { url: text },
      }).success,
    ).toBe(true);
  });

  it('validates every inserted value at save time through the same reference scope as the Insert list', () => {
    const validation = validateWorkflowDefinition({
      version: 1,
      inputs: [{ name: 'run', valueType: 'string', required: true }],
      defaults: {
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        },
      },
      blocks: [
        {
          kind: 'action',
          id: 'hook',
          actionId: 'webhooks.call',
          input: {
            url: {
              kind: 'text',
              document: documentOf([
                'https://x.test/',
                run,
                '/',
                branch,
                '/',
                token('Gone', 2),
              ]),
              input: [
                { kind: 'input', name: 'run' },
                { kind: 'input', name: 'nope' },
              ],
            },
            body: { kind: 'literal', value: {} },
          },
        },
      ],
    });
    const paths = validation.issues.map(
      (issue) => `${issue.code} ${issue.path}`,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        'missing_reference /blocks/0/input/url/input/1/name',
        'missing_reference /blocks/0/input/url/document/references/1/ref',
        'invalid_input /blocks/0/input/url/document/references/2/ref',
      ]),
    );
    expect(paths.filter((path) => path.includes('/references/0/'))).toEqual([]);
  });

  it('refuses a non-value mention inside an Action text field', () => {
    const file = {
      kind: MENTION_KIND_V1.file,
      ref: 'file:README.md',
      label: 'README',
      token: formatInlineReferenceTokenV1({
        label: 'README',
        ref: 'file:README.md',
      }),
    };
    const validation = validateWorkflowDefinition({
      version: 1,
      inputs: [],
      defaults: {
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        },
      },
      blocks: [
        {
          kind: 'action',
          id: 'hook',
          actionId: 'webhooks.call',
          input: {
            url: {
              kind: 'text',
              document: {
                text: `https://x.test/${file.token}`,
                references: [file],
              },
              input: [],
            },
            body: { kind: 'literal', value: {} },
          },
        },
      ],
    });
    expect(
      validation.issues.map((issue) => `${issue.code} ${issue.path}`),
    ).toContain('invalid_input /blocks/0/input/url/document/references/0/ref');
  });
});
