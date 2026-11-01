import { describe, expect, it } from 'vitest';

import type { SessionConfigOption } from '@/agent/acp/AcpBackend';

import {
  resolveCursorSessionConfigOptionUpdate,
  resolveCursorSessionModelConfigUpdate,
} from './cursorModelConfig';

function modelOption(options: SessionConfigOption['options']): SessionConfigOption {
  return {
    id: 'model',
    name: 'Model',
    type: 'select',
    currentValue: 'default',
    options,
  };
}

describe('resolveCursorSessionModelConfigUpdate', () => {
  it.each(['false', 'true'])('applies explicit fast=%s through a separate Cursor config control', (fast) => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: `composer-2.5[fast=${fast}]`,
      configOptions: [
        modelOption([{ value: 'composer-2.5', name: 'Composer 2.5' }]),
        {
          id: 'fast', name: 'Fast', type: 'select', currentValue: 'true',
          options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }],
        },
      ],
    })).toEqual({
      modelId: 'composer-2.5',
      configUpdates: [{ configId: 'fast', value: fast }],
    });
  });

  it('maps Cursor auto aliases to the ACP default model choice', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'auto',
      configOptions: [
        modelOption([
          { value: 'default[]', name: 'Auto' },
          { value: 'composer-2.5[fast=true]', name: 'Composer 2.5 Fast' },
        ]),
      ],
    })).toEqual({
      modelId: 'default[]',
    });
  });

  it('maps Cursor fast model aliases to an exact ACP model config choice when available', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'composer-2-fast',
      configOptions: [
        modelOption([
          { value: 'composer-2[fast=false]', name: 'Composer 2' },
          { value: 'composer-2[fast=true]', name: 'Composer 2 Fast' },
        ]),
      ],
    })).toEqual({
      modelId: 'composer-2[fast=true]',
    });
  });

  it('keeps the ACP model choice and applies companion config options for split Cursor traits', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'gpt-5.1-codex-max-medium-fast',
      configOptions: [
        modelOption([
          {
            value: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
            name: 'GPT-5.1 Codex Max',
          },
        ]),
        {
          id: 'fast',
          name: 'Fast Mode',
          type: 'boolean',
          currentValue: 'false',
        },
      ],
    })).toEqual({
      modelId: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
      configUpdates: [{ configId: 'fast', value: true }],
    });
  });

  it('uses Cursor select-string companion values when fast mode is modeled as a select config option', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'gpt-5.1-codex-max-medium-fast',
      configOptions: [
        modelOption([
          {
            value: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
            name: 'GPT-5.1 Codex Max',
          },
        ]),
        {
          id: 'fast',
          name: 'Fast Mode',
          type: 'select',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'False' },
            { value: 'true', name: 'True' },
          ],
        },
      ],
    })).toEqual({
      modelId: 'gpt-5.1-codex-max[reasoning=medium,fast=false]',
      configUpdates: [{ configId: 'fast', value: 'true' }],
    });
  });

  it('applies Cursor context-window aliases through a companion config option', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'gpt-5.5-medium-1m',
      configOptions: [
        modelOption([
          {
            value: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
            name: 'GPT-5.5',
          },
        ]),
        {
          id: 'context',
          name: 'Context Window',
          type: 'select',
          currentValue: '272k',
          options: [
            { value: '272k', name: '272K' },
            { value: '1m', name: '1M' },
          ],
        },
      ],
    })).toEqual({
      modelId: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
      configUpdates: [{ configId: 'context', value: '1m' }],
    });
  });

  it('applies Cursor context-window aliases through context_window companion options', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'gpt-5.5-medium-1m',
      configOptions: [
        modelOption([
          {
            value: 'gpt-5.5',
            name: 'GPT-5.5',
          },
        ]),
        {
          id: 'context_window',
          name: 'Context Window',
          type: 'select',
          currentValue: '272k',
          options: [
            { value: '272k', name: '272K' },
            { value: '1m', name: '1M' },
          ],
        },
      ],
    })).toEqual({
      modelId: 'gpt-5.5',
      configUpdates: [{ configId: 'context_window', value: '1m' }],
    });
  });

  it('maps Cursor extra-high aliases to the advertised thought_level value', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'gpt-5.5-extra-high-1m',
      configOptions: [
        modelOption([
          {
            value: 'gpt-5.5',
            name: 'GPT-5.5',
          },
        ]),
        {
          id: 'context',
          name: 'Context',
          category: 'model_config',
          type: 'select',
          currentValue: '272k',
          options: [
            { value: '272k', name: '272K' },
            { value: '1m', name: '1M' },
          ],
        },
        {
          id: 'reasoning',
          name: 'Reasoning',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'extra-high', name: 'Extra High' },
          ],
        },
      ],
    })).toEqual({
      modelId: 'gpt-5.5',
      configUpdates: [
        { configId: 'context', value: '1m' },
        { configId: 'reasoning', value: 'extra-high' },
      ],
    });
  });

  it('treats Claude max aliases as max-context requests instead of reasoning=max', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'claude-4.6-opus-max-thinking-fast',
      configOptions: [
        modelOption([
          {
            value: 'claude-opus-4-6[context=200k,effort=high,thinking=true,fast=false]',
            name: 'Claude Opus 4.6',
          },
        ]),
        {
          id: 'context',
          name: 'Context Window',
          type: 'select',
          currentValue: '200k',
          options: [
            { value: '200k', name: '200K' },
            { value: '1m', name: '1M' },
          ],
        },
        {
          id: 'fast',
          name: 'Fast Mode',
          type: 'boolean',
          currentValue: false,
        },
      ],
    })).toEqual({
      modelId: 'claude-opus-4-6[context=200k,effort=high,thinking=true,fast=false]',
      configUpdates: [
        { configId: 'context', value: '1m' },
        { configId: 'fast', value: true },
      ],
    });
  });

  it('does not send unknown freeform model ids when Cursor returned authoritative ACP choices', () => {
    expect(resolveCursorSessionModelConfigUpdate({
      modelId: 'not-a-cursor-acp-choice',
      configOptions: [
        modelOption([
          { value: 'default', name: 'Auto' },
          { value: 'composer-2.5', name: 'Composer 2.5' },
        ]),
      ],
    })).toBeNull();
  });
});

