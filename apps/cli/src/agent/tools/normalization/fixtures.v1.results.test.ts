import { describe, expect, it } from 'vitest';

import { canonicalizeToolNameV2, normalizeToolCallV2, normalizeToolResultV2 } from './index';
import {
  asRecord,
  asToolNormalizationProtocol,
  firstFixtureEvent,
  getCallIdFromEvent,
  loadFixtureV1,
} from './fixtures.v1.testkit';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

describe('tool normalization fixtures (v1): tool results', () => {
  it('normalizes tool-result events into objects with V2 metadata (using tool-call mappings when available)', () => {
    const fixtures = loadFixtureV1();
    const callIdToTool = new Map<string, { canonicalToolName: string; rawToolName: string }>();

    for (const events of Object.values(fixtures.examples)) {
      for (const event of events) {
        if (event.kind !== 'tool-call') continue;
        const payload = asRecord(event.payload) ?? {};
        const callId = typeof payload.callId === 'string' ? payload.callId : null;
        if (!callId) continue;
        const toolName = String(payload.name ?? '');
        const normalized = normalizeToolCallV2({
          protocol: asToolNormalizationProtocol(event.protocol),
          provider: String(event.provider ?? 'unknown'),
          toolName,
          rawInput: payload.input,
          callId,
        });
        callIdToTool.set(`${event.protocol}/${event.provider}/${callId}`, {
          canonicalToolName: normalized.canonicalToolName,
          rawToolName: toolName,
        });
      }
    }

    for (const events of Object.values(fixtures.examples)) {
      for (const event of events) {
        if (event.kind !== 'tool-result' && event.kind !== 'tool-call-result') continue;

        const callId = getCallIdFromEvent(event);
        if (!callId) continue;

        const key = `${event.protocol}/${event.provider}/${callId}`;
        const mapping = callIdToTool.get(key);
        const canonicalToolName =
          mapping?.canonicalToolName ??
          canonicalizeToolNameV2({ protocol: asToolNormalizationProtocol(event.protocol), toolName: 'Unknown' });
        const rawToolName = mapping?.rawToolName ?? 'unknown';

        const payload = asRecord(event.payload) ?? {};
        const rawOutput = payload.output;

        const normalized = normalizeToolResultV2({
          protocol: asToolNormalizationProtocol(event.protocol),
          provider: String(event.provider ?? 'unknown'),
          rawToolName,
          canonicalToolName,
          rawOutput,
        });

        const outRecord = asRecord(normalized);
        expect(outRecord).toBeTruthy();
        expect(asRecord(outRecord?._happier)).toMatchObject({
          v: 2,
          protocol: event.protocol,
          provider: event.provider,
        });
        expect(outRecord?._raw).toBeDefined();

        if (canonicalToolName === 'Bash') {
          const stdout = outRecord?.stdout;
          expect(stdout == null || typeof stdout === 'string').toBe(true);
        }
        if (canonicalToolName === 'Read') {
          const file = asRecord(outRecord?.file);
          if (typeof rawOutput === 'string') {
            expect(file).toBeTruthy();
            expect(typeof file?.content).toBe('string');
            if (rawOutput.includes('<file>')) expect(typeof file?.startLine).toBe('number');
          }
        }
        if (canonicalToolName === 'Reasoning') {
          const content = outRecord?.content;
          expect(content == null || typeof content === 'string').toBe(true);
        }
        if (canonicalToolName === 'TodoWrite' || canonicalToolName === 'TodoRead') {
          const todos = outRecord?.todos;
          expect(Array.isArray(todos)).toBe(true);
          if (Array.isArray(todos) && todos.length > 0) {
            const first = asRecord(todos[0]);
            expect(typeof first?.content).toBe('string');
            expect(typeof first?.status).toBe('string');
          }
        }
        if (canonicalToolName === 'Patch') {
          const raw = asRecord(rawOutput);
          const rawApplied =
            typeof raw?.success === 'boolean'
              ? raw.success
              : typeof raw?.ok === 'boolean'
                ? raw.ok
                : typeof raw?.applied === 'boolean'
                  ? raw.applied
                  : null;
          if (typeof rawApplied === 'boolean') expect(outRecord?.applied).toBe(rawApplied);
          const stdout = outRecord?.stdout;
          const stderr = outRecord?.stderr;
          expect(stdout == null || typeof stdout === 'string').toBe(true);
          expect(stderr == null || typeof stderr === 'string').toBe(true);
        }
        if (canonicalToolName === 'Glob') {
          const matches = outRecord?.matches;
          expect(Array.isArray(matches)).toBe(true);
          if (Array.isArray(matches) && matches.length > 0) expect(isStringArray(matches)).toBe(true);
        }
        if (canonicalToolName === 'Grep') {
          const matches = outRecord?.matches;
          expect(Array.isArray(matches)).toBe(true);
          if (Array.isArray(matches) && matches.length > 0) {
            const first = asRecord(matches[0]);
            const hasFilePath = typeof first?.filePath === 'string';
            const hasExcerpt = typeof first?.excerpt === 'string';
            expect(hasFilePath || hasExcerpt).toBe(true);
          }
        }
        if (canonicalToolName === 'CodeSearch') {
          const matches = outRecord?.matches;
          expect(Array.isArray(matches)).toBe(true);
          if (Array.isArray(matches) && matches.length > 0) {
            const first = asRecord(matches[0]);
            const hasFilePath = typeof first?.filePath === 'string';
            const hasExcerpt = typeof first?.excerpt === 'string';
            expect(hasFilePath || hasExcerpt).toBe(true);
          }
        }
        if (canonicalToolName === 'LS') {
          const entries = outRecord?.entries;
          expect(Array.isArray(entries)).toBe(true);
          if (Array.isArray(entries) && entries.length > 0) expect(isStringArray(entries)).toBe(true);
        }
      }
    }
  });

  it('normalizes web tool results into stable schemas (WebSearch.results[], WebFetch.status/text/errorMessage)', () => {
    const fixtures = loadFixtureV1();
    const fetchCalls = fixtures.examples['acp/auggie/tool-call/fetch'];
    const fetchResults = fixtures.examples['acp/auggie/tool-result/fetch'];

    expect(fetchCalls).toBeTruthy();
    expect(fetchResults).toBeTruthy();

    const pickCall = (predicate: (input: Record<string, unknown>) => boolean) => {
      const event = fetchCalls?.find((candidate) => predicate(asRecord(asRecord(candidate.payload)?.input) ?? {}));
      expect(event).toBeTruthy();
      return event as NonNullable<typeof event>;
    };

    const pickResultByCallId = (callId: string) => {
      const event = fetchResults?.find((candidate) => asRecord(candidate.payload)?.callId === callId);
      expect(event).toBeTruthy();
      return event as NonNullable<typeof event>;
    };

    {
      const call = pickCall((input) => typeof input.query === 'string' && String(input.query).includes('TypeScript'));
      const callPayload = asRecord(call.payload) ?? {};
      const callId = String(callPayload.callId ?? '');
      const callNorm = normalizeToolCallV2({
        protocol: 'acp',
        provider: 'auggie',
        toolName: String(callPayload.name ?? ''),
        rawInput: callPayload.input,
        callId,
      });
      expect(callNorm.canonicalToolName).toBe('WebSearch');

      const result = pickResultByCallId(callId);
      const resultPayload = asRecord(result.payload) ?? {};
      const normalized = normalizeToolResultV2({
        protocol: 'acp',
        provider: 'auggie',
        rawToolName: 'fetch',
        canonicalToolName: callNorm.canonicalToolName,
        rawOutput: resultPayload.output,
      });
      expect(Array.isArray(asRecord(normalized)?.results)).toBe(true);
    }

    {
      const call = pickCall((input) => typeof input.url === 'string' && String(input.url).includes('example.com'));
      const callPayload = asRecord(call.payload) ?? {};
      const callId = String(callPayload.callId ?? '');
      const callNorm = normalizeToolCallV2({
        protocol: 'acp',
        provider: 'auggie',
        toolName: String(callPayload.name ?? ''),
        rawInput: callPayload.input,
        callId,
      });
      expect(callNorm.canonicalToolName).toBe('WebFetch');

      const result = pickResultByCallId(callId);
      const resultPayload = asRecord(result.payload) ?? {};
      const normalized = normalizeToolResultV2({
        protocol: 'acp',
        provider: 'auggie',
        rawToolName: 'fetch',
        canonicalToolName: callNorm.canonicalToolName,
        rawOutput: resultPayload.output,
      });
      const out = asRecord(normalized);
      const hasText = typeof out?.text === 'string' && out.text.length > 0;
      const hasError = typeof out?.errorMessage === 'string' && out.errorMessage.length > 0;
      expect(hasText || hasError).toBe(true);
    }
  });
});
