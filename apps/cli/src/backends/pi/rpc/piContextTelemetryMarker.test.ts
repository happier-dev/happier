import { describe, expect, it } from 'vitest';

import { PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE } from '../bridgeExtension/piBridgeExtensionEnv';

import {
  buildPiContextTelemetryKeySuffix,
  mergePiContextTelemetryIntoTokens,
  parsePiContextTelemetryMarkerLine,
} from './piContextTelemetryMarker';

describe('parsePiContextTelemetryMarkerLine', () => {
  it('parses a well-formed marker', () => {
    expect(
      parsePiContextTelemetryMarkerLine(
        `{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":38421,"size":200000}`,
      ),
    ).toEqual({ used: 38421, size: 200000 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(
      parsePiContextTelemetryMarkerLine(
        `  {"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":10,"size":20}  `,
      ),
    ).toEqual({ used: 10, size: 20 });
  });

  it('rejects non-JSON, non-object, and wrong-type lines', () => {
    expect(parsePiContextTelemetryMarkerLine('some warning text')).toBeNull();
    expect(parsePiContextTelemetryMarkerLine('[1,2,3]')).toBeNull();
    expect(parsePiContextTelemetryMarkerLine('null')).toBeNull();
    expect(parsePiContextTelemetryMarkerLine('{"type":"usage_limit_reached"}')).toBeNull();
    expect(parsePiContextTelemetryMarkerLine('{"used":10,"size":20}')).toBeNull();
  });

  it('rejects missing, negative, non-finite, or zero fields', () => {
    expect(parsePiContextTelemetryMarkerLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":0,"size":20}`)).toBeNull();
    expect(parsePiContextTelemetryMarkerLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":10,"size":0}`)).toBeNull();
    expect(parsePiContextTelemetryMarkerLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":-1,"size":20}`)).toBeNull();
    expect(parsePiContextTelemetryMarkerLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":10}`)).toBeNull();
    expect(parsePiContextTelemetryMarkerLine(`{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","size":20}`)).toBeNull();
  });

  it('truncates fractional values', () => {
    expect(
      parsePiContextTelemetryMarkerLine(
        `{"type":"${PI_BRIDGE_TOKEN_COUNT_MARKER_TYPE}","used":38421.9,"size":200000.4}`,
      ),
    ).toEqual({ used: 38421, size: 200000 });
  });
});

describe('mergePiContextTelemetryIntoTokens', () => {
  it('adds the context keys the UI usage extraction reads', () => {
    const tokens = mergePiContextTelemetryIntoTokens({ input: 5, output: 6 }, { used: 11, size: 22 });
    expect(tokens).toEqual({
      input: 5,
      output: 6,
      context_used_tokens: 11,
      context_window_tokens: 22,
    });
  });

  it('works on an empty tokens map (telemetry-only emission)', () => {
    expect(mergePiContextTelemetryIntoTokens({}, { used: 1, size: 2 })).toEqual({
      context_used_tokens: 1,
      context_window_tokens: 2,
    });
  });
});

describe('buildPiContextTelemetryKeySuffix', () => {
  it('encodes used/size so a context change re-publishes', () => {
    expect(buildPiContextTelemetryKeySuffix({ used: 5, size: 100 })).toBe(':ctx5/100');
    expect(buildPiContextTelemetryKeySuffix({ used: 6, size: 100 })).not.toBe(
      buildPiContextTelemetryKeySuffix({ used: 5, size: 100 }),
    );
  });
});
