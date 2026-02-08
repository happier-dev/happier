import { describe, expect, it } from 'vitest';

import { parseClear, parseCompact, parseSpecialCommand } from './specialCommands';

describe('parseCompact', () => {
  it.each([
    { message: '/compact optimize the code', isCompact: true, originalMessage: '/compact optimize the code' },
    { message: '/compact', isCompact: true, originalMessage: '/compact' },
    { message: '  /compact test  ', isCompact: true, originalMessage: '/compact test' },
    { message: 'hello world', isCompact: false, originalMessage: 'hello world' },
    { message: 'please /compact this', isCompact: false, originalMessage: 'please /compact this' },
    { message: '/compactor', isCompact: false, originalMessage: '/compactor' },
  ])('parses "$message"', ({ message, isCompact, originalMessage }) => {
    const result = parseCompact(message);
    expect(result.isCompact).toBe(isCompact);
    expect(result.originalMessage).toBe(originalMessage);
  });
});

describe('parseClear', () => {
  it.each([
    { message: '/clear', isClear: true },
    { message: '  /clear  ', isClear: true },
    { message: '/clear something', isClear: false },
    { message: '/clearing', isClear: false },
    { message: 'hello world', isClear: false },
  ])('parses "$message"', ({ message, isClear }) => {
    expect(parseClear(message).isClear).toBe(isClear);
  });
});

describe('parseSpecialCommand', () => {
  it.each([
    { message: '/compact optimize', expectedType: 'compact', expectedOriginal: '/compact optimize' },
    { message: '  /compact optimize  ', expectedType: 'compact', expectedOriginal: '/compact optimize' },
    { message: '/clear', expectedType: 'clear', expectedOriginal: undefined },
    { message: '  /clear  ', expectedType: 'clear', expectedOriginal: undefined },
    { message: 'hello world', expectedType: null, expectedOriginal: undefined },
    { message: 'some /compact text', expectedType: null, expectedOriginal: undefined },
    { message: '/compactor', expectedType: null, expectedOriginal: undefined },
    { message: '/clearing', expectedType: null, expectedOriginal: undefined },
  ])('parses "$message"', ({ message, expectedType, expectedOriginal }) => {
    const result = parseSpecialCommand(message);
    expect(result.type).toBe(expectedType);
    expect(result.originalMessage).toBe(expectedOriginal);
  });
});
