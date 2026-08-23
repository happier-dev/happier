import { describe, expect, it } from 'vitest';

import {
  isSlashCommandSupported,
  readLeadingSlashCommandName,
  normalizeSlashCommandName,
  readSlashCommandNames,
} from './slashCommands.js';

describe('readLeadingSlashCommandName', () => {
  it('extracts only a leading slash command token', () => {
    expect(readLeadingSlashCommandName('/goal fix authentication')).toBe('goal');
    expect(readLeadingSlashCommandName('  /SKILL:Review  ')).toBe('skill:review');
    expect(readLeadingSlashCommandName('run /goal')).toBeNull();
    expect(readLeadingSlashCommandName('//goal')).toBeNull();
  });
});

describe('normalizeSlashCommandName', () => {
  it('normalizes goal and /goal to the same name', () => {
    expect(normalizeSlashCommandName('goal')).toBe('goal');
    expect(normalizeSlashCommandName('/goal')).toBe('goal');
  });

  it('trims and lowercases', () => {
    expect(normalizeSlashCommandName('  /GOAL  ')).toBe('goal');
  });

  it('strips only a single leading slash', () => {
    expect(normalizeSlashCommandName('//goal')).toBe('/goal');
  });

  it('rejects empty, slash-only, and non-string values', () => {
    expect(normalizeSlashCommandName('')).toBe(null);
    expect(normalizeSlashCommandName('   ')).toBe(null);
    expect(normalizeSlashCommandName('/')).toBe(null);
    expect(normalizeSlashCommandName(123)).toBe(null);
    expect(normalizeSlashCommandName(null)).toBe(null);
    expect(normalizeSlashCommandName(undefined)).toBe(null);
  });
});

describe('readSlashCommandNames', () => {
  it('normalizes every entry and drops malformed ones', () => {
    expect(readSlashCommandNames(['goal', '/clear', '', 7, '  /Help '])).toEqual(['goal', 'clear', 'help']);
  });

  it('returns an empty list for a non-array (fail-closed)', () => {
    expect(readSlashCommandNames(undefined)).toEqual([]);
    expect(readSlashCommandNames('goal')).toEqual([]);
    expect(readSlashCommandNames(null)).toEqual([]);
  });
});

describe('isSlashCommandSupported', () => {
  it('matches goal whether the list carries goal or /goal', () => {
    expect(isSlashCommandSupported(['goal'], 'goal')).toBe(true);
    expect(isSlashCommandSupported(['/goal'], 'goal')).toBe(true);
    expect(isSlashCommandSupported(['goal'], '/goal')).toBe(true);
  });

  it('is fail-closed for a non-array list or unknown command', () => {
    expect(isSlashCommandSupported(undefined, 'goal')).toBe(false);
    expect(isSlashCommandSupported(['clear'], 'goal')).toBe(false);
    expect(isSlashCommandSupported(['goal'], '')).toBe(false);
  });
});
