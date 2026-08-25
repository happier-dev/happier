import { describe, expect, it } from 'vitest';

import {
  normalizeTerminalNativeEvent,
  TERMINAL_NATIVE_EVENT_NAMES,
} from './events';

describe('terminal native event normalization', () => {
  it('normalizes every declared native event payload', () => {
    expect(TERMINAL_NATIVE_EVENT_NAMES).toEqual([
      'rendererCrash',
      'surfaceReady',
      'writeAck',
      'input',
      'resize',
      'link',
      'selection',
      'copy',
      'title',
      'bell',
    ]);

    expect(normalizeTerminalNativeEvent('rendererCrash', {
      surfaceId: 'surface-1',
      reason: 'native renderer crashed',
      fatal: true,
    })).toEqual({
      surfaceId: 'surface-1',
      reason: 'native renderer crashed',
      fatal: true,
    });

    expect(normalizeTerminalNativeEvent('rendererCrash', {
      surfaceId: 'surface-1',
      reason: 'native renderer crashed',
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('surfaceReady', {
      surfaceId: 'surface-1',
      cols: 120,
      rows: 40,
    })).toEqual({
      surfaceId: 'surface-1',
      cols: 120,
      rows: 40,
    });

    expect(normalizeTerminalNativeEvent('writeAck', {
      surfaceId: 'surface-1',
      byteOffset: 4096,
    })).toEqual({
      surfaceId: 'surface-1',
      byteOffset: 4096,
    });

    expect(normalizeTerminalNativeEvent('input', {
      surfaceId: 'surface-1',
      data: '\u001b[A',
    })).toEqual({
      surfaceId: 'surface-1',
      data: '\u001b[A',
    });

    expect(normalizeTerminalNativeEvent('resize', {
      surfaceId: 'surface-1',
      cols: 132,
      rows: 43,
    })).toEqual({
      surfaceId: 'surface-1',
      cols: 132,
      rows: 43,
    });

    expect(normalizeTerminalNativeEvent('link', {
      surfaceId: 'surface-1',
      url: 'https://example.test',
      text: 'example',
    })).toEqual({
      surfaceId: 'surface-1',
      url: 'https://example.test',
      text: 'example',
    });

    expect(normalizeTerminalNativeEvent('selection', {
      surfaceId: 'surface-1',
      state: 'changed',
      text: 'selected output',
    })).toEqual({
      surfaceId: 'surface-1',
      state: 'changed',
      text: 'selected output',
    });

    expect(normalizeTerminalNativeEvent('copy', {
      surfaceId: 'surface-1',
      text: 'copied output',
    })).toEqual({
      surfaceId: 'surface-1',
      text: 'copied output',
    });

    expect(normalizeTerminalNativeEvent('title', {
      surfaceId: 'surface-1',
      title: 'terminal title',
    })).toEqual({
      surfaceId: 'surface-1',
      title: 'terminal title',
    });

    expect(normalizeTerminalNativeEvent('bell', {
      surfaceId: 'surface-1',
      label: 'ding',
    })).toEqual({
      surfaceId: 'surface-1',
      label: 'ding',
    });

    expect(normalizeTerminalNativeEvent('bell', {
      surfaceId: 'surface-1',
    })).toEqual({
      surfaceId: 'surface-1',
    });
  });

  it('rejects malformed native event payloads', () => {
    expect(normalizeTerminalNativeEvent('writeAck', {
      surfaceId: 'surface-1',
      byteOffset: -1,
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('surfaceReady', {
      surfaceId: 'surface-1',
      cols: 80,
      rows: 0,
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('input', {
      surfaceId: 'surface-1',
      data: '',
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('resize', {
      surfaceId: 'surface-1',
      cols: 0,
      rows: 24,
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('link', {
      surfaceId: 'surface-1',
      url: '',
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('selection', {
      surfaceId: 'surface-1',
      state: 'unknown',
      text: 'selected output',
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('copy', {
      surfaceId: 'surface-1',
      text: '',
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('title', {
      surfaceId: 'surface-1',
      title: '',
    })).toBeNull();

    expect(normalizeTerminalNativeEvent('bell', {
      label: 'ding',
    })).toBeNull();
  });
});
