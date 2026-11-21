import { describe, expect, it } from 'vitest';
import { parsePreflightModelListFromProbeModelsResult } from './parsePreflightModelListFromProbeModelsResult';

describe('model probe capability projection', () => {
    it('retains the dynamic source of a successful connected-account probe', () => {
        expect(parsePreflightModelListFromProbeModelsResult({
            source: 'dynamic',
            availableModels: [{ id: 'meta/muse-spark-1.2', name: 'muse-spark-1.2' }],
            supportsFreeform: false,
        })?.source).toBe('dynamic');
    });

    it('rejects malformed capability evidence rather than turning it into a capability-free offered model', () => {
        expect(parsePreflightModelListFromProbeModelsResult({ availableModels: [
            { id: 'invalid-model', name: 'Invalid model', capabilities: { structuredOutput: true } },
        ], supportsFreeform: false })).toBeNull();
    });
    it('retains explicit unsupported truth for offered models rather than allowing agent defaults to override it', () => {
        expect(parsePreflightModelListFromProbeModelsResult({ availableModels: [
            { id: 'offered-model', name: 'Offered model', capabilities: { structuredOutput: 'unsupported' } },
        ], supportsFreeform: false })?.availableModels[0]).toMatchObject({ capabilities: { structuredOutput: 'unsupported' } });
    });
});
