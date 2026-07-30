import { describe, expect, it } from 'vitest';

import {
  CodingPromptBehaviorOverrideV1Schema,
  resolveCodingPromptBehaviorV1WithOverride,
  applyCodingPromptBehaviorOverrideToSettings,
  DEFAULT_CODING_PROMPT_BEHAVIOR_V1,
} from './codingPromptBehaviorV1.js';

describe('codingPromptBehaviorV1 (overrides)', () => {
  describe('resolveCodingPromptBehaviorV1WithOverride', () => {
    it('omitted field inherits global', () => {
      const settings = { codingPromptBehaviorV1: {} };
      const override: any = {}; // empty override

      const result = resolveCodingPromptBehaviorV1WithOverride({
        settingsLike: settings,
        override,
      });

      expect(result).toEqual(DEFAULT_CODING_PROMPT_BEHAVIOR_V1);
    });

    it('set field wins', () => {
      const settings = { codingPromptBehaviorV1: {} };
      const override = { responseOptions: 'disabled' as const };

      const result = resolveCodingPromptBehaviorV1WithOverride({
        settingsLike: settings,
        override,
      });

      expect(result).toEqual({
        v: 1,
        sessionTitleUpdates: 'ongoing', // from global default
        responseOptions: 'disabled',   // from override
      });
    });

    it('\'agent\' alias folds to \'ongoing\'', () => {
      const settings = { codingPromptBehaviorV1: {} };
      // Simulate parsing raw input through override schema first
      const rawOverride = { sessionTitleUpdates: 'agent' as any };
      const parsedOverride = CodingPromptBehaviorOverrideV1Schema.parse(rawOverride);

      const result = resolveCodingPromptBehaviorV1WithOverride({
        settingsLike: settings,
        override: parsedOverride,
      });

      expect(result.sessionTitleUpdates).toBe('ongoing');
    });

    it('v always global (override v ignored)', () => {
      const settings = { codingPromptBehaviorV1: {} }; // global will be default with v=1
      const override = { v: 999 as any, responseOptions: 'disabled' }; // override tries to set v

      const result = resolveCodingPromptBehaviorV1WithOverride({
        settingsLike: settings,
        override,
      });

      // v should come from global (1), not override (999)
      expect(result.v).toBe(1);
      expect(result.responseOptions).toBe('disabled');
    });

    it('no override => returns global', () => {
      const settings = { codingPromptBehaviorV1: { responseOptions: 'disabled' } };

      const result = resolveCodingPromptBehaviorV1WithOverride({
        settingsLike: settings,
        override: undefined,
      });

      expect(result).toEqual({ v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'disabled' });
    });

    it('null override => returns global', () => {
      const settings = { codingPromptBehaviorV1: {} };

      const result = resolveCodingPromptBehaviorV1WithOverride({
        settingsLike: settings,
        override: null,
      });

      expect(result).toEqual(DEFAULT_CODING_PROMPT_BEHAVIOR_V1);
    });
  });

  describe('applyCodingPromptBehaviorOverrideToSettings', () => {
    it('no override => settings unchanged reference', () => {
      const settings = { foo: 'bar' };
      const result = applyCodingPromptBehaviorOverrideToSettings({
        settings,
        override: undefined,
      });

      expect(result).toBe(settings); // same reference
    });

    it('null override => settings unchanged reference', () => {
      const settings = { foo: 'bar' };
      const result = applyCodingPromptBehaviorOverrideToSettings({
        settings,
        override: null,
      });

      expect(result).toBe(settings); // same reference
    });

    it('with override => returns merged settings with codingPromptBehaviorV1', () => {
      const settings = { foo: 'bar' };
      const override = { responseOptions: 'disabled' };

      const result = applyCodingPromptBehaviorOverrideToSettings({
        settings,
        override,
      });

      expect(result).not.toBe(settings); // new reference
      expect(result).toEqual({
        foo: 'bar',
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'ongoing',
          responseOptions: 'disabled',
        },
      });
    });

    it('with empty override => returns new settings with resolved behavior', () => {
      const settings = { foo: 'bar' };
      const override = {}; // empty but present

      const result = applyCodingPromptBehaviorOverrideToSettings({
        settings,
        override,
      });

      expect(result).not.toBe(settings);
      expect(result.codingPromptBehaviorV1).toEqual(DEFAULT_CODING_PROMPT_BEHAVIOR_V1);
    });

    it('settings is null => returns empty object with resolved behavior', () => {
      const override = { responseOptions: 'disabled' };

      const result = applyCodingPromptBehaviorOverrideToSettings({
        settings: null,
        override,
      });

      expect(result).toEqual({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'ongoing',
          responseOptions: 'disabled',
        },
      });
    });

    it('settings is undefined => returns empty object with resolved behavior', () => {
      const override = { responseOptions: 'disabled' };

      const result = applyCodingPromptBehaviorOverrideToSettings({
        settings: undefined,
        override,
      });

      expect(result).toEqual({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'ongoing',
          responseOptions: 'disabled',
        },
      });
    });
  });

  describe('CodingPromptBehaviorOverrideV1Schema', () => {
    it('parses valid override with both fields', () => {
      const input = { v: 1, sessionTitleUpdates: 'ongoing', responseOptions: 'disabled' };
      const result = CodingPromptBehaviorOverrideV1Schema.parse(input);
      expect(result).toEqual(input);
    });

    it('parses valid override with partial fields', () => {
      const input = { responseOptions: 'disabled' };
      const result = CodingPromptBehaviorOverrideV1Schema.parse(input);
      expect(result).toEqual({ v: 1, responseOptions: 'disabled' });
    });

    it('malformed override becomes minimal object with v=1 via .catch({ v: 1 })', () => {
      const input = { sessionTitleUpdates: 'bogus' as any };
      const result = CodingPromptBehaviorOverrideV1Schema.parse(input);
      expect(result).toEqual({ v: 1 });
    });

    it('accepts agent alias and folds to ongoing', () => {
      const input = { sessionTitleUpdates: 'agent' as any };
      const result = CodingPromptBehaviorOverrideV1Schema.parse(input);
      expect(result.sessionTitleUpdates).toBe('ongoing');
    });
  });
});
