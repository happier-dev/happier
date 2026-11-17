import { expect, it } from 'vitest';
import { normalizeOtlpEnvelope } from './normalization.js';

function span(attributes: Record<string, string | number | boolean>) {
    return { traceId: '1234567890abcdef1234567890abcdef', spanId: '1234567890abcdef', kind: 3,
        name: 'chat', startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000',
        attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: typeof value === 'string'
            ? { stringValue: value } : typeof value === 'boolean' ? { boolValue: value }
                : Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value } })) };
}
function normalized(attributes: Record<string, string | number | boolean>) {
    return normalizeOtlpEnvelope('traces', { resourceSpans: [{ scopeSpans: [{ spans: [span(attributes)] }] }] },
        () => { throw new Error('No database statement in gen_ai fixture'); }).spans[0];
}

it('normalizes numeric GenAI attempt usage without prompts, completions, tool arguments or fabricated parent calls', () => {
    const result = normalized({ 'gen_ai.provider.name': 'openai', 'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'requested', 'gen_ai.response.model': 'actual',
        'gen_ai.usage.input_tokens': 100, 'gen_ai.usage.output_tokens': 30,
        'gen_ai.usage.cache_read.input_tokens': 20, 'gen_ai.usage.cache_creation.input_tokens': 0,
        'gen_ai.usage.reasoning.output_tokens': 10,
        'gen_ai.input.messages': 'private-prompt', 'gen_ai.output.messages': 'private-completion',
        'gen_ai.tool.call.arguments': 'private-tool' });
    expect(result).toMatchObject({ genAi: { provider: 'openai', requestedModel: 'requested', modelId: 'actual', operation: 'chat',
        tokens: { input: 100, output: 30, cacheRead: 20, cacheWrite: 0, reasoning: 10, total: null },
        // The registry says SHOULD include cache/reasoning, not MUST. An un-witnessed inclusion is unknown.
        tokenCategories: null, reportedCost: null } });
    expect(JSON.stringify(result)).not.toMatch(/private-prompt|private-completion|private-tool/);
    expect(normalized({ 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.request.model': 'actual' })).not.toHaveProperty('genAi');
});

it('keeps malformed or missing counters unknown and accepts legacy model/provider token metadata', () => {
    expect(normalized({ 'gen_ai.system': 'openai', 'gen_ai.request.model': 'legacy',
        'gen_ai.usage.prompt_tokens': 5, 'gen_ai.usage.completion_tokens': -1 })).toMatchObject({ genAi: {
            provider: 'openai', modelId: 'legacy', tokens: { input: 5, output: null, cacheRead: null, cacheWrite: null, reasoning: null, total: null },
            tokenCategories: null } });
});

it('accepts numeric reported amounts only with their explicit currency, including OTLP int64 values', () => {
    for (const amount of [0, 1, 0.25]) {
        expect(normalized({ 'gen_ai.usage.cost': amount, 'gen_ai.usage.cost.currency': 'EUR' }))
            .toMatchObject({ genAi: { reportedCost: { amount, currency: 'EUR' } } });
    }
    expect(normalized({ 'gen_ai.usage.cost': 1 })).not.toHaveProperty('genAi');
    expect(normalized({ 'gen_ai.usage.input_tokens': '50' })).not.toHaveProperty('genAi');
});