describe('resolveCursorSessionConfigOptionUpdate', () => {
  it('maps virtual Cursor model option changes to exact ACP model values', () => {
    expect(resolveCursorSessionConfigOptionUpdate({
      configId: 'reasoning_effort',
      value: 'high',
      configOptions: [
        {
          ...modelOption([
            { value: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'GPT-5.5' },
            { value: 'gpt-5.5[context=272k,reasoning=high,fast=false]', name: 'GPT-5.5' },
            { value: 'gpt-5.5[context=1m,reasoning=high,fast=true]', name: 'GPT-5.5' },
          ]),
          currentValue: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
        },
      ],
    })).toEqual({
      modelId: 'gpt-5.5[context=272k,reasoning=high,fast=false]',
    });
  });

  it('keeps real ACP config options as direct config updates', () => {
    expect(resolveCursorSessionConfigOptionUpdate({
      configId: 'fast',
      value: 'true',
      configOptions: [
        modelOption([{ value: 'composer-2.5[fast=true]', name: 'Composer 2.5' }]),
        {
          id: 'fast',
          name: 'Fast Mode',
          category: 'model_config',
          type: 'select',
          currentValue: 'false',
          options: [
            { value: 'false', name: 'False' },
            { value: 'true', name: 'True' },
          ],
        },
      ],
    })).toEqual({
      configId: 'fast',
      value: 'true',
    });
  });

  it('does not send virtual model option ids when Cursor has no exact ACP model choice', () => {
    expect(resolveCursorSessionConfigOptionUpdate({
      configId: 'reasoning_effort',
      value: 'high',
      configOptions: [
        {
          ...modelOption([
            { value: 'gpt-5.5[context=272k,reasoning=medium,fast=false]', name: 'GPT-5.5' },
            { value: 'gpt-5.5[context=1m,reasoning=high,fast=true]', name: 'GPT-5.5' },
          ]),
          currentValue: 'gpt-5.5[context=272k,reasoning=medium,fast=false]',
        },
      ],
    })).toBeNull();
  });

  it('coerces direct boolean config option updates before sending them to Cursor ACP', () => {
    expect(resolveCursorSessionConfigOptionUpdate({
      configId: 'fast',
      value: 'true',
      configOptions: [
        modelOption([{ value: 'composer-2.5[fast=true]', name: 'Composer 2.5' }]),
        {
          id: 'fast',
          name: 'Fast',
          category: 'model_config',
          type: 'boolean',
          currentValue: false,
        },
      ],
    })).toEqual({
      configId: 'fast',
      value: true,
    });
  });

  it('maps Happier reasoning effort controls to Cursor thought_level config ids', () => {
    expect(resolveCursorSessionConfigOptionUpdate({
      configId: 'reasoning_effort',
      value: 'extra-high',
      configOptions: [
        modelOption([{ value: 'gpt-5.5', name: 'GPT-5.5' }]),
        {
          id: 'reasoning',
          name: 'Reasoning',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'medium', name: 'Medium' },
            { value: 'extra-high', name: 'Extra High' },
          ],
        },
      ],
    })).toEqual({
      configId: 'reasoning',
      value: 'extra-high',
    });
  });
});
