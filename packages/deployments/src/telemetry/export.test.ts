import { describe, expect, it } from 'vitest';
import { buildTelemetrySamplingVariablesV1, encodeTelemetryAuthorizationHeaderV1 } from './export.js';

describe('telemetry export variables', () => {
    it('leaves the SDK default alone until a person deliberately selects sampling', () => {
        expect(buildTelemetrySamplingVariablesV1()).toEqual({});
        expect(buildTelemetrySamplingVariablesV1(0.25)).toEqual({
            OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.25',
        });
        expect(buildTelemetrySamplingVariablesV1(0).OTEL_TRACES_SAMPLER_ARG).toBe('0');
        expect(buildTelemetrySamplingVariablesV1(1).OTEL_TRACES_SAMPLER_ARG).toBe('1');
        for (const ratio of [-0.1, 1.1, NaN, Infinity]) expect(() => buildTelemetrySamplingVariablesV1(ratio)).toThrow(RangeError);
    });

    it('encodes a bearer as one OTLP header value', () => {
        expect(encodeTelemetryAuthorizationHeaderV1('a/b+c=,d%')).toBe('Authorization=Bearer%20a%2Fb%2Bc%3D%2Cd%25');
    });
});
