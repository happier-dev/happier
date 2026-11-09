import { toolNormalizationSource } from './fixtures.v1.testkit';
import { describe, expect, it } from 'vitest';

import { canonicalizeToolNameV2, normalizeToolCallV2, normalizeToolResultV2 } from './index';
import { resolveCodeBuddyAcpToolName } from '../../../../../../packages/plugins/codebuddy/src/agent/runtime/factory';
import { buildAcpToolNameResolverInput } from '../../acp/toolCalls/toolNameResolverInput';
import { buildTurnChangeSetDiffInput } from '../diff/buildTurnChangeSetDiffInput';
import { prepareAcpTranscriptDispatch } from '@/api/session/outbound/transcriptDispatch';
import { readTurnChangeToolMetadata } from '@happier-dev/protocol/sessions/messages/canonicalTurnDiffTool';

it('preserves zero-file Diff correlation metadata through transcript dispatch', () => {
  const source = toolNormalizationSource('native', 'selected-agent');
  const input = buildTurnChangeSetDiffInput({ source, rawToolName: 'RepositoryCheckpointDiff',
    turnChangeSet: { sessionId: 'session', turnId: 'turn', provider: 'scm:git',
      seqRange: { startSeqInclusive: 1, endSeqInclusive: 1 }, status: 'completed', derivedAt: 1, files: [] },
  });
  const { normalizedBody } = prepareAcpTranscriptDispatch({ source, provider: 'selected-agent',
    body: { type: 'tool-call', name: 'Diff', callId: 'diff', id: 'message', input },
    toolCallCanonicalNameByProviderAndId: new Map(), permissionToolCallRawInputByProviderAndId: new Map(),
    toolCallInputByProviderAndId: new Map(),
  });
  if (normalizedBody.type !== 'tool-call') throw new Error('Expected a normalized tool call');
  expect(readTurnChangeToolMetadata(normalizedBody.input)).toMatchObject({
    provider: 'scm:git', sessionId: 'session', turnId: 'turn',
  });
  expect(normalizedBody.input).toMatchObject({ files: [], _happier: { v: 3, ...source } });
});

describe('normalizeToolResultV2 content envelopes', () => {
  it.each([
    ['Read', { file: { content: 'direct\nnested' } }],
    ['Write', { message: 'direct\nnested' }],
    ['WebFetch', { text: 'direct\nnested' }],
    ['WebSearch', { results: [{ snippet: 'direct\nnested' }] }],
  ])('decodes the shared envelope through %s family dispatch', (canonicalToolName, expected) => {
    expect(normalizeToolResultV2({
      source: toolNormalizationSource('acp', 'example-provider'),
      rawToolName: canonicalToolName,
      canonicalToolName,
      rawOutput: [{ text: 'direct' }, { content: { text: 'nested' } }],
    })).toMatchObject(expected);
  });
});

describe('canonicalizeToolNameV2', () => {
  it('keeps Delete inference for write tool names', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'write',
        toolInput: { title: 'Delete foo.txt' },
      }),
    ).toBe('Delete');
  });

  it('keeps Delete inference for edit tool names', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'edit',
        toolInput: { title: 'Delete foo.txt' },
      }),
    ).toBe('Delete');
  });

  it('infers CodeSearch for unknown tool names that carry a query', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { query: 'SEARCH_ME', description: 'Searching for: SEARCH_ME' },
      }),
    ).toBe('CodeSearch');
  });

  it('does not infer CodeSearch for unknown tool names that only carry freeform text', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'Something went wrong' },
      }),
    ).toBe('unknown');
  });

  it('infers CodeSearch for unknown tool names when text is paired with a location hint', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'needle', path: 'src/index.ts' },
      }),
    ).toBe('CodeSearch');
  });

  it('does not infer CodeSearch when locations is present but empty', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'needle', locations: [] },
      }),
    ).toBe('unknown');
  });

  it('infers Read for unknown ACP tools labeled as ReadFile', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: {
          description: 'ReadFile',
          _acp: { title: 'ReadFile' },
          items: [{ content: { text: '{"path":"README.md"}', type: 'text' }, type: 'content' }],
        },
      }),
    ).toBe('Read');
  });
});

describe('normalizeToolCallV2', () => {
  it('keeps edit entries non-empty when file path is provided at the tool-call level', () => {
    const normalized = normalizeToolCallV2({
      source: toolNormalizationSource('acp', 'example-provider'),
      toolName: 'edit',
      callId: 'tool-1',
      rawInput: {
        path: 'src/example.ts',
        edits: [{ oldText: 'before', newText: 'after' }],
      },
    });

    expect(normalized.canonicalToolName).toBe('MultiEdit');
    expect(normalized.input).toMatchObject({
      file_path: 'src/example.ts',
      edits: [
        {
          file_path: 'src/example.ts',
          old_string: 'before',
          new_string: 'after',
        },
      ],
      _happier: expect.objectContaining({
        v: 3,
        ...toolNormalizationSource('acp', 'example-provider'),
        rawToolName: 'edit',
        canonicalToolName: 'MultiEdit',
      }),
    });
  });
});

describe('generic tool input preservation', () => {
  it('replaces historical provenance with admitted source while preserving loose metadata', () => {
    const source = toolNormalizationSource('acp', 'fixture');
    const normalized = normalizeToolCallV2({ source, toolName: 'custom', rawInput: {
      _happier: { v: 2, protocol: 'claude', provider: 'old-agent', sessionMode: 'review', nativeAdjunct: true },
    } });
    expect(normalized.input).toMatchObject({ _happier: { v: 3, ...source, provider: 'old-agent', sessionMode: 'review', nativeAdjunct: true } });
    expect(normalized.input).toHaveProperty('_happier.rawToolName', 'custom');
  });

  it.each(['acp', 'native'])('leaves native wrappers to plugin codecs for %s observations', protocol => {
    const rawInput = { toolName: 'Bash', params: { command: 'pwd' }, _acp: { kind: 'other', title: 'DeferExecuteTool' } };
    const normalized = normalizeToolCallV2({ source: toolNormalizationSource(protocol, 'fixture'), toolName: 'other', rawInput });
    expect(normalized.canonicalToolName).toBe('other');
    expect(normalized.input).toMatchObject(rawInput);
  });
});

describe('native plugin codec followed by generic normalization', () => {
  it.each([
    { toolName: 'TaskList', params: {}, canonical: 'SubAgent', input: { operation: 'list' } },
    { toolName: 'Bash', params: { command: `happier tools call --source happier --tool change_title --args-json '{"title":"QA"}' --json` },
      canonical: 'change_title', input: { title: 'QA' } },
    { toolName: 'mcp__github__search_issues', params: { query: 'is:open' },
      canonical: 'mcp__github__search_issues', input: { query: 'is:open' } },
  ])('preserves the inner $toolName semantics', ({ toolName, params, canonical, input }) => {
    const resolved = resolveCodeBuddyAcpToolName({ toolName: 'other', toolCallId: 'deferred',
      input: buildAcpToolNameResolverInput({ toolName, params }, 'DeferExecuteTool', 'other'),
      context: { toolCallCountSincePrompt: 0 } });
    if (!resolved || typeof resolved === 'string') throw new Error('Expected a decoded native invocation');
    const normalized = normalizeToolCallV2({ source: toolNormalizationSource('acp', 'codebuddy'),
      toolName: resolved.toolName, rawInput: resolved.input });
    expect(normalized.canonicalToolName).toBe(canonical);
    expect(normalized.input).toMatchObject(input);
  });
});
